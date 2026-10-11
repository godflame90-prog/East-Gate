import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
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
import { InspectionStatus, ItemStatus, ListingType, PropertyCategory, Role, TitleDocumentType, VerificationStatus } from '@prisma/client';
import {
  AuthenticatedRequest,
  absentUserTimingGuard,
  consumeAuthToken,
  createSessionToken,
  EMAIL_VERIFICATION_TTL_MINUTES,
  extractToken,
  hashPassword,
  invalidateSessions,
  issueAuthToken,
  landingPageFor,
  PASSWORD_RESET_TTL_MINUTES,
  pruneAuthTokens,
  pruneRevokedSessions,
  requireAuth,
  requireRole,
  revokeSession,
  validatePasswordStrength,
  verifyPassword,
  verifySessionToken
} from './auth';
import { devCatchEnabled, emailConfigured, inspectionBookedEmail, passwordResetEmail, sendMail, verificationEmail } from './mailer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ordered deliberately: security headers go on before CORS so even a rejected
// preflight carries them, and both run before express.static so the HTML pages
// are covered too — not just the API.
app.use(securityHeaders);
// Options are rebuilt per request so the request's own origin (localhost, a LAN
// IP, a public hostname) can be recognised as same-origin and never rejected.
app.use((req, res, next) => cors(buildCorsOptions(req))(req, res, next));
app.use(corsErrorHandler);
app.use(express.json());

/**
 * Dynamic sitemap. Registered ahead of express.static so it wins over the
 * static sitemap.xml, which is kept only as the fallback when the database is
 * unreachable. Listing pages are query-parameter URLs, so this is the only way
 * crawlers discover individual approved properties.
 */
app.get('/sitemap.xml', async (req: Request, res: Response) => {
  const base = appBaseUrl(req);
  const staticPages = [
    ['/', 'weekly', '1.0'],
    ['/properties.html', 'daily', '0.9'],
    ['/land.html', 'daily', '0.9'],
    ['/dealers.html', 'weekly', '0.8'],
    ['/services.html', 'weekly', '0.7'],
    ['/marketplace.html', 'weekly', '0.7'],
    ['/contact.html', 'monthly', '0.5'],
    ['/privacy.html', 'yearly', '0.3'],
    ['/terms.html', 'yearly', '0.3']
  ];

  // If the database is down, fall back to the hand-maintained static file so the
  // endpoint never returns an error to a crawler.
  const staticFallback = () => {
    try {
      res.type('application/xml').send(fs.readFileSync(path.join(__dirname, '..', 'sitemap.xml'), 'utf8'));
    } catch {
      res.status(404).end();
    }
  };

  try {
    const rows = await prisma.property.findMany({
      where: { status: ItemStatus.APPROVED, deletedAt: null },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000
    });

    const escapeXml = (value: string) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const urls = staticPages.map(
      ([loc, changefreq, priority]) =>
        `  <url>\n    <loc>${escapeXml(base + loc)}</loc>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
    );

    for (const row of rows) {
      urls.push(
        `  <url>\n    <loc>${escapeXml(`${base}/property-detail.html?id=${row.id}`)}</loc>\n    <lastmod>${row.updatedAt.toISOString().slice(0, 10)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
      );
    }

    res
      .type('application/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  } catch (error) {
    console.error('[sitemap] falling back to static file', error);
    staticFallback();
  }
});

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
 * Absolute base URL for links that go inside an email (verification, password
 * reset). Prefers APP_BASE_URL so deployments behind a proxy generate the right
 * host; otherwise reconstructs it from the request, which covers localhost and
 * the LAN demo.
 */
function appBaseUrl(req: Request): string {
  const configured = (process.env.APP_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * Builds and sends mail without ever failing the caller's request. A fresh
 * verification link needs to reach the user, but a broken SMTP relay must not
 * turn a successful registration into a 500 — so this resolves regardless.
 */
async function trySendMail(
  to: string,
  template: { subject: string; text: string; html: string },
  context: string
): Promise<void> {
  try {
    await sendMail({ to, subject: template.subject, text: template.text, html: template.html });
  } catch (error) {
    // sendMail already swallows its own errors; this is belt-and-braces.
    console.error(`[mail] ${context} to ${to} failed`, error);
  }
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
        role: user.role,
        sessionVersion: user.sessionVersion
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
        emailVerified: true,
        dealerProfile: {
          select: {
            businessName: true,
            category: true,
            state: true,
            city: true,
            cacNumber: true,
            status: true,
            badgeIdentity: true,
            badgeCac: true,
            badgePhone: true,
            badgeTitleDocs: true
          }
        }
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

// POST /api/auth/forgot-password — Start a password reset.
//
// The response is deliberately identical whether or not the address exists:
// confirming "no such account" here would turn this endpoint into an account
// enumeration oracle. The throttle still applies so the endpoint cannot be used
// to spray reset mail at a victim.
app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const key = `forgot:${throttleKey(req)}`;
  const genericReply = {
    success: true,
    message: 'If an account exists for that email, a password reset link is on its way.'
  };

  try {
    if (await isThrottled(key)) {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again in 15 minutes.' });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
      return;
    }

    await recordFailedAttempt(key);

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, fullName: true, isActive: true, deletedAt: true }
    });

    if (user && user.isActive && !user.deletedAt) {
      const raw = await issueAuthToken(user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MINUTES);
      const url = `${appBaseUrl(req)}/reset-password.html?token=${encodeURIComponent(raw)}`;
      await trySendMail(email, passwordResetEmail(user.fullName, url), 'password reset');
    }

    res.json(genericReply);
  } catch (error: any) {
    handleError(res, error, 'POST /api/auth/forgot-password');
  }
});

// POST /api/auth/reset-password — Complete a password reset with a mailed token.
app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!token) throw badRequest('This reset link is missing its token.');
    if (!password) throw badRequest('Please choose a new password.');

    const userId = await consumeAuthToken(token, 'PASSWORD_RESET');
    if (!userId) {
      throw badRequest('This reset link is invalid or has expired. Please request a new one.');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isActive: true, deletedAt: true, passwordHash: true }
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw badRequest('This reset link is no longer usable. Please request a new one.');
    }

    const problems = validatePasswordStrength(password, user.email);
    if (problems.length) {
      res.status(400).json({ success: false, error: problems[0], errors: problems });
      return;
    }

    if (await verifyPassword(password, user.passwordHash)) {
      throw badRequest('Your new password must be different from the old one.');
    }

    const passwordHash = await hashPassword(password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Retire every session that was authorised against the old password.
    await invalidateSessions(user.id);

    await prisma.auditLog.create({
      data: {
        adminId: user.id,
        action: 'PASSWORD_RESET',
        targetEntity: 'User',
        targetId: user.id,
        targetName: user.email,
        details: 'Password reset via emailed link.',
        ipAddress: throttleKey(req)
      }
    });

    res.json({ success: true, message: 'Your password has been updated. You can now sign in.' });
  } catch (error: any) {
    handleError(res, error, 'POST /api/auth/reset-password');
  }
});

// POST /api/auth/verify-email — Confirm an address from the mailed link.
app.post('/api/auth/verify-email', async (req: Request, res: Response) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) throw badRequest('This verification link is missing its token.');

    const userId = await consumeAuthToken(token, 'EMAIL_VERIFICATION');
    if (!userId) {
      throw badRequest('This verification link is invalid or has expired. You can request a new one from your dashboard.');
    }

    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    res.json({ success: true, message: 'Your email address is verified. Thank you.' });
  } catch (error: any) {
    handleError(res, error, 'POST /api/auth/verify-email');
  }
});

// POST /api/auth/resend-verification — Re-issue the verification email.
app.post('/api/auth/resend-verification', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const key = `resend-verify:${throttleKey(req)}`;

  try {
    if (await isThrottled(key)) {
      res.status(429).json({ success: false, error: 'Too many requests. Please try again in 15 minutes.' });
      return;
    }

    const session = req.session!;
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { id: true, email: true, fullName: true, emailVerified: true }
    });

    if (!user) throw notFound('Account not found.');
    if (user.emailVerified) {
      res.json({ success: true, message: 'This email address is already verified.' });
      return;
    }

    await recordFailedAttempt(key);

    const raw = await issueAuthToken(user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MINUTES);
    const url = `${appBaseUrl(req)}/verify-email.html?token=${encodeURIComponent(raw)}`;
    await trySendMail(user.email, verificationEmail(user.fullName, url), 'email verification');

    res.json({ success: true, message: 'A fresh verification link has been sent.' });
  } catch (error: any) {
    handleError(res, error, 'POST /api/auth/resend-verification');
  }
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

// The dealer portal's Title Document <select> has always posted the human label
// ("Certificate of Occupancy (C of O)"), never the enum member. Prisma rejects
// the unknown label, the insert throws, and handleError turns that into a 500 —
// so the listing is never created and the admin queue never sees it. Translate
// the label here so both the old markup and the enum-valued one both land.
const TITLE_DOCUMENT_ALIASES: Record<string, TitleDocumentType> = {
  CERTIFICATE_OF_OCCUPANCY: TitleDocumentType.C_OF_O,
  CERTIFICATE_OF_OCCUPANCY_C_OF_O: TitleDocumentType.C_OF_O,
  C_OF_O: TitleDocumentType.C_OF_O,
  GOVERNOR_S_CONSENT: TitleDocumentType.GOVERNORS_CONSENT,
  GOVERNORS_CONSENT: TitleDocumentType.GOVERNORS_CONSENT,
  FEDERAL_C_OF_O: TitleDocumentType.FEDERAL_C_OF_O,
  REGISTERED_SURVEY_DEED: TitleDocumentType.REGISTERED_SURVEY_DEED,
  REGISTERED_SURVEY_DEED_OF_CONVEYANCE: TitleDocumentType.REGISTERED_SURVEY_DEED,
  FCDA_ALLOCATION: TitleDocumentType.FCDA_ALLOCATION,
  GOVERNMENT_GAZETTE: TitleDocumentType.GOVERNMENT_GAZETTE,
  OTHER: TitleDocumentType.OTHER
};

// Resolves a title document either as an enum member ('C_OF_O') or as the label
// the dealer form sends, or null when neither matches.
function parseTitleDocument(value: unknown): TitleDocumentType | null {
  const direct = parseEnumValue(value, TitleDocumentType);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) return null;
  return TITLE_DOCUMENT_ALIASES[key] ?? null;
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

// POST /api/enquiries — a visitor enquires about one specific listing.
//
// Public by design (a buyer is not required to open an account first), so it
// carries the same guardrails as the contact form: per-IP throttle, a honeypot,
// hard field caps, and a propertyId that must resolve to a real, currently
// approved listing. Storing the row against the property is the point — that is
// what makes the enquiry routable and countable per listing.
app.post('/api/enquiries', async (req: Request, res: Response) => {
  const key = `listing-enquiry:${throttleKey(req)}`;

  try {
    if (await isThrottled(key)) {
      res.status(429).json({
        success: false,
        error: 'Too many enquiries sent. Please try again in 15 minutes.'
      });
      return;
    }

    const { propertyId, name, email, phone, message, website } = req.body || {};

    if (typeof website === 'string' && website.trim() !== '') {
      res.status(201).json({ success: true, message: 'Enquiry received. We will be in touch shortly.' });
      return;
    }

    const clean = {
      propertyId: typeof propertyId === 'string' ? propertyId.trim() : '',
      name: typeof name === 'string' ? name.trim() : '',
      email: typeof email === 'string' ? email.trim().toLowerCase() : '',
      phone: typeof phone === 'string' ? phone.trim() : '',
      message: typeof message === 'string' ? message.trim() : ''
    };

    const errors: string[] = [];
    if (!clean.propertyId) errors.push('A property is required.');
    if (clean.name.length < 2) errors.push('Your name is required.');
    if (clean.name.length > 120) errors.push('Name is too long.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) errors.push('A valid email address is required.');
    if (clean.email.length > 200) errors.push('Email address is too long.');
    if (clean.phone && !/^\+?[\d\s()-]{7,20}$/.test(clean.phone)) errors.push('Please enter a valid phone number.');
    if (clean.message.length < 10) errors.push('Please add a short message.');
    if (clean.message.length > 4000) errors.push('Message is too long (4000 characters max).');

    if (errors.length) {
      await recordFailedAttempt(key);
      res.status(400).json({ success: false, error: errors[0], errors });
      return;
    }

    const property = await prisma.property.findFirst({
      where: { id: clean.propertyId, status: ItemStatus.APPROVED, deletedAt: null },
      select: { id: true, dealerId: true, title: true, dealer: { select: { user: { select: { email: true } } } } }
    });

    if (!property) {
      throw notFound('That property is no longer available for enquiry.');
    }

    // Record the enquiry against the listing's own dealer, never a client-supplied
    // id, and attach the sender's account only when one is actually signed in.
    const token = extractToken(req);
    const session = token ? verifySessionToken(token) : null;

    const saved = await prisma.listingEnquiry.create({
      data: {
        propertyId: property.id,
        dealerId: property.dealerId,
        userId: session ? session.sub : null,
        name: clean.name,
        email: clean.email,
        phone: clean.phone || null,
        message: clean.message
      }
    });

    await clearAttempts(key);

    // Alert the dealer that owns the listing (best-effort).
    const dealerEmail = property.dealer?.user?.email;
    if (dealerEmail) {
      await trySendMail(
        dealerEmail,
        {
          subject: `New enquiry about "${property.title}"`,
          text: `${clean.name} (${clean.email}${clean.phone ? ', ' + clean.phone : ''}) asked about "${property.title}":\n\n${clean.message}`,
          html: `<p><strong>${clean.name}</strong> (${clean.email}${clean.phone ? ', ' + clean.phone : ''}) asked about <strong>${property.title}</strong>:</p><blockquote>${clean.message}</blockquote>`
        },
        'listing enquiry (dealer)'
      );
    }

    res.status(201).json({
      success: true,
      message: 'Enquiry received. An East Gate agent will be in touch shortly.',
      data: { id: saved.id, createdAt: saved.createdAt }
    });
  } catch (error: any) {
    handleError(res, error, 'POST /api/enquiries');
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
    const { category, state, listingType, q, minPrice, maxPrice, sort } = req.query;

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

    // Keyword search across the fields a buyer would actually type: the title,
    // the location, the description, and the dealer's business name. Capped in
    // length so a huge term cannot be pushed into the query.
    const keyword = typeof q === 'string' ? q.trim() : '';
    if (keyword) {
      if (keyword.length > 80) {
        res.status(400).json({ success: false, error: 'Search terms must be 80 characters or fewer.' });
        return;
      }
      whereClause.OR = [
        { title: { contains: keyword, mode: 'insensitive' } },
        { location: { contains: keyword, mode: 'insensitive' } },
        { description: { contains: keyword, mode: 'insensitive' } },
        { dealer: { is: { businessName: { contains: keyword, mode: 'insensitive' } } } }
      ];
    }

    // Price range. Only apply bounds that were actually supplied and are finite;
    // an unparseable bound is ignored rather than 400-ing the whole catalogue.
    const priceFilter: any = {};
    const min = Number(minPrice);
    const max = Number(maxPrice);
    if (typeof minPrice === 'string' && minPrice !== '' && Number.isFinite(min) && min >= 0) {
      priceFilter.gte = min;
    }
    if (typeof maxPrice === 'string' && maxPrice !== '' && Number.isFinite(max) && max >= 0) {
      priceFilter.lte = max;
    }
    if (Object.keys(priceFilter).length) {
      whereClause.price = priceFilter;
    }

    // Sort. Unknown values fall through to newest-first so a bad query string
    // can never reorder or error the public list.
    const SORTS: Record<string, any> = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      price_asc: { price: 'asc' },
      price_desc: { price: 'desc' },
      beds_desc: { bedrooms: 'desc' }
    };
    const orderBy = SORTS[typeof sort === 'string' ? sort : 'newest'] || SORTS.newest;

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
      orderBy
    });

    res.json({ success: true, count: properties.length, data: properties });
  } catch (error: any) {
    handleError(res, error, "GET /api/properties");
  }
});

// GET /api/properties/:id — a single listing, for the public detail page.
//
// This route is unauthenticated, so it must not become a back door around the
// moderation queue: a PENDING_REVIEW or rejected listing is only handed back to
// an admin or to the dealer who owns it. Everyone else gets the same 404 a
// missing row produces, so the endpoint cannot be used to probe for unlisted
// inventory.
app.get('/api/properties/:id', async (req: Request, res: Response) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: String(req.params.id) },
      include: {
        dealer: {
          select: {
            id: true,
            businessName: true,
            category: true,
            bio: true,
            state: true,
            city: true,
            officeAddress: true,
            status: true,
            ratingAverage: true,
            reviewCount: true,
            badgeIdentity: true,
            badgeCac: true,
            badgePhone: true,
            badgeTitleDocs: true,
            user: { select: { email: true, phone: true } },
            _count: { select: { listings: true } }
          }
        }
      }
    });

    if (!property || property.deletedAt) {
      throw notFound('Property not found');
    }

    if (property.status !== ItemStatus.APPROVED) {
      const token = extractToken(req);
      const session = token ? verifySessionToken(token) : null;
      const isAdmin = !!session && (session.role === 'ADMIN' || session.role === 'SUPER_ADMIN');

      let isOwner = false;
      if (session && !isAdmin) {
        const dealer = await prisma.dealerProfile.findFirst({
          where: { userId: session.sub },
          select: { id: true }
        });
        isOwner = !!dealer && dealer.id === property.dealerId;
      }

      if (!isAdmin && !isOwner) {
        throw notFound('Property not found');
      }
    }

    res.json({ success: true, data: property });
  } catch (error: any) {
    handleError(res, error, 'GET /api/properties/:id');
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

// GET /api/dealers/:id — a single dealer profile with their live catalogue.
//
// Public, but only for dealers the directory would itself show: a VERIFIED
// dealer, or one that already has at least one approved listing. An UNDER_REVIEW
// agency with nothing live is not exposed, so this cannot be used to enumerate
// applications.
app.get('/api/dealers/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!id) throw badRequest('A dealer id is required.');

    const dealer = await prisma.dealerProfile.findUnique({
      where: { id },
      include: {
        user: { select: { email: true, phone: true, fullName: true } },
        listings: {
          where: { status: ItemStatus.APPROVED, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 24
        },
        services: { where: { status: ItemStatus.APPROVED }, take: 12 },
        _count: { select: { listings: true } }
      }
    });

    if (!dealer) throw notFound('That dealer could not be found.');

    const isVerified = dealer.status === VerificationStatus.VERIFIED;
    if (!isVerified && dealer.listings.length === 0) {
      throw notFound('That dealer could not be found.');
    }

    res.json({ success: true, data: dealer });
  } catch (error: any) {
    handleError(res, error, 'GET /api/dealers/:id');
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
        dealer: { select: { businessName: true, user: { select: { email: true } } } }
      }
    });

    // Confirm the booking to the customer and alert the dealer. Best-effort: the
    // appointment is already persisted, so a mail failure must not fail the call.
    const title = inspection.property?.title || 'the property';
    const when = inspection.date.toISOString().slice(0, 10);
    await trySendMail(
      session.email,
      inspectionBookedEmail(session.name, title, when, timeSlot),
      'inspection confirmation (customer)'
    );
    const dealerEmail = inspection.dealer?.user?.email;
    if (dealerEmail) {
      await trySendMail(
        dealerEmail,
        {
          subject: 'New inspection request',
          text: `A customer requested an inspection of "${title}" on ${when} (${timeSlot}). Open your dashboard to confirm.`,
          html: `<p>A customer requested an inspection of <strong>${title}</strong> on ${when} (${timeSlot}).</p>`
        },
        'inspection notice (dealer)'
      );
    }

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

// PATCH /api/user/inspections/:id/reschedule — a customer moves their OWN
// appointment to a new slot. It lands back in RESCHEDULED so an admin re-confirms
// against the dealer's availability; a customer can never set a terminal status
// (CONFIRMED/COMPLETED/CANCELLED) through this route.
app.patch('/api/user/inspections/:id/reschedule', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const { date, timeSlot, notes } = req.body;

    if (!date || !timeSlot) {
      throw badRequest('A new date and time slot are required to reschedule.');
    }
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) {
      throw badRequest('Invalid date supplied for reschedule.');
    }
    if (typeof timeSlot !== 'string' || !timeSlot.trim()) {
      throw badRequest('Invalid time slot supplied for reschedule.');
    }

    const existing = await prisma.inspection.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      throw notFound('Inspection not found.');
    }
    if (existing.userId !== session.sub) {
      throw forbidden('You can only reschedule your own inspections.');
    }
    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw badRequest('This appointment is closed and can no longer be rescheduled.');
    }

    // Keep the original instructions; append the reschedule reason so the admin
    // and dealer still see what the customer asked for originally.
    const reason = notes !== undefined ? String(notes).trim() : '';
    const mergedNotes = reason
      ? (existing.clientNotes ? existing.clientNotes + '\nReschedule reason: ' + reason : 'Reschedule reason: ' + reason)
      : undefined;

    const inspection = await prisma.inspection.update({
      where: { id: existing.id },
      data: {
        date: parsed,
        timeSlot: timeSlot.trim(),
        status: InspectionStatus.RESCHEDULED,
        ...(mergedNotes !== undefined ? { clientNotes: mergedNotes } : {})
      },
      include: {
        property: { select: { id: true, title: true, location: true } },
        dealer: { select: { id: true, businessName: true } }
      }
    });

    res.json({ success: true, message: 'Inspection rescheduled — awaiting confirmation.', data: inspection });
  } catch (error: any) {
    handleError(res, error, 'PATCH /api/user/inspections/:id/reschedule');
  }
});

/* ============================================================
   2b. SAVED LISTINGS (CUSTOMER WISHLIST)
   ============================================================ */

// GET /api/user/saved — the signed-in customer's bookmarked properties.
app.get('/api/user/saved', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;

    const saved = await prisma.savedListing.findMany({
      where: { userId: session.sub },
      orderBy: { createdAt: 'desc' },
      include: {
        property: {
          include: { dealer: { select: { businessName: true } } }
        }
      }
    });

    res.json({ success: true, count: saved.length, data: saved });
  } catch (error: any) {
    handleError(res, error, 'GET /api/user/saved');
  }
});

// POST /api/user/saved — bookmark a property for the signed-in customer.
app.post('/api/user/saved', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const propertyId = typeof req.body?.propertyId === 'string' ? req.body.propertyId : '';
    if (!propertyId) throw badRequest('A propertyId is required.');

    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true }
    });
    if (!property) throw notFound('That property does not exist.');

    // @@unique([userId, propertyId]) makes this idempotent: saving twice is a no-op.
    const saved = await prisma.savedListing.upsert({
      where: { userId_propertyId: { userId: session.sub, propertyId } },
      update: {},
      create: { userId: session.sub, propertyId }
    });

    res.json({ success: true, data: saved });
  } catch (error: any) {
    handleError(res, error, 'POST /api/user/saved');
  }
});

// DELETE /api/user/saved/:propertyId — remove a bookmark.
app.delete('/api/user/saved/:propertyId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const propertyId = String(req.params.propertyId);

    await prisma.savedListing.deleteMany({ where: { userId: session.sub, propertyId } });
    res.json({ success: true });
  } catch (error: any) {
    handleError(res, error, 'DELETE /api/user/saved/:propertyId');
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

/* ============================================================
   PROPERTY IMAGE UPLOADS
   ============================================================ */

// Dealer galleries are stored on disk and served by express.static above,
// which already publishes the project root — so the public URL of a stored
// file is just /uploads/properties/<name>. The folder is created at boot so a
// permissions problem lands in the server log instead of on a dealer's first
// submission.
const PROPERTY_IMAGE_DIR = path.join(__dirname, '..', 'uploads', 'properties');
fs.mkdirSync(PROPERTY_IMAGE_DIR, { recursive: true });

// The accepted types double as the extension map: the filename suffix is
// derived from the detected type, never from the client-supplied name, so a
// crafted originalname cannot write an .html or .js file into the web root.
const PROPERTY_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif'
};

const MIN_PROPERTY_IMAGES = 5;
const MAX_PROPERTY_IMAGES = 12;
const MAX_PROPERTY_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROPERTY_IMAGE =
  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80';

const propertyImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, PROPERTY_IMAGE_DIR),
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${crypto.randomUUID()}${PROPERTY_IMAGE_TYPES[file.mimetype]}`);
    }
  }),
  limits: { fileSize: MAX_PROPERTY_IMAGE_BYTES, files: MAX_PROPERTY_IMAGES },
  fileFilter: (_req, file, callback) => {
    if (PROPERTY_IMAGE_TYPES[file.mimetype]) {
      callback(null, true);
      return;
    }
    callback(badRequest(`"${file.originalname}" is not a supported image. Use JPG, PNG, WEBP, AVIF or GIF.`));
  }
});

/**
 * Multer reports every failure — oversized file, wrong type, too many files —
 * through its own callback rather than by throwing, so it has to be wrapped.
 * Left alone, one of those would reach Express's default error handler and
 * drop the connection instead of answering the dealer with JSON.
 */
function receivePropertyImages(req: Request, res: Response, next: NextFunction): void {
  propertyImageUpload.array('images', MAX_PROPERTY_IMAGES)(req, res, (error: unknown) => {
    if (error) {
      let status = 500;
      let message = 'Image upload failed. Please try again.';

      if (error instanceof ApiError) {
        status = error.status;
        message = error.message;
      } else if (error instanceof multer.MulterError) {
        status = 400;
        message =
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Each image must be 8MB or smaller.'
            : error.code === 'LIMIT_FILE_COUNT'
              ? `A listing can carry at most ${MAX_PROPERTY_IMAGES} images.`
              : 'Image upload failed. Please try again.';
      }

      res.status(status).json({ success: false, error: message });
      return;
    }

    next();
  });
}

// POST /api/uploads/property-images — multipart upload of a listing's photos.
//
// Deliberately a two-step flow: the dealer posts the files here, gets public
// URLs back, then submits the listing as ordinary JSON carrying those URLs.
// That keeps POST /api/dealer/properties parsable as JSON, lets the form be
// edited and resubmitted without re-uploading, and means a rejected listing
// never costs the dealer their photos.
app.post(
  '/api/uploads/property-images',
  requireAuth,
  requireRole('DEALER', 'ADMIN'),
  receivePropertyImages,
  (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) || [];

    if (!files.length) {
      res.status(400).json({ success: false, error: 'Attach at least one image.' });
      return;
    }

    res.json({
      success: true,
      data: {
        urls: files.map((file) => `/uploads/properties/${file.filename}`),
        count: files.length
      }
    });
  }
);

/**
 * Normalises the gallery field of a listing submission into a clean list of
 * public URLs.
 *
 * Only paths we served ourselves (/uploads/...) or real http(s) URLs are kept,
 * so a caller cannot smuggle `javascript:` or a data: URI into an <img src> on
 * the public catalogue. Duplicates are dropped, the cap matches the upload
 * limit, and `cover` (the dealer's chosen main image) always comes first.
 */
function normaliseGallery(cover: unknown, gallery: unknown): string[] {
  const accepted = typeof cover === 'string' && cover.trim() ? [cover] : [];
  if (Array.isArray(gallery)) accepted.push(...gallery);

  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of accepted) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || url.length > 2048 || seen.has(url)) continue;
    if (!url.startsWith('/uploads/') && !/^https?:\/\/\S+$/i.test(url)) continue;

    seen.add(url);
    urls.push(url);
    if (urls.length >= MAX_PROPERTY_IMAGES) break;
  }

  return urls;
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
      mainImage,
      galleryImages
    } = req.body || {};

    // Cover first, then the rest; capped at MAX_PROPERTY_IMAGES and filtered
    // to URLs this server is willing to render.
    const gallery = normaliseGallery(mainImage, galleryImages);

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
    // Buyers judge a listing by its photos, so the catalogue is held to a
    // floor of MIN_PROPERTY_IMAGES rather than accepting a one-photo listing.
    if (gallery.length < MIN_PROPERTY_IMAGES) {
      errors.push(`A listing needs at least ${MIN_PROPERTY_IMAGES} images (received ${gallery.length}).`);
    }

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

    // Same guard for the title document: an unrecognised value is a 400 the
    // dealer can act on, not a Prisma 500 that silently kills the submission.
    let titleDocumentType: TitleDocumentType = TitleDocumentType.C_OF_O;
    if (titleDocument) {
      const parsed = parseTitleDocument(titleDocument);
      if (parsed) titleDocumentType = parsed;
      else errors.push(`"${String(titleDocument)}" is not a recognised title document.`);
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
        titleDocument: titleDocumentType,
        description: description || 'Property submitted by dealer.',
        features: features || [],
        mainImage: gallery[0] || DEFAULT_PROPERTY_IMAGE,
        galleryImages: gallery,
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

// GET /api/dealer/properties — the signed-in dealer's own listings. The public
// catalogue only yields APPROVED rows, so a portal that read it would hide every
// pending submission; this returns all of them with their moderation state.
app.get('/api/dealer/properties', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const properties = await prisma.property.findMany({
      where: {
        dealerId: (req as any).dealer.id,
        deletedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: properties.length, data: properties });
  } catch (error: any) {
    handleError(res, error, "GET /api/dealer/properties");
  }
});

// GET /api/dealer/products — the signed-in dealer's marketplace goods.
app.get('/api/dealer/products', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const products = await prisma.marketplaceProduct.findMany({
      where: { dealerId: (req as any).dealer.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, count: products.length, data: products });
  } catch (error: any) {
    handleError(res, error, "GET /api/dealer/products");
  }
});

// GET /api/dealer/inspections — viewing requests against this dealer's
// listings, with the client's contact details so the desk can call or WhatsApp
// them straight from the row.
app.get('/api/dealer/inspections', requireAuth, requireRole('DEALER', 'ADMIN'), loadDealerProfile, async (req: Request, res: Response) => {
  try {
    const inspections = await prisma.inspection.findMany({
      where: { dealerId: (req as any).dealer.id },
      orderBy: { createdAt: 'desc' },
      include: {
        property: { select: { id: true, title: true } },
        user: { select: { id: true, fullName: true, phone: true, email: true } }
      }
    });

    res.json({ success: true, count: inspections.length, data: inspections });
  } catch (error: any) {
    handleError(res, error, "GET /api/dealer/inspections");
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

    // Send the verification link. Issued after the account exists; a mail
    // failure must not undo a successful registration, so it is fire-and-forget.
    try {
      const raw = await issueAuthToken(user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MINUTES);
      const url = `${appBaseUrl(req)}/verify-email.html?token=${encodeURIComponent(raw)}`;
      await trySendMail(clean.email, verificationEmail(clean.fullName, url), 'email verification');
    } catch (mailError) {
      console.error('[register] could not issue/send verification email', mailError);
    }

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

    // Verification link for the new dealer account (best-effort).
    try {
      const raw = await issueAuthToken(user.id, 'EMAIL_VERIFICATION', EMAIL_VERIFICATION_TTL_MINUTES);
      const url = `${appBaseUrl(req)}/verify-email.html?token=${encodeURIComponent(raw)}`;
      await trySendMail(clean.email, verificationEmail(clean.fullName, url), 'email verification');
    } catch (mailError) {
      console.error('[dealer-register] could not issue/send verification email', mailError);
    }

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

    // The DEALER is the unit of review, not the file. Registration writes a
    // DealerProfile and no documents at all, so a queue built only from
    // VerificationDoc would never surface a fresh sign-up — the account would sit
    // at UNDER_REVIEW with no button anywhere in the console that could move it.
    // These rows are what the workbench renders; `verifications` stays for
    // documents filed against a dealer who is not themselves pending.
    const pendingDealers = await prisma.dealerProfile.findMany({
      where: { status: VerificationStatus.UNDER_REVIEW },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { fullName: true, email: true, phone: true } },
        verifications: { orderBy: { submittedAt: 'asc' } }
      }
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
        pendingDealers: pendingDealers.map((dealer) => ({
          id: dealer.id,
          businessName: dealer.businessName,
          fullName: dealer.user.fullName,
          email: dealer.user.email,
          phone: dealer.user.phone,
          category: dealer.category,
          cacNumber: dealer.cacNumber,
          state: dealer.state,
          city: dealer.city,
          status: dealer.status,
          createdAt: dealer.createdAt.toISOString(),
          documents: dealer.verifications.map((doc) => ({
            id: doc.id,
            documentType: doc.documentType,
            documentName: doc.documentName,
            documentUrl: doc.documentUrl,
            status: doc.status,
            submittedAt: doc.submittedAt.toISOString()
          }))
        })),
        verifiedDealerCount
      }
    });
  } catch (error: any) {
    handleError(res, error, "GET /api/admin/queue");
  }
});

// GET /api/admin/approved — everything already cleared for public display.
//
// The queue answers "what still needs a decision"; this answers "what is live,
// who put it there, and who signed it off". The console groups these rows under
// the person who did the listing, so every item carries both names rather than
// only an id: `submittedBy` is the human (the dealer account's full name, with
// the agency as `submittedByBusiness`), `approvedBy` is whoever published it.
//
// ?mine=1 narrows the list to the calls this administrator personally made.
// Every item is still returned in the unfiltered shape so the toggle can show
// both counts without a second round trip.
app.get('/api/admin/approved', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const mineOnly = String(req.query.mine || '') === '1';

    const dealerInclude = {
      select: {
        id: true,
        businessName: true,
        user: { select: { fullName: true } }
      }
    } as const;

    const [properties, products, services, decisions] = await Promise.all([
      prisma.property.findMany({
        where: { status: ItemStatus.APPROVED, deletedAt: null },
        include: { dealer: dealerInclude },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.marketplaceProduct.findMany({
        where: { status: ItemStatus.APPROVED },
        include: { dealer: dealerInclude },
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.serviceOffering.findMany({
        where: { status: ItemStatus.APPROVED },
        include: { dealer: dealerInclude },
        orderBy: { updatedAt: 'desc' }
      }),
      // One entry per published item: who put it live and when. APPROVE_* is a
      // moderation sign-off; ADMIN_CREATE_PRODUCT is an official product going
      // live the instant it is written, which is a publication by the same
      // person even though no queue step preceded it. Ordered newest-first, so
      // the first row seen for a targetId is the current one.
      prisma.auditLog.findMany({
        where: {
          action: {
            in: ['APPROVE_PROPERTY', 'APPROVE_PRODUCT', 'APPROVE_SERVICE', 'ADMIN_CREATE_PRODUCT']
          }
        },
        orderBy: { timestamp: 'desc' },
        select: {
          adminId: true,
          action: true,
          targetId: true,
          timestamp: true,
          admin: { select: { fullName: true } }
        }
      })
    ]);

    const signedOff = new Map<string, { adminId: string; adminName: string; at: Date }>();
    for (const entry of decisions) {
      if (signedOff.has(entry.targetId)) continue;
      signedOff.set(entry.targetId, {
        adminId: entry.adminId,
        adminName: entry.admin.fullName,
        at: entry.timestamp
      });
    }

    type Submitter = { key: string; person: string; business: string };

    // A dealer's listing belongs to a person, not an agency: the console shows
    // the account holder's name with the business underneath. Products created
    // straight from this page have no dealer at all and are attributed to the
    // platform itself.
    const submitterOf = (dealer: { id: string; businessName: string; user?: { fullName: string } | null } | null): Submitter =>
      dealer
        ? {
            key: dealer.id,
            person: dealer.user?.fullName || dealer.businessName,
            business: dealer.businessName
          }
        : { key: 'east-gate-official', person: 'East Gate Official', business: 'Published by an administrator' };

    const items: any[] = [];

    for (const property of properties) {
      const submitter = submitterOf(property.dealer);
      const signOff = signedOff.get(property.id);
      items.push({
        id: property.id,
        type: 'PROPERTY',
        name: property.title,
        category: String(property.category),
        detail: String(property.titleDocument),
        location: property.location,
        price: String(property.price),
        currency: property.currency,
        submitterKey: submitter.key,
        submittedBy: submitter.person,
        submittedByBusiness: submitter.business,
        approvedBy: signOff ? signOff.adminName : null,
        approvedById: signOff ? signOff.adminId : null,
        approvedAt: (signOff ? signOff.at : property.updatedAt).toISOString()
      });
    }

    for (const product of products) {
      const submitter = submitterOf(product.dealer);
      const signOff = signedOff.get(product.id);
      items.push({
        id: product.id,
        type: 'PRODUCT',
        name: product.name,
        category: String(product.category),
        detail: product.specifications,
        location: '',
        price: String(product.price),
        currency: 'NGN',
        submitterKey: submitter.key,
        submittedBy: submitter.person,
        submittedByBusiness: submitter.business,
        approvedBy: signOff ? signOff.adminName : null,
        approvedById: signOff ? signOff.adminId : null,
        approvedAt: (signOff ? signOff.at : product.updatedAt).toISOString()
      });
    }

    for (const service of services) {
      const submitter = submitterOf(service.dealer);
      const signOff = signedOff.get(service.id);
      items.push({
        id: service.id,
        type: 'SERVICE',
        name: service.title,
        category: String(service.category),
        detail: service.coverageState,
        location: service.coverageState,
        price: '',
        currency: '',
        submitterKey: submitter.key,
        submittedBy: submitter.person,
        submittedByBusiness: submitter.business,
        approvedBy: signOff ? signOff.adminName : null,
        approvedById: signOff ? signOff.adminId : null,
        approvedAt: (signOff ? signOff.at : service.updatedAt).toISOString()
      });
    }

    // Newest publication first, so the group at the top of the console is the
    // one that went live most recently.
    items.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : a.approvedAt > b.approvedAt ? -1 : 0));

    const mineCount = items.filter((item) => item.approvedById === session.sub).length;
    const visible = mineOnly ? items.filter((item) => item.approvedById === session.sub) : items;

    res.json({
      success: true,
      data: {
        items: visible,
        total: items.length,
        mineCount,
        scope: mineOnly ? 'mine' : 'all'
      }
    });
  } catch (error: any) {
    handleError(res, error, "GET /api/admin/approved");
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

// POST /api/admin/verify-dealer — Verify a dealer and award their badges.
//
// The decision is about the AGENCY, so `dealerId` is the primary key here and
// that is what the workbench sends. A `docId` is still accepted for older
// callers and simply resolves to the dealer who filed it.
//
// Every credential that dealer has outstanding is cleared in the same call.
// Leaving two of their files at UNDER_REVIEW after awarding the Verified badge
// would put the console in a state where the row says "verified" while the
// queue still says "awaiting review".
app.post('/api/admin/verify-dealer', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = req.session!;
    const { dealerId, docId } = req.body || {};

    let targetId = typeof dealerId === 'string' ? dealerId.trim() : '';
    if (!targetId && typeof docId === 'string' && docId.trim()) {
      const source = await prisma.verificationDoc.findUnique({
        where: { id: docId.trim() },
        select: { dealerId: true }
      });
      if (!source) throw notFound('That credential document no longer exists.');
      targetId = source.dealerId;
    }
    if (!targetId) throw badRequest('A dealer id is required.');

    const dealer = await prisma.dealerProfile.findUnique({ where: { id: targetId } });
    if (!dealer) throw notFound('That dealer does not exist.');

    const cleared = await prisma.verificationDoc.updateMany({
      where: { dealerId: dealer.id, status: VerificationStatus.UNDER_REVIEW },
      data: {
        status: VerificationStatus.VERIFIED,
        reviewedAt: new Date(),
        reviewedBy: session.sub
      }
    });

    // The title-deeds badge is earned by having filed a title document, not by
    // being approved — a dealer who submitted only a CAC certificate should not
    // leave with all four dimensions lit.
    const filed = await prisma.verificationDoc.findMany({
      where: { dealerId: dealer.id },
      select: { documentType: true }
    });
    const hasTitleDocs = dealer.badgeTitleDocs ||
      filed.some((doc) => /TITLE|DEED|CONVEYANCE|SURVEY/i.test(doc.documentType));

    await prisma.dealerProfile.update({
      where: { id: dealer.id },
      data: {
        status: VerificationStatus.VERIFIED,
        badgeIdentity: true,
        badgePhone: true,
        badgeCac: dealer.badgeCac || Boolean(dealer.cacNumber),
        badgeTitleDocs: hasTitleDocs
      }
    });

    await prisma.auditLog.create({
      data: {
        adminId: session.sub,
        action: 'VERIFY_DEALER_CREDENTIALS',
        targetEntity: 'DealerProfile',
        targetId: dealer.id,
        targetName: dealer.businessName,
        details: cleared.count
          ? `Verified ${cleared.count} outstanding credential document(s) and awarded East Gate Verified status.`
          : 'Awarded East Gate Verified status.'
      }
    });

    res.json({
      success: true,
      message: `${dealer.businessName} is verified — badge awarded.`,
      data: { dealerId: dealer.id, documentsCleared: cleared.count }
    });
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

// GET /api/admin/enquiries — per-listing enquiry inbox. Carries the listing and
// dealer behind each message so the desk can triage by property.
app.get('/api/admin/enquiries', requireAuth, requireRole('ADMIN'), async (_req: Request, res: Response) => {
  try {
    const enquiries = await prisma.listingEnquiry.findMany({
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 500,
      include: {
        property: { select: { id: true, title: true, location: true, state: true } },
        dealer: { select: { id: true, businessName: true } }
      }
    });

    res.json({
      success: true,
      count: enquiries.length,
      unreadCount: enquiries.filter((m) => !m.readAt).length,
      data: enquiries
    });
  } catch (error: any) {
    handleError(res, error, 'GET /api/admin/enquiries');
  }
});

// PATCH /api/admin/enquiries/:id — Mark one enquiry read (or unread).
app.patch('/api/admin/enquiries/:id', requireAuth, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!id) throw badRequest('An enquiry id is required.');

    const updated = await prisma.listingEnquiry.update({
      where: { id },
      data: { readAt: req.body?.read === false ? null : new Date() }
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    handleError(res, error, 'PATCH /api/admin/enquiries/:id');
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

// GET /api/admin/inspections — every inspection appointment across the platform,
// with the requesting customer and the assigned dealer attached so the console can
// render one self-contained row.
app.get('/api/admin/inspections', requireAuth, requireRole('ADMIN'), async (_req: Request, res: Response) => {
  try {
    const inspections = await prisma.inspection.findMany({
      orderBy: { date: 'asc' },
      include: {
        property: { select: { id: true, title: true, location: true } },
        dealer: { select: { id: true, businessName: true } },
        user: { select: { id: true, fullName: true, email: true, phone: true } },
        cancelledBy: { select: { id: true, fullName: true, email: true } }
      }
    });

    res.json({ success: true, count: inspections.length, data: inspections });
  } catch (error: any) {
    handleError(res, error, 'GET /api/admin/inspections');
  }
});

// PATCH /api/inspections/:id/status — admin closes the loop on an appointment:
// confirms, marks it completed after the site visit, reschedules or cancels it.
// A reschedule carries the new date / time slot; a cancellation carries the
// reason, which is required and recorded for documentation along with who
// cancelled it. Admin-only for now; the assigned dealer does not get this grant.
app.patch('/api/inspections/:id/status', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, date, timeSlot, notes } = req.body;
    const session = req.session!;
    const allowed = Object.values(InspectionStatus) as string[];

    if (!status || !allowed.includes(status)) {
      throw badRequest(`Status must be one of: ${allowed.join(', ')}.`);
    }

    const existing = await prisma.inspection.findUnique({ where: { id: String(req.params.id) } });
    if (!existing) {
      throw notFound('Inspection not found.');
    }

    const data: {
      status: InspectionStatus;
      date?: Date;
      timeSlot?: string;
      adminNotes?: string;
      cancelledAt?: Date;
      cancelledById?: string;
    } = {
      status: status as InspectionStatus
    };

    // Rescheduling rewrites the slot; a plain status change leaves it untouched.
    if (date !== undefined) {
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw badRequest('Invalid date supplied for reschedule.');
      }
      data.date = parsed;
    }
    if (timeSlot !== undefined) {
      if (typeof timeSlot !== 'string' || !timeSlot.trim()) {
        throw badRequest('Invalid time slot supplied for reschedule.');
      }
      data.timeSlot = timeSlot.trim();
    }

    // Cancellations must be documented: a reason is mandatory and the closing
    // admin + timestamp are stamped so the record is accountable.
    if (status === InspectionStatus.CANCELLED) {
      const reason = typeof notes === 'string' ? notes.trim() : '';
      if (!reason) {
        throw badRequest('A cancellation reason is required for documentation.');
      }
      data.adminNotes = reason;
      data.cancelledAt = new Date();
      data.cancelledById = session.sub;
    }

    const inspection = await prisma.inspection.update({
      where: { id: existing.id },
      data,
      include: {
        property: { select: { id: true, title: true, location: true } },
        dealer: { select: { id: true, businessName: true } },
        user: { select: { id: true, fullName: true, email: true, phone: true } },
        cancelledBy: { select: { id: true, fullName: true, email: true } }
      }
    });

    res.json({ success: true, message: `Inspection marked ${status}.`, data: inspection });
  } catch (error: any) {
    handleError(res, error, 'PATCH /api/inspections/:id/status');
  }
});

// Catch-all. Unknown API paths stay machine-readable (JSON), everything else
// gets the branded 404 page so a dead link never lands on a bare white screen.
// Must sit after every route and after express.static, which both fall through
// here via next() when nothing matched.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ success: false, error: 'Endpoint not found.' });
    return;
  }
  res.status(404).sendFile(path.join(__dirname, '..', '404.html'));
});

app.listen(PORT, () => {
  console.log(`East Gate Enterprise Server running on http://localhost:${PORT}`);
  if (!emailConfigured() && devCatchEnabled()) {
    console.warn(
      '[mailer] MAIL_DEV_CATCH is ON — outgoing mail goes to a disposable Ethereal inbox and is logged, not delivered. Set SMTP_* and unset MAIL_DEV_CATCH before production.'
    );
  }
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

  pruneAuthTokens()
    .then((count) => {
      if (count > 0) console.log(`[auth] pruned ${count} spent/expired auth token(s)`);
    })
    .catch((error) => console.error('[auth] auth token prune failed', error));
}, REVOCATION_PRUNE_MS);
pruneTimer.unref?.();
