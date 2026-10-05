import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { prisma } from './db';
import { demoLoginEnabled } from './config';
import { ApiError, badRequest, conflict, forbidden, handleError, notFound, unauthorized } from './errors';
import { buildCorsOptions, corsErrorHandler, securityHeaders } from './security';
import {
  clearAttempts,
  isThrottled,
  pruneThrottles,
  recordFailedAttempt,
  throttleKey as throttleKeyFor
} from './throttle';
import { ItemStatus, ListingType, PropertyCategory, Role, TitleDocumentType, VerificationStatus } from '@prisma/client';
import {
  AuthenticatedRequest,
  absentUserTimingGuard,
  createSessionToken,
  hashPassword,
  landingPageFor,
  pruneRevokedSessions,
  requireAuth,
  requireRole,
  revokeSession,
  validatePasswordStrength,
  verifyPassword,
  verifySessionToken
} from './auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ordered deliberately: security headers go on before CORS so even a rejected
// preflight carries them, and both run before express.static so the HTML pages
// are covered too — not just the API.
app.use(securityHeaders);
app.use(cors(buildCorsOptions()));
app.use(corsErrorHandler);
app.use(express.json());

// Serve static frontend files (HTML, CSS, JS, Assets)
app.use(express.static(path.join(__dirname, '..')));

/* ============================================================
   0. AUTHENTICATION
   ============================================================ */

// Failed-login throttling. Counters live in Postgres rather than an in-process
// Map — see server/throttle.ts for why that distinction mattered.
function throttleKey(req: Request): string {
  return throttleKeyFor(req.ip || req.socket.remoteAddress);
}

/**
 * Every caller must await isThrottled() INSIDE its try block.
 *
 * The throttle reads Postgres, so it throws PrismaClientInitializationError when
 * the database is unreachable. An async route handler that rejects outside any try
 * falls through to Express's default error handler, which renders an HTML page
 * containing the full stack trace — absolute server paths, source lines, schema
 * internals — to whoever made the request. Inside the try, handleError() logs the
 * detail server-side and returns a generic 500 instead.
 *
 * Failing the request when the throttle cannot be consulted is deliberate. Treating
 * that as "not throttled" would quietly disable brute-force protection whenever the
 * throttle table is missing while the rest of the database still answers.
 */

// POST /api/auth/login — Exchange credentials for a signed session token
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const key = throttleKey(req);

  try {
    if (await isThrottled(key)) {
      res.status(429).json({
        success: false,
        error: 'Too many failed attempts. Please try again in 15 minutes.'
      });
      return;
    }

    const { email, password, rememberMe } = req.body || {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
      res.status(400).json({ success: false, error: 'Email and password are required.' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
      await absentUserTimingGuard();
      await recordFailedAttempt(key);
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);

    if (!passwordMatches) {
      await recordFailedAttempt(key);
      await prisma.auditLog.create({
        data: {
          adminId: user.id,
          action: 'LOGIN_FAILED',
          targetEntity: 'User',
          targetId: user.id,
          targetName: user.fullName,
          details: 'Failed sign-in attempt with an incorrect password.',
          ipAddress: key
        }
      });
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    if (!user.isActive || user.deletedAt) {
      res.status(403).json({
        success: false,
        error: 'This account has been deactivated. Contact East Gate support.'
      });
      return;
    }

    await clearAttempts(key);

    const session = createSessionToken(
      {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role
      },
      Boolean(rememberMe)
    );

    await prisma.auditLog.create({
      data: {
        adminId: user.id,
        action: 'LOGIN_SUCCESS',
        targetEntity: 'User',
        targetId: user.id,
        targetName: user.fullName,
        details: `Signed in to the ${user.role.replace('_', ' ').toLowerCase()} portal.`,
        ipAddress: key
      }
    });

    res.json({
      success: true,
      message: 'Access granted.',
      token: session.token,
      expiresAt: session.expiresAt,
      redirectTo: landingPageFor(user.role),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        role: user.role,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/auth/login");
  }
});

// GET /api/auth/me — Validate the stored session and return the live account
app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        dealerProfile: { select: { businessName: true, status: true } }
      }
    });

    if (!user || !user.isActive) {
      res.status(401).json({ success: false, error: 'Session is no longer valid.' });
      return;
    }

    res.json({
      success: true,
      data: {
        ...user,
        redirectTo: landingPageFor(user.role)
      }
    });
  } catch (error: any) {
    handleError(res, error, "GET /api/auth/me");
  }
});

// POST /api/auth/logout — Withdraws the presented token, then records the event
app.post('/api/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;

    // Record the withdrawal BEFORE the audit write. If the audit insert fails
    // we still must not leave a live token behind — a 500 here would tell the
    // client the sign-out failed while the token stayed usable.
    await revokeSession(session);

    await prisma.auditLog.create({
      data: {
        adminId: session.sub,
        action: 'LOGOUT',
        targetEntity: 'User',
        targetId: session.sub,
        targetName: session.name,
        details: 'Signed out of the portal.',
        ipAddress: throttleKey(req)
      }
    });

    res.json({ success: true, message: 'Signed out.' });
  } catch (error: any) {
    handleError(res, error, "POST /api/auth/logout");
  }
});

// POST /api/auth/validate — Token check for the frontend route guard
app.post('/api/auth/validate', (req: Request, res: Response) => {  const token = typeof req.body?.token === 'string' ? req.body.token : null;
  const session = token ? verifySessionToken(token) : null;

  if (!session) {
    res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    return;
  }

  res.json({
    success: true,
    data: {
      id: session.sub,
      email: session.email,
      name: session.name,
      role: session.role,
      expiresAt: new Date(session.exp * 1000).toISOString(),
      redirectTo: landingPageFor(session.role)
    }
  });
});

// GET /api/auth/demo-accounts — Credentials for the one-click demo panel.
//
// These used to sit in login.html as data-password attributes, which meant every
// deployment served three working logins to any visitor, and they are documented
// in README.md so they are identical on every install. They are now only ever
// emitted from here, and only when demoLoginEnabled() is true — off by default
// in production.
app.get('/api/auth/demo-accounts', (_req: Request, res: Response) => {
  if (!demoLoginEnabled()) {
    res.json({ success: true, data: { enabled: false, accounts: [] } });
    return;
  }

  res.json({
    success: true,
    data: {
      enabled: true,
      accounts: [
        { role: 'Customer', email: 'jay@example.com', password: 'EastGate@Jay2026' },
        { role: 'Dealer', email: 'dealer@johnproperties.ng', password: 'EastGate@John2026' },
        { role: 'Dealer · review', email: 'apex@apexbuilders.ng', password: 'EastGate@Apex2026' }
      ]
    }
  });
});

/* ============================================================
   1. PUBLIC ENDPOINTS (Strictly APPROVED items only)
   ============================================================ */

// GET /api/listing-types — the "purpose" vocabulary.
//
// The Prisma enum holds the authoritative VALUES; this map supplies only the
// human-readable text. Declared as Record<ListingType, string> so that adding a
// member to the enum without a label here is a compile error rather than a
// silent "undefined" in the UI.
const LISTING_TYPE_LABELS: Record<ListingType, string> = {
  [ListingType.BUY]: 'Buy (Outright Purchase)',
  [ListingType.SHORT_LET]: 'Rent (Short Let)',
  [ListingType.LONG_LET]: 'Rent (Long Let)',
  [ListingType.LONG_LEASE]: 'Long Lease',
  [ListingType.COMMERCIAL_LEASE]: 'Commercial Lease',
  [ListingType.INDUSTRIAL_LEASE]: 'Industrial Lease',
  [ListingType.LAND_BANKING]: 'Land Banking & Investment',
  [ListingType.DISTRESS_SALE]: 'Sale (Distress / Auction)',
  [ListingType.JOINT_VENTURE]: 'Joint Venture / Development',
  [ListingType.STAFF_QUARTERS]: 'Student / Staff Quarters'
};

// Parses a value from a query string or JSON body into a Prisma enum member,
// or null when it is not one. Tolerates case and treats spaces/hyphens as
// underscores, so 'short-let' and 'SHORT_LET' both resolve.
//
// This guard is not optional: an unvalidated value is passed straight through to
// Postgres, which raises on an unknown enum label and surfaces as a 500 that
// looks like a server fault rather than bad input.
function parseEnumValue<T extends Record<string, string>>(value: unknown, allowed: T): T[keyof T] | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  return allowed[key as keyof T] ?? null;
}

// POST /api/contact — Public contact-form submissions from contact.html.
//
// Unauthenticated by design: a visitor who cannot sign up must still be able to
// reach the business. That makes this an unauthenticated write endpoint, so it is
// treated as one — length caps on every field (no unbounded payload storage) and
// the same IP-keyed throttle used for registration, since an open form is
// otherwise a free spam relay into the admin inbox.
app.post('/api/contact', async (req: Request, res: Response) => {
  const key = `contact-form:${throttleKey(req)}`;

  // The throttle check stays inside the try — see the note above throttleKey().
  try {
    if (await isThrottled(key)) {
      res.status(429).json({
        success: false,
        error: 'Too many messages sent. Please try again in 15 minutes.'
      });
      return;
    }

    const { name, email, phone, subject, message, website } = req.body || {};

    // Honeypot: a field hidden from humans but attractive to naive bots. Respond
    // with the same success the real path returns so the bot learns nothing, but
    // store nothing.
    if (typeof website === 'string' && website.trim() !== '') {
      res.status(201).json({ success: true, message: 'Message received. We will be in touch shortly.' });
      return;
    }

    const clean = {
      name: typeof name === 'string' ? name.trim() : '',
      email: typeof email === 'string' ? email.trim().toLowerCase() : '',
      phone: typeof phone === 'string' ? phone.trim() : '',
      subject: typeof subject === 'string' ? subject.trim() : '',
      message: typeof message === 'string' ? message.trim() : ''
    };

    const errors: string[] = [];
    if (clean.name.length < 2) errors.push('Full name is required.');
    if (clean.name.length > 120) errors.push('Name is too long.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors.push('A valid email address is required.');
    if (clean.email.length > 200) errors.push('Email address is too long.');
    if (clean.phone && !/^\+?[\d\s()-]{7,20}$/.test(clean.phone)) errors.push('Please enter a valid phone number.');
    if (!clean.subject) errors.push('Please choose a subject.');
    if (clean.subject.length > 120) errors.push('Subject is too long.');
    if (clean.message.length < 10) errors.push('Please tell us a little more about what you need.');
    if (clean.message.length > 4000) errors.push('Message is too long (4000 characters max).');

    if (errors.length) {
      // Count these as attempts: a client sending garbage is the same source as
      // one hammering the endpoint, and neither should be free.
      await recordFailedAttempt(key);
      res.status(400).json({ success: false, error: errors[0], errors });
      return;
    }

    const saved = await prisma.contactMessage.create({
      data: {
        name: clean.name,
        email: clean.email,
        phone: clean.phone || null,
        subject: clean.subject,
        message: clean.message
      }
    });

    await clearAttempts(key);

    res.status(201).json({
      success: true,
      message: 'Message received. We will be in touch shortly.',
      data: { id: saved.id, createdAt: saved.createdAt }
    });
  } catch (error: any) {
    handleError(res, error, 'POST /api/contact');
  }
});

// GET /api/listing-types — lets the frontend build the purpose dropdown from
// the server instead of hardcoding a list that can drift from the enum.
app.get('/api/listing-types', (_req: Request, res: Response) => {
  const data = Object.values(ListingType).map(function (value) {
    return { value: value, label: LISTING_TYPE_LABELS[value] };
  });

  res.json({ success: true, count: data.length, data });
});

// GET /api/properties — Only returns APPROVED properties
app.get('/api/properties', async (req: Request, res: Response) => {
  try {
    const { category, state, listingType } = req.query;

    const whereClause: any = {
      status: ItemStatus.APPROVED, // MANDATORY: Pending items hidden from public
      deletedAt: null
    };

    if (category && category !== 'ALL') {
      const parsedCategory = parseEnumValue(category, PropertyCategory);
      if (!parsedCategory) {
        res.status(400).json({ success: false, error: `Unknown property category: ${String(category)}` });
        return;
      }
      whereClause.category = parsedCategory;
    }
    if (state && state !== 'ALL') {
      whereClause.state = String(state);
    }
    if (listingType && listingType !== 'ALL') {
      const parsedListingType = parseEnumValue(listingType, ListingType);
      if (!parsedListingType) {
        res.status(400).json({ success: false, error: `Unknown listing purpose: ${String(listingType)}` });
        return;
      }
      whereClause.listingType = parsedListingType;
    }

    const properties = await prisma.property.findMany({
      where: whereClause,
      include: {
        dealer: {
          select: {
            businessName: true,
            status: true,
            ratingAverage: true,
            badgeCac: true,
            badgeTitleDocs: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: properties.length, data: properties });
  } catch (error: any) {
    handleError(res, error, "GET /api/properties");
  }
});

// GET /api/properties/:id
app.get('/api/properties/:id', async (req: Request, res: Response) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: String(req.params.id) },
      include: { dealer: true }
    });

    if (!property) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }

    res.json({ success: true, data: property });
  } catch (error: any) {
    handleError(res, error, "GET /api/properties/:id");
  }
});

// GET /api/marketplace — Only returns APPROVED products
app.get('/api/marketplace', async (req: Request, res: Response) => {
  try {
    const { category } = req.query;
    const whereClause: any = {
      status: ItemStatus.APPROVED // MANDATORY: Vendor pending products hidden
    };

    if (category && category !== 'ALL') {
      whereClause.category = category as string;
    }

    const products = await prisma.marketplaceProduct.findMany({
      where: whereClause,
      include: {
        dealer: {
          select: { businessName: true, status: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: products.length, data: products });
  } catch (error: any) {
    handleError(res, error, "GET /api/marketplace");
  }
});

// GET /api/services — Only returns APPROVED services
app.get('/api/services', async (req: Request, res: Response) => {
  try {
    const { category } = req.query;
    const whereClause: any = {
      status: ItemStatus.APPROVED
    };

    if (category && category !== 'ALL') {
      whereClause.category = category as string;
    }

    const services = await prisma.serviceOffering.findMany({
      where: whereClause,
      include: {
        dealer: {
          select: { businessName: true, status: true, ratingAverage: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: services.length, data: services });
  } catch (error: any) {
    handleError(res, error, "GET /api/services");
  }
});

// GET /api/dealers — Directory of verified dealers & professionals.
// Only VERIFIED profiles are public: an account created through the public
// /api/dealer/register form is UNDER_REVIEW and must not appear here.
app.get('/api/dealers', async (_req: Request, res: Response) => {
  try {
    const dealers = await prisma.dealerProfile.findMany({
      where: { status: VerificationStatus.VERIFIED },
      include: {
        user: { select: { email: true, phone: true } },
        _count: { select: { listings: true } }
      },
      orderBy: { ratingAverage: 'desc' }
    });

    res.json({ success: true, count: dealers.length, data: dealers });
  } catch (error: any) {
    handleError(res, error, "GET /api/dealers");
  }
});

/* ============================================================
   2. CUSTOMER & INSPECTION ENDPOINTS
   ============================================================ */

// POST /api/inspections — Book an inspection
app.post('/api/inspections', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { propertyId, dealerId, date, timeSlot, clientNotes } = req.body;
    const session = req.session!;

    if (!propertyId || !dealerId || !date || !timeSlot) {
      throw badRequest('Missing required fields to book an inspection.');
    }

    const inspection = await prisma.inspection.create({
      data: {
        userId: session.sub,
        propertyId,
        dealerId,
        date: new Date(date),
        timeSlot,
        clientNotes
      },
      include: {
        property: { select: { title: true, location: true } },
        dealer: { select: { businessName: true } }
      }
    });

    res.json({ success: true, message: 'Inspection booked successfully', data: inspection });
  } catch (error: any) {
    handleError(res, error, 'POST /api/inspections');
  }
});

// GET /api/user/inspections
app.get('/api/user/inspections/:userId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const requestedUserId = String(req.params.userId);
    const isAdmin = session.role === 'ADMIN' || session.role === 'SUPER_ADMIN';

    if (!isAdmin && requestedUserId !== session.sub) {
      res.status(403).json({ success: false, error: 'You can only view your own inspections.' });
      return;
    }

    const inspections = await prisma.inspection.findMany({
      where: { userId: requestedUserId },
      include: {
        property: { select: { title: true, location: true, price: true } },
        dealer: { select: { businessName: true } }
      },
      orderBy: { date: 'asc' }
    });

    res.json({ success: true, data: inspections });
  } catch (error: any) {
    handleError(res, error, "GET /api/user/inspections/:userId");
  }
});

/* ============================================================
   3. DEALER PORTAL SUBMISSIONS (Mandatory PENDING_REVIEW)
   ============================================================ */

/**
 * Resolves the DealerProfile behind the session token so submissions can never
 * be attributed to another dealer by posting a different id.
 */
async function loadDealerProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = req.session!;

    // Admins may act on behalf of a dealer by passing ?dealerId=
    const requested = typeof req.query.dealerId === 'string' ? req.query.dealerId : null;
    const isAdmin = session.role === 'ADMIN' || session.role === 'SUPER_ADMIN';

    const dealer = await prisma.dealerProfile.findFirst({
      where: isAdmin && requested ? { id: requested } : { userId: session.sub }
    });

    if (!dealer) {
      res.status(403).json({
        success: false,
        error: 'No dealer profile is linked to this account.'
      });
      return;
    }

    (req as any).dealer = dealer;
    next();
  } catch (error: any) {
    handleError(res, error, 'loadDealerProfile middleware');
  }
}

// POST /api/dealer/properties — Dealer submits property (PENDING_REVIEW)
app.post('/api/dealer/properties', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const dealerId = (req as any).dealer.id;
    const {
      title,
      listingType,
      category,
      price,
      state,
      location,
      bedrooms,
      bathrooms,
      parkingSpaces,
      landSize,
      titleDocument,
      description,
      features,
      mainImage
    } = req.body || {};

    const clean = {
      title: typeof title === 'string' ? title.trim() : '',
      price: Number(price),
      state: typeof state === 'string' ? state.trim() : '',
      location: typeof location === 'string' ? location.trim() : ''
    };

    const errors: string[] = [];
    if (clean.title.length < 3) errors.push('A property title of at least 3 characters is required.');
    if (!Number.isFinite(clean.price) || clean.price <= 0) errors.push('A price greater than zero is required.');
    if (clean.state.length < 2) errors.push('A state is required.');
    if (clean.location.length < 2) errors.push('A location is required.');

    // Purpose and category must resolve to real enum members. Passing a bad
    // value straight to Postgres would fail the whole insert with a 500 and
    // the dealer would think their listing was lost.
    let listingPurpose: ListingType = ListingType.BUY;
    if (listingType) {
      const parsed = parseEnumValue(listingType, ListingType);
      if (parsed) listingPurpose = parsed;
      else errors.push(`"${String(listingType)}" is not a valid listing purpose.`);
    }

    let propertyCategory: PropertyCategory = PropertyCategory.RESIDENTIAL;
    if (category) {
      const parsed = parseEnumValue(category, PropertyCategory);
      if (parsed) propertyCategory = parsed;
      else errors.push(`"${String(category)}" is not a valid property category.`);
    }

    if (errors.length) {
      res.status(400).json({ success: false, error: errors[0], errors });
      return;
    }

    const slug = clean.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString().slice(-4);

    const property = await prisma.property.create({
      data: {
        dealerId,
        title: clean.title,
        slug,
        listingType: listingPurpose,
        category: propertyCategory,
        price: clean.price,
        state: clean.state,
        location: clean.location,
        bedrooms: Number(bedrooms || 0),
        bathrooms: Number(bathrooms || 0),
        parkingSpaces: Number(parkingSpaces || 0),
        landSize,
        titleDocument: titleDocument || TitleDocumentType.C_OF_O,
        description: description || 'Property submitted by dealer.',
        features: features || [],
        mainImage: mainImage || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        status: ItemStatus.PENDING_REVIEW // MANDATORY: Awaiting Admin Approval
      }
    });

    res.json({
      success: true,
      message: 'Listing submitted! Status: PENDING_REVIEW by East Gate Admin before public view.',
      data: property
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/dealer/properties");
  }
});

// POST /api/dealer/products — Dealer submits product (PENDING_REVIEW)
app.post('/api/dealer/products', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const dealerId = (req as any).dealer.id;
    const { name, category, price, stockInfo, specifications, mainImage } = req.body;

    const product = await prisma.marketplaceProduct.create({
      data: {
        dealerId,
        name,
        category: category || 'Building Materials',
        price,
        stockInfo: stockInfo || 'In Stock',
        specifications: specifications || 'Vendor product specification.',
        mainImage: mainImage || 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
        isOfficial: false,
        status: ItemStatus.PENDING_REVIEW // MANDATORY: Awaiting Admin Approval
      }
    });

    res.json({
      success: true,
      message: 'Product submitted! Status: PENDING_REVIEW by East Gate Admin.',
      data: product
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/dealer/products");
  }
});

/* ============================================================
   3b. DEALER SERVICES & PUBLIC REGISTRATION
   ============================================================ */

// POST /api/dealer/services — Dealer submits a service offering (PENDING_REVIEW)
app.post('/api/dealer/services', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const dealerId = (req as any).dealer.id;
    const { title, category, description, badges } = req.body || {};
    // The dealer form sends `state` (matching Property.location); other callers
    // use the column name `coverageState`. Accept either so coverage is never
    // silently dropped to "Nationwide".
    const coverageState = req.body?.coverageState || req.body?.state || 'Nationwide';

    if (!title || !description) {
      res.status(400).json({ success: false, error: 'Service title and description are required.' });
      return;
    }

    const service = await prisma.serviceOffering.create({
      data: {
        dealerId,
        title,
        category: category || 'Construction',
        coverageState,
        description,
        badges: Array.isArray(badges) ? badges : [],
        status: ItemStatus.PENDING_REVIEW // MANDATORY: Awaiting Admin Approval
      }
    });

    res.status(201).json({
      success: true,
      message: 'Service submitted! Status: PENDING_REVIEW by East Gate Admin.',
      data: service
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/dealer/services");
  }
});

// GET /api/dealer/services/list — The signed-in dealer's own submissions
app.get('/api/dealer/services/list', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const services = await prisma.serviceOffering.findMany({
      where: { dealerId: (req as any).dealer.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: services.length, data: services });
  } catch (error: any) {
    handleError(res, error, "GET /api/dealer/services/list");
  }
});

// POST /api/auth/register — Public sign-up for a regular East Gate member.
// Creates an active CUSTOMER account. Unlike a dealer, a member is usable
// immediately, so there is no review gate.
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const key = `register-member:${throttleKey(req)}`;

  try {
    if (await isThrottled(key)) {
      res.status(429).json({
        success: false,
        error: 'Too many registration attempts. Please try again in 15 minutes.'
      });
      return;
    }

    const { fullName, email, phone, password } = req.body || {};

    const clean = {
      fullName: typeof fullName === 'string' ? fullName.trim() : '',
      email: typeof email === 'string' ? email.trim().toLowerCase() : '',
      phone: typeof phone === 'string' ? phone.trim() : '',
      password: typeof password === 'string' ? password : ''
    };

    const errors: string[] = [];
    if (clean.fullName.length < 2) errors.push('Full name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors.push('A valid email address is required.');
    if (!/^\+?[\d\s()-]{7,20}$/.test(clean.phone)) errors.push('A valid phone number is required.');
    errors.push(...validatePasswordStrength(clean.password, clean.email));

    if (errors.length) {
      res.status(400).json({ success: false, error: errors[0], errors });
      return;
    }

    const clash = await prisma.user.findFirst({
      where: { OR: [{ email: clean.email }, { phone: clean.phone }] },
      select: { email: true, phone: true }
    });

    if (clash) {
      await recordFailedAttempt(key);
      const field = clash.email === clean.email ? 'email address' : 'phone number';
      res.status(409).json({ success: false, error: `That ${field} is already registered.` });
      return;
    }

    const passwordHash = await hashPassword(clean.password);

    const user = await prisma.user.create({
      data: {
        email: clean.email,
        phone: clean.phone,
        fullName: clean.fullName,
        passwordHash,
        role: Role.CUSTOMER,
        isActive: true
      }
    });

    await clearAttempts(key);

    await prisma.auditLog.create({
      data: {
        adminId: user.id,
        action: 'MEMBER_REGISTERED',
        targetEntity: 'User',
        targetId: user.id,
        targetName: clean.fullName,
        details: `Member account self-registered for ${clean.email}.`,
        ipAddress: throttleKey(req)
      }
    });

    res.status(201).json({
      success: true,
      message: 'Account created. Welcome to East Gate.',
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role
      }
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/auth/register");
  }
});

// POST /api/dealer/register — Public dealer sign-up. Creates an UNDER_REVIEW
// dealer account; nothing is publicly visible until an admin approves it.
app.post('/api/dealer/register', async (req: Request, res: Response) => {
  const key = `register:${throttleKey(req)}`;

  try {
    if (await isThrottled(key)) {
      res.status(429).json({
        success: false,
        error: 'Too many registration attempts. Please try again in 15 minutes.'
      });
      return;
    }

    const {
      businessName,
      fullName,
      email,
      phone,
      password,
      cacNumber,
      category,
      state,
      city,
      officeAddress,
      bio
    } = req.body || {};

    const clean = {
      businessName: typeof businessName === 'string' ? businessName.trim() : '',
      fullName: typeof fullName === 'string' ? fullName.trim() : '',
      email: typeof email === 'string' ? email.trim().toLowerCase() : '',
      phone: typeof phone === 'string' ? phone.trim() : '',
      password: typeof password === 'string' ? password : '',
      cacNumber: typeof cacNumber === 'string' && cacNumber.trim() ? cacNumber.trim() : null,
      category: typeof category === 'string' && category.trim() ? category.trim() : 'Real Estate Agency & Brokerage',
      state: typeof state === 'string' && state.trim() ? state.trim() : '',
      city: typeof city === 'string' && city.trim() ? city.trim() : '',
      officeAddress: typeof officeAddress === 'string' ? officeAddress.trim() : null,
      bio: typeof bio === 'string' && bio.trim() ? bio.trim() : null
    };

    const errors: string[] = [];
    if (!clean.businessName) errors.push('Business name is required.');
    if (!clean.fullName) errors.push('Contact full name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors.push('A valid email address is required.');
    if (!/^\+?[\d\s()-]{7,20}$/.test(clean.phone)) errors.push('A valid phone number is required.');
    errors.push(...validatePasswordStrength(clean.password, clean.email));
    if (!clean.state) errors.push('State is required.');
    if (!clean.city) errors.push('City is required.');

    if (errors.length) {
      res.status(400).json({ success: false, error: errors[0], errors });
      return;
    }

    const clash = await prisma.user.findFirst({
      where: { OR: [{ email: clean.email }, { phone: clean.phone }] },
      select: { email: true, phone: true }
    });

    if (clash) {
      await recordFailedAttempt(key);
      const field = clash.email === clean.email ? 'email address' : 'phone number';
      res.status(409).json({ success: false, error: `That ${field} is already registered.` });
      return;
    }

    if (clean.cacNumber) {
      const cacClash = await prisma.dealerProfile.findFirst({
        where: { cacNumber: clean.cacNumber },
        select: { id: true }
      });
      if (cacClash) {
        await recordFailedAttempt(key);
        res.status(409).json({ success: false, error: 'That CAC number is already registered.' });
        return;
      }
    }

    const passwordHash = await hashPassword(clean.password);

    const user = await prisma.user.create({
      data: {
        email: clean.email,
        phone: clean.phone,
        fullName: clean.fullName,
        passwordHash,
        role: Role.DEALER,
        isActive: true
      }
    });

    const dealerProfile = await prisma.dealerProfile.create({
      data: {
        userId: user.id,
        businessName: clean.businessName,
        cacNumber: clean.cacNumber,
        category: clean.category,
        bio: clean.bio,
        state: clean.state,
        city: clean.city,
        officeAddress: clean.officeAddress,
        status: VerificationStatus.UNDER_REVIEW,
        badgeIdentity: true,
        badgeCac: Boolean(clean.cacNumber),
        badgePhone: false,
        badgeTitleDocs: false
      }
    });

    await clearAttempts(key);

    await prisma.auditLog.create({
      data: {
        adminId: user.id,
        action: 'DEALER_REGISTERED',
        targetEntity: 'DealerProfile',
        targetId: dealerProfile.id,
        targetName: clean.businessName,
        details: `New dealer account created for ${clean.businessName} in ${clean.city}, ${clean.state}. Awaiting document review.`,
        ipAddress: throttleKey(req)
      }
    });

    res.status(201).json({
      success: true,
      message: 'Registration received. Your account is under review — you can sign in now.',
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        businessName: dealerProfile.businessName,
        status: dealerProfile.status
      }
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/dealer/register");
  }
});

/* ============================================================
   4. ADMIN CONTROL FORTRESS & DIRECT PRODUCT CREATION
   ============================================================ */

// GET /api/admin/queue — Lists all items pending approval
app.get('/api/admin/queue', requireAuth, requireRole('ADMIN'), async (_req: Request, res: Response) => {
  try {
    const pendingProperties = await prisma.property.findMany({
      where: { status: ItemStatus.PENDING_REVIEW },
      include: { dealer: { select: { businessName: true, status: true } } }
    });

    const pendingProducts = await prisma.marketplaceProduct.findMany({
      where: { status: ItemStatus.PENDING_REVIEW },
      include: { dealer: { select: { businessName: true } } }
    });

    const pendingServices = await prisma.serviceOffering.findMany({
      where: { status: ItemStatus.PENDING_REVIEW },
      include: { dealer: { select: { businessName: true } } }
    });

    const pendingVerifications = await prisma.verificationDoc.findMany({
      where: { status: VerificationStatus.UNDER_REVIEW },
      include: { dealer: { select: { businessName: true } } }
    });

    const verifiedDealerCount = await prisma.dealerProfile.count({
      where: { status: VerificationStatus.VERIFIED }
    });

    res.json({
      success: true,
      data: {
        properties: pendingProperties,
        products: pendingProducts,
        services: pendingServices,
        verifications: pendingVerifications,
        verifiedDealerCount
      }
    });
  } catch (error: any) {
    handleError(res, error, "GET /api/admin/queue");
  }
});

// POST /api/admin/products — DIRECT ADMIN PRODUCT CREATION (Auto-APPROVED & Official)
app.post('/api/admin/products', requireAuth, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const { name, category, price, stockInfo, specifications, mainImage, adminId } = req.body;

    const product = await prisma.marketplaceProduct.create({
      data: {
        name,
        category: category || 'Building Materials',
        price,
        stockInfo: stockInfo || 'Official Direct Warehousing & Haulage',
        specifications: specifications || 'Official East Gate Certified Material.',
        mainImage: mainImage || 'https://images.unsplash.com/photo-1632759145351-1d592919f522?auto=format&fit=crop&w=800&q=80',
        isOfficial: true,
        status: ItemStatus.APPROVED // IMMEDIATELY APPROVED FOR PUBLIC VIEW
      }
    });

    // Helper to resolve valid admin user ID for foreign key constraint
    const resolveAdmin = async (idOrEmail?: string) => {
      if (idOrEmail) {
        const found = await prisma.user.findFirst({
          where: { OR: [{ id: idOrEmail }, { email: idOrEmail }] }
        });
        if (found) return found.id;
      }
      const defaultAdmin = await prisma.user.findFirst({
        where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
      });
      return defaultAdmin?.id;
    };

    const validAdminId = await resolveAdmin(adminId);

    // Record in Security Audit Trail
    if (validAdminId) {
      await prisma.auditLog.create({
        data: {
          adminId: validAdminId,
          action: 'ADMIN_CREATE_PRODUCT',
          targetEntity: 'MarketplaceProduct',
          targetId: product.id,
          targetName: product.name,
          details: 'Admin published direct official East Gate inventory.'
        }
      });
    }

    res.json({
      success: true,
      message: 'Official East Gate product created and published to marketplace!',
      data: product
    });
  } catch (error: any) {
    handleError(res, error, "POST /api/admin/products");
  }
});

// POST /api/admin/approve — Admin approves property, product, or service
app.post('/api/admin/approve', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const { entityType, entityId } = req.body;
    let targetName = entityId;

    if (entityType === 'property') {
      const prop = await prisma.property.update({
        where: { id: entityId },
        data: { status: ItemStatus.APPROVED }
      });
      targetName = prop.title;
    } else if (entityType === 'product') {
      const prod = await prisma.marketplaceProduct.update({
        where: { id: entityId },
        data: { status: ItemStatus.APPROVED }
      });
      targetName = prod.name;
    } else if (entityType === 'service') {
      const srv = await prisma.serviceOffering.update({
        where: { id: entityId },
        data: { status: ItemStatus.APPROVED }
      });
      targetName = srv.title;
    }

    await prisma.auditLog.create({
      data: {
        adminId: session.sub,
        action: `APPROVE_${entityType.toUpperCase()}`,
        targetEntity: entityType,
        targetId: entityId,
        targetName,
        details: `Admin vetted and cleared submission for live public display.`
      }
    });

    res.json({ success: true, message: `${entityType} approved and published live.` });
  } catch (error: any) {
    handleError(res, error, "POST /api/admin/approve");
  }
});

// POST /api/admin/reject — Admin rejects property, product, or service
app.post('/api/admin/reject', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const { entityType, entityId, reason } = req.body;
    let targetName = entityId;

    if (entityType === 'property') {
      const prop = await prisma.property.update({
        where: { id: entityId },
        data: { status: ItemStatus.REJECTED }
      });
      targetName = prop.title;
    } else if (entityType === 'product') {
      const prod = await prisma.marketplaceProduct.update({
        where: { id: entityId },
        data: { status: ItemStatus.REJECTED }
      });
      targetName = prod.name;
    } else if (entityType === 'service') {
      const srv = await prisma.serviceOffering.update({
        where: { id: entityId },
        data: { status: ItemStatus.REJECTED }
      });
      targetName = srv.title;
    }

    await prisma.auditLog.create({
      data: {
        adminId: session.sub,
        action: `REJECT_${entityType.toUpperCase()}`,
        targetEntity: entityType,
        targetId: entityId,
        targetName,
        details: `Reason: ${reason || 'Did not meet compliance criteria'}`
      }
    });

    res.json({ success: true, message: `${entityType} rejected.` });
  } catch (error: any) {
    handleError(res, error, "POST /api/admin/reject");
  }
});

// POST /api/admin/verify-dealer — Verify CAC/Identity doc and award badge
app.post('/api/admin/verify-dealer', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const { docId } = req.body;

    const doc = await prisma.verificationDoc.update({
      where: { id: docId },
      data: { status: VerificationStatus.VERIFIED, reviewedAt: new Date() },
      include: { dealer: true }
    });

    await prisma.dealerProfile.update({
      where: { id: doc.dealerId },
      data: {
        status: VerificationStatus.VERIFIED,
        badgeCac: true,
        badgeTitleDocs: true
      }
    });

    await prisma.auditLog.create({
      data: {
        adminId: session.sub,
        action: 'VERIFY_DEALER_CREDENTIALS',
        targetEntity: 'DealerProfile',
        targetId: doc.dealerId,
        targetName: doc.dealer.businessName,
        details: `Verified ${doc.documentName} and awarded East Gate Verified status.`
      }
    });

    res.json({ success: true, message: 'Dealer credentials verified and badge awarded.' });
  } catch (error: any) {
    handleError(res, error, "POST /api/admin/verify-dealer");
  }
});

// GET /api/admin/contact-messages — Contact form inbox.
app.get('/api/admin/contact-messages', requireAuth, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    // Oldest unread first, then newest overall, so new arrivals surface at the top
    // while read history stays in the order it was handled.
    const messages = await prisma.contactMessage.findMany({
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 500
    });

    res.json({
      success: true,
      count: messages.length,
      unreadCount: messages.filter((m) => !m.readAt).length,
      data: messages
    });
  } catch (error: any) {
    handleError(res, error, 'GET /api/admin/contact-messages');
  }
});

// PATCH /api/admin/contact-messages/:id — Mark one message read (or unread).
app.patch('/api/admin/contact-messages/:id', requireAuth, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    // Express 5 types a param as string | string[], and a repeated path segment can
    // arrive as an array — coerce and validate rather than letting it reach Prisma.
    const id = String(req.params.id || '');
    if (!id) throw badRequest('A message id is required.');

    const updated = await prisma.contactMessage.update({
      where: { id },
      data: { readAt: req.body?.read === false ? null : new Date() }
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    handleError(res, error, 'PATCH /api/admin/contact-messages/:id');
  }
});

// DELETE /api/admin/contact-messages/:id — Remove a message from the inbox.
app.delete('/api/admin/contact-messages/:id', requireAuth, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!id) throw badRequest('A message id is required.');

    await prisma.contactMessage.delete({ where: { id } });
    res.json({ success: true, message: 'Message deleted.' });
  } catch (error: any) {
    handleError(res, error, 'DELETE /api/admin/contact-messages/:id');
  }
});

// GET /api/admin/audit-logs — Returns immutable audit trail
app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), async (_req: Request, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      include: { admin: { select: { fullName: true, role: true } } },
      orderBy: { timestamp: 'desc' }
    });

    res.json({ success: true, count: logs.length, data: logs });
  } catch (error: any) {
    handleError(res, error, "GET /api/admin/audit-logs");
  }
});

// GET /api/admin/reports — Moderation queue. Reports are polymorphic
// (targetType + targetId), so resolve a human-readable title for each.
app.get('/api/admin/reports', requireAuth, requireRole('ADMIN'), async (_req: Request, res: Response) => {
  try {
    const reports = await prisma.report.findMany({
      include: { reporter: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const idsFor = (type: string) =>
      reports.filter((r) => r.targetType === type).map((r) => r.targetId);

    const propIds = idsFor('PROPERTY');
    const dealerIds = idsFor('DEALER');
    const productIds = idsFor('PRODUCT');

    const [props, dealers, products] = await Promise.all([
      propIds.length
        ? prisma.property.findMany({ where: { id: { in: propIds } }, select: { id: true, title: true } })
        : [],
      dealerIds.length
        ? prisma.dealerProfile.findMany({ where: { id: { in: dealerIds } }, select: { id: true, businessName: true } })
        : [],
      productIds.length
        ? prisma.marketplaceProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
        : []
    ]);

    const titles = new Map<string, string>();
    props.forEach((p) => titles.set(p.id, p.title));
    dealers.forEach((d) => titles.set(d.id, d.businessName));
    products.forEach((p) => titles.set(p.id, p.name));

    res.json({
      success: true,
      count: reports.length,
      data: reports.map((r) => ({
        ...r,
        targetTitle: titles.get(r.targetId) || `${r.targetType} ${String(r.targetId).slice(0, 8)}`
      }))
    });
  } catch (error: any) {
    handleError(res, error, "GET /api/admin/reports");
  }
});

app.listen(PORT, () => {
  console.log(`East Gate Enterprise Server running on http://localhost:${PORT}`);
});

// Housekeeping: drop revocation rows for tokens that have expired. Hourly is far
// more often than needed — the table stays small either way — and unref'd so it
// never holds the process open on shutdown.
const REVOCATION_PRUNE_MS = 60 * 60 * 1000;
const pruneTimer = setInterval(() => {
  pruneRevokedSessions()
    .then((count) => {
      if (count > 0) console.log(`[auth] pruned ${count} expired revocation row(s)`);
    })
    .catch((error) => console.error('[auth] revocation prune failed', error));

  pruneThrottles()
    .then((count) => {
      if (count > 0) console.log(`[auth] pruned ${count} stale throttle row(s)`);
    })
    .catch((error) => console.error('[auth] throttle prune failed', error));
}, REVOCATION_PRUNE_MS);
pruneTimer.unref?.();
