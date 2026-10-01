import { PrismaClient, Role, VerificationStatus, ItemStatus, ListingType, PropertyCategory, TitleDocumentType, InspectionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding East Gate production database...');

  // Clean existing tables
  await prisma.auditLog.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.savedListing.deleteMany();
  await prisma.report.deleteMany();
  await prisma.verificationDoc.deleteMany();
  await prisma.property.deleteMany();
  await prisma.marketplaceProduct.deleteMany();
  await prisma.serviceOffering.deleteMany();
  await prisma.dealerProfile.deleteMany();
  await prisma.user.deleteMany();

  // 1. Create Super Admin
  const admin = await prisma.user.create({
    data: {
      email: 'admin@eastgate.ng',
      phone: '+234 809 000 8888',
      fullName: 'Sarah Alabi',
      passwordHash: 'argon2_or_bcrypt_hash_placeholder',
      role: Role.SUPER_ADMIN
    }
  });

  // 2. Create Normal User (Customer)
  const customer = await prisma.user.create({
    data: {
      email: 'jay@example.com',
      phone: '+234 803 123 4567',
      fullName: 'Jay Nwosu',
      passwordHash: 'customer_password_hash',
      role: Role.CUSTOMER
    }
  });

  // 3. Create Verified Dealer: John Properties Ltd
  const dealerUser1 = await prisma.user.create({
    data: {
      email: 'dealer@johnproperties.ng',
      phone: '+234 802 987 6543',
      fullName: 'Chief John Okafor',
      passwordHash: 'dealer_password_hash',
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
      passwordHash: 'apex_password_hash',
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
      listingType: ListingType.LAND,
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
