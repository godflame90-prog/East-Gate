import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { prisma } from './db';
import { ItemStatus, ListingType, PropertyCategory, TitleDocumentType, VerificationStatus } from '@prisma/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files (HTML, CSS, JS, Assets)
app.use(express.static(path.join(__dirname, '..')));

/* ============================================================
   1. PUBLIC ENDPOINTS (Strictly APPROVED items only)
   ============================================================ */

// GET /api/properties — Only returns APPROVED properties
app.get('/api/properties', async (req: Request, res: Response) => {
  try {
    const { category, state, listingType } = req.query;

    const whereClause: any = {
      status: ItemStatus.APPROVED, // MANDATORY: Pending items hidden from public
      deletedAt: null
    };

    if (category && category !== 'ALL') {
      whereClause.category = category as PropertyCategory;
    }
    if (state && state !== 'ALL') {
      whereClause.state = state as string;
    }
    if (listingType && listingType !== 'ALL') {
      whereClause.listingType = listingType as ListingType;
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/properties/:id
app.get('/api/properties/:id', async (req: Request, res: Response) => {
  try {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      include: { dealer: true }
    });

    if (!property) {
      return res.status(404).json({ success: false, error: 'Property not found' });
    }

    res.json({ success: true, data: property });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dealers — Directory of verified dealers & professionals
app.get('/api/dealers', async (_req: Request, res: Response) => {
  try {
    const dealers = await prisma.dealerProfile.findMany({
      include: {
        user: { select: { email: true, phone: true } },
        _count: { select: { listings: true } }
      },
      orderBy: { ratingAverage: 'desc' }
    });

    res.json({ success: true, count: dealers.length, data: dealers });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ============================================================
   2. CUSTOMER & INSPECTION ENDPOINTS
   ============================================================ */

// POST /api/inspections — Book an inspection
app.post('/api/inspections', async (req: Request, res: Response) => {
  try {
    const { userId, propertyId, dealerId, date, timeSlot, clientNotes } = req.body;

    const inspection = await prisma.inspection.create({
      data: {
        userId: userId || 'usr_jay_default',
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/user/inspections
app.get('/api/user/inspections/:userId', async (req: Request, res: Response) => {
  try {
    const inspections = await prisma.inspection.findMany({
      where: { userId: req.params.userId },
      include: {
        property: { select: { title: true, location: true, price: true } },
        dealer: { select: { businessName: true } }
      },
      orderBy: { date: 'asc' }
    });

    res.json({ success: true, data: inspections });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ============================================================
   3. DEALER PORTAL SUBMISSIONS (Mandatory PENDING_REVIEW)
   ============================================================ */

// POST /api/dealer/properties — Dealer submits property (PENDING_REVIEW)
app.post('/api/dealer/properties', async (req: Request, res: Response) => {
  try {
    const {
      dealerId,
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
    } = req.body;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString().slice(-4);

    const property = await prisma.property.create({
      data: {
        dealerId,
        title,
        slug,
        listingType: listingType || ListingType.BUY,
        category: category || PropertyCategory.RESIDENTIAL,
        price,
        state: state || 'Abia',
        location,
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/dealer/products — Dealer submits product (PENDING_REVIEW)
app.post('/api/dealer/products', async (req: Request, res: Response) => {
  try {
    const { dealerId, name, category, price, stockInfo, specifications, mainImage } = req.body;

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
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ============================================================
   4. ADMIN CONTROL FORTRESS & DIRECT PRODUCT CREATION
   ============================================================ */

// GET /api/admin/queue — Lists all items pending approval
app.get('/api/admin/queue', async (_req: Request, res: Response) => {
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

    res.json({
      success: true,
      data: {
        properties: pendingProperties,
        products: pendingProducts,
        services: pendingServices,
        verifications: pendingVerifications
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/products — DIRECT ADMIN PRODUCT CREATION (Auto-APPROVED & Official)
app.post('/api/admin/products', async (req: Request, res: Response) => {
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/approve — Admin approves property, product, or service
app.post('/api/admin/approve', async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, adminId } = req.body;
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

    // Helper to resolve admin
    const adminUser = await prisma.user.findFirst({
      where: adminId ? { OR: [{ id: adminId }, { email: adminId }] } : { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
    });

    if (adminUser) {
      await prisma.auditLog.create({
        data: {
          adminId: adminUser.id,
          action: `APPROVE_${entityType.toUpperCase()}`,
          targetEntity: entityType,
          targetId: entityId,
          targetName,
          details: `Admin vetted and cleared submission for live public display.`
        }
      });
    }

    res.json({ success: true, message: `${entityType} approved and published live.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/reject — Admin rejects property, product, or service
app.post('/api/admin/reject', async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, reason, adminId } = req.body;
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

    const adminUser = await prisma.user.findFirst({
      where: adminId ? { OR: [{ id: adminId }, { email: adminId }] } : { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
    });

    if (adminUser) {
      await prisma.auditLog.create({
        data: {
          adminId: adminUser.id,
          action: `REJECT_${entityType.toUpperCase()}`,
          targetEntity: entityType,
          targetId: entityId,
          targetName,
          details: `Reason: ${reason || 'Did not meet compliance criteria'}`
        }
      });
    }

    res.json({ success: true, message: `${entityType} rejected.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/verify-dealer — Verify CAC/Identity doc and award badge
app.post('/api/admin/verify-dealer', async (req: Request, res: Response) => {
  try {
    const { docId, adminId } = req.body;

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

    const adminUser = await prisma.user.findFirst({
      where: adminId ? { OR: [{ id: adminId }, { email: adminId }] } : { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
    });

    if (adminUser) {
      await prisma.auditLog.create({
        data: {
          adminId: adminUser.id,
          action: 'VERIFY_DEALER_CREDENTIALS',
          targetEntity: 'DealerProfile',
          targetId: doc.dealerId,
          targetName: doc.dealer.businessName,
          details: `Verified ${doc.documentName} and awarded East Gate Verified status.`
        }
      });
    }

    res.json({ success: true, message: 'Dealer credentials verified and badge awarded.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/audit-logs — Returns immutable audit trail
app.get('/api/admin/audit-logs', async (_req: Request, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      include: { admin: { select: { fullName: true, role: true } } },
      orderBy: { timestamp: 'desc' }
    });

    res.json({ success: true, count: logs.length, data: logs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`East Gate Enterprise Server running on http://localhost:${PORT}`);
});
