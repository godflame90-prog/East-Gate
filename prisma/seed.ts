import { PrismaClient, Role, VerificationStatus, ItemStatus, ListingType, PropertyCategory, TitleDocumentType, InspectionStatus } from '@prisma/client';
import dotenv from 'dotenv';
import { hashPassword } from '../server/auth';

// Prisma reads .env for DATABASE_URL on its own, but nothing populates the rest of
// process.env in this process — server/index.ts does that, and it is not loaded
// here. Without this the ADMIN_SEED_PASSWORD lookup below always sees undefined.
dotenv.config();

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'admin@eastgate.com';

// Demo credentials. The three non-admin passwords are documented in README.md and
// wired to the one-click demo panel on login.html.
//
// The super-admin password is NOT stored here. It is read from the
// ADMIN_SEED_PASSWORD environment variable (see .env.example) so that it never
// enters version control. `.env` is gitignored.
const DEMO_PASSWORDS = {
  customer: 'EastGate@Jay2026',
  dealer: 'EastGate@John2026',
  apex: 'EastGate@Apex2026'
};

// The accounts this seed owns. Anything else in the User table is a real account,
// and its presence makes the destructive demo-data stage refuse to run.
const DEMO_EMAILS = [
  ADMIN_EMAIL,
  'jay@example.com',
  'dealer@johnproperties.ng',
  'apex@apexbuilders.ng'
];

/**
 * Creates the super-admin when it is missing; leaves it completely alone when it
 * already exists.
 *
 * The password is only ever set on creation. This function cannot reset a live
 * admin password back to a known value — re-running the seed used to do exactly
 * that, which handed super-admin to anyone who could run `npm run db:seed`.
 * Rotating the password is now a deliberate manual act.
 */
async function bootstrapAdmin() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    if (existing.role !== Role.SUPER_ADMIN) {
      await prisma.user.update({
        where: { email: ADMIN_EMAIL },
        data: { role: Role.SUPER_ADMIN }
      });
      console.log(`  ${ADMIN_EMAIL} promoted to SUPER_ADMIN`);
    }
    console.log(`  ${ADMIN_EMAIL} already exists — password left untouched`);
    return existing;
  }

  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) {
    throw new Error(
      '\n  ADMIN_SEED_PASSWORD is not set and the super-admin does not exist yet,\n' +
      '  so the seed cannot create it.\n\n' +
      '  Add it to .env (see .env.example) and re-run. Generate one with:\n' +
      '    node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"\n'
    );
  }

  return prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      phone: '+234 809 000 8888',
      fullName: 'Administration',
      passwordHash: await hashPassword(password),
      role: Role.SUPER_ADMIN
    }
  });
}

/**
 * Refuses to wipe a database that holds accounts this seed did not create.
 *
 * The demo dataset is only ever safe to destroy on a throwaway database. On a
 * real one this would delete every user, dealer, listing and audit log — and
 * the audit log is the evidence trail for exactly the abuse it would hide.
 */
async function assertDestructiveSeedAllowed() {
  if (process.env.ALLOW_DESTRUCTIVE_SEED === '1') return;

  const foreign = await prisma.user.findMany({
    where: { NOT: { email: { in: DEMO_EMAILS } } },
    select: { email: true }
  });

  if (foreign.length === 0) return;

  console.error(
    '\n  REFUSING TO SEED\n\n' +
    '  This database holds ' + foreign.length + ' account(s) this seed did not create:\n' +
    foreign.slice(0, 5).map(u => '    - ' + u.email).join('\n') + '\n\n' +
    '  Continuing would delete every user, dealer, listing and audit log, and rebuild\n' +
    '  the demo dataset over real data.\n\n' +
    '  If this really is a throwaway demo database, re-run with:\n' +
    '    ALLOW_DESTRUCTIVE_SEED=1 npm run db:seed\n'
  );
  process.exit(1);
}

async function main() {
  console.log('Seeding East Gate database...');

  // First and independently of the demo data: the super-admin must exist, and must
  // survive a demo rebuild with its password intact.
  const admin = await bootstrapAdmin();

  await assertDestructiveSeedAllowed();

  const [customerHash, dealerHash, apexHash] = await Promise.all([
    hashPassword(DEMO_PASSWORDS.customer),
    hashPassword(DEMO_PASSWORDS.dealer),
    hashPassword(DEMO_PASSWORDS.apex)
  ]);

  // Clean existing demo tables
  await prisma.auditLog.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.savedListing.deleteMany();
  await prisma.report.deleteMany();
  await prisma.verificationDoc.deleteMany();
  await prisma.property.deleteMany();
  await prisma.marketplaceProduct.deleteMany();
  await prisma.serviceOffering.deleteMany();
  await prisma.dealerProfile.deleteMany();
  // Demo users only. The super-admin was created/preserved above and must not be
  // deleted, or re-seeding would hand the platform a brand-new admin id.
  await prisma.user.deleteMany({ where: { NOT: { email: { in: DEMO_EMAILS } } } });
  await prisma.user.deleteMany({ where: { email: { not: ADMIN_EMAIL } } });

  // 2. Create Normal User (Customer)
  const customer = await prisma.user.create({
    data: {
      email: 'jay@example.com',
      phone: '+234 803 123 4567',
      fullName: 'Jay Nwosu',
      passwordHash: customerHash,
      role: Role.CUSTOMER
    }
  });

  // 3. Create Verified Dealer: John Properties Ltd
  const dealerUser1 = await prisma.user.create({
    data: {
      email: 'dealer@johnproperties.ng',
      phone: '+234 802 987 6543',
      fullName: 'Chief John Okafor',
      passwordHash: dealerHash,
      role: Role.DEALER
    }
  });

  const dealerProfile1 = await prisma.dealerProfile.create({
    data: {
      userId: dealerUser1.id,
      businessName: 'John Properties Ltd',
      cacNumber: 'RC-1849204',
      category: 'Real Estate Agency & Brokerage',
      bio: 'Premier residential and commercial property brokerage with over 15 years experience across the South-East and Niger Delta.',
      state: 'Abia',
      city: 'Aba',
      officeAddress: '14 Brass Street, Aba, Abia State',
      status: VerificationStatus.VERIFIED,
      badgeIdentity: true,
      badgeCac: true,
      badgePhone: true,
      badgeTitleDocs: true,
      ratingAverage: 4.9,
      reviewCount: 38
    }
  });

  // 4. Create Under-Review Dealer: Apex Build & Construction
  const dealerUser2 = await prisma.user.create({
    data: {
      email: 'apex@apexbuilders.ng',
      phone: '+234 814 555 1234',
      fullName: 'Engr. Michael Adeyemi',
      passwordHash: apexHash,
      role: Role.DEALER
    }
  });

  const dealerProfile2 = await prisma.dealerProfile.create({
    data: {
      userId: dealerUser2.id,
      businessName: 'Apex Build & Construction',
      cacNumber: 'RC-2039481',
      category: 'General Contractor & Building Supplier',
      bio: 'Turnkey structural civil engineering and commercial construction firm.',
      state: 'Rivers',
      city: 'Port Harcourt',
      officeAddress: 'Plot 82 Trans-Amadi Industrial Layout, Port Harcourt',
      status: VerificationStatus.UNDER_REVIEW,
      badgeIdentity: true,
      badgeCac: false, // CAC under review
      badgePhone: true,
      badgeTitleDocs: false,
      ratingAverage: 4.7,
      reviewCount: 14
    }
  });

  // Verification Documents
  await prisma.verificationDoc.createMany({
    data: [
      {
        dealerId: dealerProfile2.id,
        documentType: 'CAC_INCORPORATION',
        documentName: 'Apex_CAC_Certificate_RC2039481.pdf',
        documentUrl: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=600&q=80',
        status: VerificationStatus.UNDER_REVIEW,
        notes: 'Awaiting compliance officer cross-verification with Corporate Affairs portal.'
      },
      {
        dealerId: dealerProfile2.id,
        documentType: 'TITLE_DEED',
        documentName: 'Enugu_Plot_Cadastral_Survey.pdf',
        documentUrl: 'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
        status: VerificationStatus.UNDER_REVIEW,
        notes: 'Cadastral survey beacon coordinate verification needed.'
      }
    ]
  });

  // 5. Create Approved Properties
  const prop1 = await prisma.property.create({
    data: {
      dealerId: dealerProfile1.id,
      title: 'Modern 4 Bedroom Villa',
      slug: 'modern-4-bedroom-villa-aba',
      listingType: ListingType.BUY,
      category: PropertyCategory.RESIDENTIAL,
      price: 85000000,
      currency: 'NGN',
      state: 'Abia',
      location: 'Aba, Abia State',
      bedrooms: 4,
      bathrooms: 5,
      parkingSpaces: 2,
      landSize: '650 sqm',
      titleDocument: TitleDocumentType.C_OF_O,
      isTitleVerified: true,
      mainImage: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80',
      description: 'Impeccably finished architectural masterpiece situated in a serene, secured residential enclave. Features an expansive formal living room, custom chef’s kitchen with imported marble countertops, smart home lighting, and lush landscaped garden.',
      features: ['Solar Power Inverter', 'Borehole with Industrial Filter', 'CCTV & Electric Fence', 'Fitted Italian Kitchen', 'En-suite Bedrooms'],
      status: ItemStatus.APPROVED,
      isFeatured: true
    }
  });

  const prop2 = await prisma.property.create({
    data: {
      dealerId: dealerProfile1.id,
      title: 'Contemporary 3 Bedroom Apartment',
      slug: 'contemporary-3-bedroom-apartment-owerri',
      listingType: ListingType.BUY,
      category: PropertyCategory.RESIDENTIAL,
      price: 42500000,
      currency: 'NGN',
      state: 'Imo',
      location: 'Owerri, Imo State',
      bedrooms: 3,
      bathrooms: 3,
      parkingSpaces: 1,
      landSize: '320 sqm',
      titleDocument: TitleDocumentType.GOVERNORS_CONSENT,
      isTitleVerified: true,
      mainImage: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80',
      description: 'Sophisticated open-concept apartment in prime New Owerri. Featuring floor-to-ceiling acoustic windows, ambient recessed lighting, and a private balcony.',
      features: ['24/7 Security Patrol', 'Access Controlled Gate', 'High-Speed Fiber Ready', 'Gym & Clubhouse'],
      status: ItemStatus.APPROVED,
      isFeatured: true
    }
  });

  const prop3 = await prisma.property.create({
    data: {
      dealerId: dealerProfile1.id,
      title: 'Executive 5 Bedroom Detached Duplex',
      slug: 'executive-5-bedroom-duplex-port-harcourt',
      listingType: ListingType.BUY,
      category: PropertyCategory.RESIDENTIAL,
      price: 150000000,
      currency: 'NGN',
      state: 'Rivers',
      location: 'GRA Phase 2, Port Harcourt',
      bedrooms: 5,
      bathrooms: 6,
      parkingSpaces: 4,
      landSize: '900 sqm',
      titleDocument: TitleDocumentType.C_OF_O,
      isTitleVerified: true,
      mainImage: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
      description: 'Grand executive estate built to the highest European structural standards. Offers sweeping double-volume foyer, private cinema room, and Olympic perimeter security.',
      features: ['Private Cinema Room', 'Swimming Pool Ready', 'Automated Gates', 'Smart Climate Control'],
      status: ItemStatus.APPROVED,
      isFeatured: true
    }
  });

  await prisma.property.create({
    data: {
      dealerId: dealerProfile1.id,
      title: '2 Plots Prime Commercial Land',
      slug: 'prime-commercial-land-aba',
      listingType: ListingType.LAND_BANKING,
      category: PropertyCategory.LAND,
      price: 35000000,
      currency: 'NGN',
      state: 'Abia',
      location: 'Enugu Expressway, Aba',
      bedrooms: 0,
      bathrooms: 0,
      parkingSpaces: 0,
      landSize: '1,350 sqm',
      titleDocument: TitleDocumentType.REGISTERED_SURVEY_DEED,
      isTitleVerified: true,
      mainImage: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1600&q=80',
      description: 'High-visibility corner plot directly along the commercial thoroughfare. 100% dry, level topography with comprehensive beacons in place.',
      features: ['100% Dry Table Land', 'High Traffic Frontage', 'Instant Allocation', 'Registered Beacons'],
      status: ItemStatus.APPROVED,
      isFeatured: false
    }
  });

  // 6. Create Dealer Pending Property (MANDATORY ADMIN APPROVAL RULE)
  await prisma.property.create({
    data: {
      dealerId: dealerProfile2.id,
      title: 'Executive 5 Bedroom Villa with Swimming Pool',
      slug: 'executive-5-bed-villa-enugu',
      listingType: ListingType.BUY,
      category: PropertyCategory.LUXURY,
      price: 185000000,
      currency: 'NGN',
      state: 'Enugu',
      location: 'Independence Layout, Enugu',
      bedrooms: 5,
      bathrooms: 6,
      parkingSpaces: 4,
      landSize: '1,100 sqm',
      titleDocument: TitleDocumentType.C_OF_O,
      isTitleVerified: false,
      mainImage: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80',
      description: 'Newly submitted estate awaiting compliance verification. Premium finishes, private pool, smart automation.',
      features: ['Olympic Swimming Pool', 'Gym House', 'Solar Inverter 15kVA'],
      status: ItemStatus.PENDING_REVIEW, // HIDDEN UNTIL ADMIN APPROVES!
      isFeatured: false
    }
  });

  // 7. Rental / lease / auction properties.
  //
  // The Purpose filter on the public catalogue is only demonstrable if the table
  // holds more than BUY, so seed one listing per remaining ListingType.
  const purposeSeed = [
    {
      title: 'Furnished 3 Bedroom Apartment — Short Let',
      slug: 'furnished-3bed-shortlet-aba',
      listingType: ListingType.SHORT_LET,
      category: PropertyCategory.RESIDENTIAL,
      price: 3500000,
      state: 'Abia',
      location: 'Old GRA, Aba',
      bedrooms: 3,
      bathrooms: 2,
      parkingSpaces: 1,
      landSize: '220 sqm',
      titleDocument: TitleDocumentType.C_OF_O,
      mainImage: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1600&q=80',
      description: 'Fully furnished and serviced short-let apartment in the Old GRA. Includes 24-hour power, water treatment and weekly housekeeping.',
      features: ['Fully Furnished', '24hr Power & Water', 'Serviced Weekly', 'Secure Estate']
    },
    {
      title: 'Executive 4 Bedroom Family Residence — Long Let',
      slug: 'executive-4bed-longlet-owerri',
      listingType: ListingType.LONG_LET,
      category: PropertyCategory.RESIDENTIAL,
      price: 4800000,
      state: 'Imo',
      location: 'Orji, Owerri',
      bedrooms: 4,
      bathrooms: 3,
      parkingSpaces: 2,
      landSize: '600 sqm',
      titleDocument: TitleDocumentType.GOVERNORS_CONSENT,
      mainImage: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1600&q=80',
      description: 'Detached family home on a minimum 5-year lease. Landlord maintains grounds, security and the generator.',
      features: ['Minimum 5-Year Term', 'Boys & Girls Quarters', 'Standby Generator', 'Estate Security']
    },
    {
      title: 'Grade A Office Space — Commercial Lease',
      slug: 'grade-a-office-lekki-lagos',
      listingType: ListingType.COMMERCIAL_LEASE,
      category: PropertyCategory.COMMERCIAL,
      price: 45000000,
      state: 'Lagos',
      location: 'Victoria Island, Lagos',
      bedrooms: 0,
      bathrooms: 4,
      parkingSpaces: 12,
      landSize: '1,400 sqm',
      titleDocument: TitleDocumentType.OTHER,
      mainImage: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1600&q=80',
      description: 'Grade A fitted-and-furnished office floor with lift access, dedicated power and 12 allocated parking bays.',
      features: ['4th Floor with Lift', '12 Parking Bays', 'Fitted & Furnished', 'Dedicated Power & HVAC']
    },
    {
      title: 'Bonded Warehouse & Factory Floor — Industrial Lease',
      slug: 'bonded-warehouse-aba',
      listingType: ListingType.INDUSTRIAL_LEASE,
      category: PropertyCategory.COMMERCIAL,
      price: 25000000,
      state: 'Abia',
      location: 'Aba North Industrial Layout',
      bedrooms: 0,
      bathrooms: 2,
      parkingSpaces: 8,
      landSize: '4,000 sqm',
      titleDocument: TitleDocumentType.REGISTERED_SURVEY_DEED,
      mainImage: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1600&q=80',
      description: 'Bonded warehouse and factory floor with 6m clear height, heavy-duty loading bays and bonded goods access.',
      features: ['6m Clear Height', 'Bonded Goods Access', '3 Loading Bays', '3-Phase Power']
    },
    {
      title: 'Off-Plan 4 Bedroom Terrace — Joint Venture',
      slug: 'off-plan-jv-terrace-abuja',
      listingType: ListingType.JOINT_VENTURE,
      category: PropertyCategory.OFF_PLAN,
      price: 110000000,
      state: 'Abuja',
      location: 'Guzape, Abuja (FCT)',
      bedrooms: 4,
      bathrooms: 4,
      parkingSpaces: 2,
      landSize: '400 sqm',
      titleDocument: TitleDocumentType.FCDA_ALLOCATION,
      mainImage: 'https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=1600&q=80',
      description: 'Off-plan units offered under a structured joint-venture agreement with milestone payments and a capital appreciation guarantee.',
      features: ['Flexible 18-Month Plan', 'Capital Appreciation Guarantee', 'Underground Utilities', 'Estate Sports Complex']
    },
    {
      title: '2 Bedroom Staff Quarters — Gated Development',
      slug: 'staff-quarters-guzape-abuja',
      listingType: ListingType.STAFF_QUARTERS,
      category: PropertyCategory.RESIDENTIAL,
      price: 2400000,
      state: 'Abuja',
      location: 'Guzape, Abuja (FCT)',
      bedrooms: 2,
      bathrooms: 2,
      parkingSpaces: 1,
      landSize: '150 sqm',
      titleDocument: TitleDocumentType.FCDA_ALLOCATION,
      mainImage: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1600&q=80',
      description: 'Newly completed staff quarters within a gated estate, walking distance to the site. Let in units of four.',
      features: ['Let in Units of 4', 'Gated Estate', 'Borehole & Solar', 'Near Site']
    },
    {
      title: '4 Bedroom Duplex — Distress Auction Sale',
      slug: '4bed-duplex-distress-ph',
      listingType: ListingType.DISTRESS_SALE,
      category: PropertyCategory.RESIDENTIAL,
      price: 62000000,
      state: 'Rivers',
      location: 'GRA Phase 2, Port Harcourt',
      bedrooms: 4,
      bathrooms: 4,
      parkingSpaces: 2,
      landSize: '500 sqm',
      titleDocument: TitleDocumentType.GOVERNORS_CONSENT,
      mainImage: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1600&q=80',
      description: 'Vacant possession recovered on a defaulted facility and offered by public auction. Reserve price applies.',
      features: ['Vacant Possession', 'Auction Reserve Price', 'Title Verified by East Gate', 'Legal & Advisory Available']
    },
    {
      title: '4 Bedroom Terrace — 10 Year Lease with Purchase Option',
      slug: '4bed-terrace-long-lease-abuja',
      listingType: ListingType.LONG_LEASE,
      category: PropertyCategory.RESIDENTIAL,
      price: 24000000,
      state: 'Abuja',
      location: 'Maitama, Abuja (FCT)',
      bedrooms: 4,
      bathrooms: 4,
      parkingSpaces: 2,
      landSize: '350 sqm',
      titleDocument: TitleDocumentType.C_OF_O,
      mainImage: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1600&q=80',
      description: 'Ten-year lease with a registered option to purchase at year 10. Rent fixed for five years before review.',
      features: ['10-Year Registered Lease', 'Option to Purchase', 'Fixed 5-Year Review', 'Maitama Address']
    }
  ];

  for (const row of purposeSeed) {
    await prisma.property.create({
      data: {
        dealerId: dealerProfile1.id,
        title: row.title,
        slug: row.slug,
        listingType: row.listingType,
        category: row.category,
        price: row.price,
        currency: 'NGN',
        state: row.state,
        location: row.location,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        parkingSpaces: row.parkingSpaces,
        landSize: row.landSize,
        titleDocument: row.titleDocument,
        isTitleVerified: true,
        mainImage: row.mainImage,
        description: row.description,
        features: row.features,
        status: ItemStatus.APPROVED,
        isFeatured: false
      }
    });
  }

  // 7. Create Marketplace Products
  // A. Admin Direct Official Products (status: APPROVED, isOfficial: true)
  await prisma.marketplaceProduct.create({
    data: {
      name: 'Dangote 42.5R Portland Limestone Cement (50kg)',
      category: 'Building Materials',
      price: 9500,
      stockInfo: 'In Stock (Warehouse delivery across SE/SS/Lagos)',
      mainImage: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
      specifications: 'Grade 42.5R high-early strength cement. Ideal for multi-story load-bearing structural columns, beams, and precast concrete.',
      isOfficial: true,
      status: ItemStatus.APPROVED
    }
  });

  await prisma.marketplaceProduct.create({
    data: {
      name: 'German Stone-Coated Roofing Tiles (Milano Profile)',
      category: 'Building Materials',
      price: 4800,
      stockInfo: '50-Year Warranty Guarantee',
      mainImage: 'https://images.unsplash.com/photo-1632759145351-1d592919f522?auto=format&fit=crop&w=800&q=80',
      specifications: 'Galvalume steel core with anti-fade basalt stone granules. Zero rust, acoustic rain dampening, fire resistant.',
      isOfficial: true,
      status: ItemStatus.APPROVED
    }
  });

  // B. Dealer Approved Products
  await prisma.marketplaceProduct.create({
    data: {
      dealerId: dealerProfile2.id,
      name: 'High-Density Vibrated Hollow Blocks (9-inch & 6-inch)',
      category: 'Building Materials',
      price: 650,
      stockInfo: 'Ready for batch delivery',
      mainImage: 'https://images.unsplash.com/photo-1590381105924-c72589b9ef3f?auto=format&fit=crop&w=800&q=80',
      specifications: 'Machine-vibrated 1:4 sharp sand to granite dust ratio. Rigorously tested for compressive strength.',
      isOfficial: false,
      status: ItemStatus.APPROVED
    }
  });

  // C. Dealer Pending Product (MANDATORY ADMIN APPROVAL RULE)
  await prisma.marketplaceProduct.create({
    data: {
      dealerId: dealerProfile2.id,
      name: 'Handcrafted Solid Teak 8-Seater Dining Suite',
      category: 'Home & Interior',
      price: 920000,
      stockInfo: 'Pending Admin Verification',
      mainImage: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?auto=format&fit=crop&w=800&q=80',
      specifications: 'Seasoned natural teak with natural organic oil finish.',
      isOfficial: false,
      status: ItemStatus.PENDING_REVIEW // HIDDEN UNTIL ADMIN APPROVES!
    }
  });

  // 8. Create Services
  await prisma.serviceOffering.create({
    data: {
      dealerId: dealerProfile1.id,
      title: 'Commercial Property & Facilities Management',
      category: 'Property',
      coverageState: 'South-East & Rivers',
      description: 'Stringent tenant vetting, rent collection automation, preventative HVAC maintenance, 24/7 emergency repair dispatch.',
      badges: ['East Gate Verified'],
      status: ItemStatus.APPROVED
    }
  });

  await prisma.serviceOffering.create({
    data: {
      dealerId: dealerProfile2.id,
      title: 'Turnkey Building Construction & General Contracting',
      category: 'Construction',
      coverageState: 'Nationwide',
      description: 'From virgin land excavation to final roof installation. Accountable timelines, milestone-based escrow payments, transparent site logs.',
      badges: ['CAC Verified'],
      status: ItemStatus.APPROVED
    }
  });

  await prisma.serviceOffering.create({
    data: {
      dealerId: dealerProfile2.id,
      title: 'Cadastral & Topographic Boundary Surveying',
      category: 'Professional',
      coverageState: 'Imo & Abia',
      description: 'GPS boundary delineation, registered beacon placement, lodgement with Surveyor General.',
      badges: ['Under Review'],
      status: ItemStatus.PENDING_REVIEW // HIDDEN UNTIL ADMIN APPROVES!
    }
  });

  // 9. Create Inspections
  await prisma.inspection.create({
    data: {
      userId: customer.id,
      propertyId: prop1.id,
      dealerId: dealerProfile1.id,
      date: new Date('2026-10-14'),
      timeSlot: '02:00 PM – 03:30 PM',
      status: InspectionStatus.CONFIRMED,
      clientNotes: 'Client requested physical on-site walk-through with an independent engineer.',
      dealerNotes: 'Confirmed. Lead surveyor Engr. Chinedu will attend with original C of O file.'
    }
  });

  // 10. Create Audit Logs
  await prisma.auditLog.createMany({
    data: [
      {
        adminId: admin.id,
        action: 'VERIFY_DEALER',
        targetEntity: 'DealerProfile',
        targetId: dealerProfile1.id,
        targetName: 'John Properties Ltd',
        details: 'Approved Identity, CAC, and Title documentation credentials.',
        timestamp: new Date('2026-10-01T14:15:22Z')
      },
      {
        adminId: admin.id,
        action: 'APPROVE_PROPERTY',
        targetEntity: 'Property',
        targetId: prop2.id,
        targetName: 'Contemporary 3 Bedroom Apartment (Owerri)',
        details: 'Verified Governor’s Consent file before clearing for public view.',
        timestamp: new Date('2026-10-01T14:32:09Z')
      },
      {
        adminId: admin.id,
        action: 'ADMIN_CREATE_PRODUCT',
        targetEntity: 'MarketplaceProduct',
        targetId: 'prod_cement_01',
        targetName: 'Dangote 42.5R Portland Limestone Cement',
        details: 'Admin published direct official East Gate inventory.',
        timestamp: new Date('2026-10-01T15:00:00Z')
      }
    ]
  });

  console.log('Database seeded successfully with Nigerian property dataset!');
  console.log('Demo logins:');
  console.log(`  ${ADMIN_EMAIL}               / (ADMIN_SEED_PASSWORD — not printed)`);
  console.log(`  dealer@johnproperties.ng   / ${DEMO_PASSWORDS.dealer}`);
  console.log(`  apex@apexbuilders.ng       / ${DEMO_PASSWORDS.apex}`);
  console.log(`  jay@example.com            / ${DEMO_PASSWORDS.customer}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
