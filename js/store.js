/**
 * East Gate Platform — Central State Store & Database Engine
 * Handles Users, Roles, Properties, Marketplace, Services, Verification, Inspections, Moderation & Audit Logs.
 */
(function (window) {
  'use strict';

  // v2 — listing types moved from Title-Case ('Buy') to ListingType enum members
  // ('BUY') and the catalogue gained rental/lease/auction properties. Bump this
  // key whenever defaultData changes shape, or returning visitors keep serving
  // their stale copy out of localStorage and never see the new rows.
  var STORAGE_KEY = 'east_gate_db_v2';

  var defaultData = {
    currentUser: {
      id: 'usr_jay',
      name: 'Jay Nwosu',
      email: 'jay@example.com',
      phone: '+234 803 123 4567',
      role: 'CUSTOMER', // 'CUSTOMER', 'DEALER', 'ADMIN'
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
    },
    users: [
      {
        id: 'usr_jay',
        name: 'Jay Nwosu',
        email: 'jay@example.com',
        phone: '+234 803 123 4567',
        role: 'CUSTOMER',
        saved: ['89bc3c5d-11d8-48b5-bf87-9b95018ae8fd', 'e86dffae-0a6e-4a93-b458-336366ec9536']
      },
      {
        id: 'ee050f69-b910-435c-898f-00f298708968',
        name: 'John Properties Ltd',
        email: 'dealer@johnproperties.ng',
        phone: '+234 802 987 6543',
        role: 'DEALER',
        cac: 'RC-1849204',
        category: 'Real Estate Company',
        verificationStatus: 'VERIFIED',
        badges: { identity: true, cac: true, phone: true, titleDocs: true },
        rating: 4.9,
        reviewsCount: 38
      },
      {
        id: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        name: 'Apex Build & Construction',
        email: 'apex@apexbuilders.ng',
        phone: '+234 814 555 1234',
        role: 'DEALER',
        cac: 'RC-2039481',
        category: 'Contractor & Building Supplier',
        verificationStatus: 'UNDER_REVIEW',
        badges: { identity: true, cac: false, phone: true, titleDocs: false },
        rating: 4.7,
        reviewsCount: 14
      },
      {
        id: 'usr_admin_sarah',
        name: 'Administration',
        email: 'admin@eastgate.com',
        phone: '+234 809 000 8888',
        role: 'ADMIN',
        adminRole: 'SUPER_ADMIN'
      }
    ],
    properties: [
      {
        id: '89bc3c5d-11d8-48b5-bf87-9b95018ae8fd',
        title: 'Modern 4 Bedroom Villa',
        slug: 'modern-4-bedroom-villa-aba',
        category: 'Residential',
        listingType: 'BUY',
        price: 85000000,
        priceDisplay: 'Request for Quote',
        location: 'Aba, Abia State',
        state: 'Abia',
        beds: 4,
        baths: 5,
        cars: 2,
        landSize: '650 sqm',
        titleDoc: 'Certificate of Occupancy (C of O)',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: true,
        description: 'Impeccably finished architectural masterpiece situated in a serene, secured residential enclave. Features an expansive formal living room, custom chef’s kitchen with imported marble countertops, smart home lighting, dedicated laundry, staff quarters, and lush landscaped garden.',
        features: ['Solar Power Inverter', 'Borehole with Industrial Filter', 'CCTV & Electric Fence', 'Fitted Italian Kitchen', 'En-suite Bedrooms']
      },
      {
        id: '1ae3a47f-5265-42e4-bf7f-dbbdb7ef05c6',
        title: 'Contemporary 3 Bedroom Apartment',
        slug: 'contemporary-3-bedroom-apartment-owerri',
        category: 'Residential',
        listingType: 'BUY',
        price: 42500000,
        priceDisplay: 'Request for Quote',
        location: 'Owerri, Imo State',
        state: 'Imo',
        beds: 3,
        baths: 3,
        cars: 1,
        landSize: '320 sqm',
        titleDoc: "Governor's Consent",
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: true,
        description: 'Sophisticated open-concept apartment in prime New Owerri. Featuring floor-to-ceiling soundproof acoustic windows, ambient recessed lighting, polished porcelain tiles, and a private balcony with panoramic sunset vistas.',
        features: ['24/7 Security Patrol', 'Access Controlled Gate', 'High-Speed Fiber Ready', 'Gym & Clubhouse', 'Dedicated Transformer']
      },
      {
        id: 'e86dffae-0a6e-4a93-b458-336366ec9536',
        title: 'Executive 5 Bedroom Detached Duplex',
        slug: 'executive-5-bedroom-duplex-port-harcourt',
        category: 'Residential',
        listingType: 'BUY',
        price: 150000000,
        priceDisplay: 'Request for Quote',
        location: 'GRA Phase 2, Port Harcourt',
        state: 'Rivers',
        beds: 5,
        baths: 6,
        cars: 4,
        landSize: '900 sqm',
        titleDoc: 'Certificate of Occupancy (C of O)',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: true,
        description: 'Grand executive estate built to the highest European structural standards. Offers sweeping double-volume foyer, private cinema room, rooftop cocktail terrace, Olympic-standard perimeter security, and dual automated vehicular gates.',
        features: ['Private Cinema Room', 'Swimming Pool Ready', 'Automated Gates', 'Smart Climate Control', 'Dual BQ Staff Quarters']
      },
      {
        id: '5003022d-302a-4015-97e3-7457eb49cc55',
        title: '2 Plots Prime Commercial Land',
        slug: 'prime-commercial-land-aba',
        category: 'Land',
        listingType: 'LAND_BANKING',
        price: 35000000,
        priceDisplay: 'Request for Quote',
        location: 'Enugu Expressway, Aba',
        state: 'Abia',
        beds: 0,
        baths: 0,
        cars: 0,
        landSize: '1,350 sqm',
        titleDoc: 'Registered Survey & Deed of Conveyance',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1600&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'High-visibility corner plot directly along the commercial thoroughfare. 100% dry, level topography with comprehensive beacons in place. Ideal for corporate headquarters, distribution warehouse, or hospitality development.',
        features: ['100% Dry Table Land', 'High Traffic Frontage', 'Instant Allocation', 'Registered Beacons', 'Free of Encumbrances']
      },
      {
        id: 'prop_5',
        title: 'Luxury 4 Bedroom Waterfront Penthouse',
        slug: 'luxury-penthouse-lagos',
        category: 'Luxury',
        listingType: 'BUY',
        price: 280000000,
        priceDisplay: 'Request for Quote',
        location: 'Victoria Island, Lagos',
        state: 'Lagos',
        beds: 4,
        baths: 5,
        cars: 3,
        landSize: '580 sqm',
        titleDoc: 'Federal Certificate of Occupancy',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1613490493576-7fde63acd811?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: true,
        description: 'Breathtaking high-rise penthouse overlooking the lagoon. Features wrap-around infinity terrace, private internal elevator, Miele integrated kitchen, master suite with steam bath and walk-in dressing salon.',
        features: ['Lagoon Skyline Views', 'Private Elevator Key', 'Concierge & Valet', 'Heated Infinity Pool', 'Helipad Access Nearby']
      },
      {
        id: 'prop_6',
        title: 'Off-Plan 4 Bedroom Terrace Duplex',
        slug: 'off-plan-terrace-abuja',
        category: 'Off-Plan',
        listingType: 'JOINT_VENTURE',
        price: 110000000,
        priceDisplay: 'Request for Quote',
        location: 'Guzape, Abuja (FCT)',
        state: 'Abuja',
        beds: 4,
        baths: 4,
        cars: 2,
        landSize: '400 sqm',
        titleDoc: 'FCDA Allocation & Approved Building Plan',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        dealerName: 'Apex Build & Construction',
        dealerVerified: false,
        status: 'APPROVED',
        featured: false,
        description: 'Early-stage investment opportunity with structured 18-month flexible milestone payments. Contemporary brutalist architecture with cantilevered balconies, energy-efficient glazing, and solar infrastructure.',
        features: ['Flexible 18-Month Plan', 'Capital Appreciation Guarantee', 'Underground Utilities', 'Estate Sports Complex']
      },
      {
        id: 'prop_7',
        title: 'Executive 5 Bedroom Villa with Swimming Pool',
        slug: 'executive-5-bed-villa-enugu',
        category: 'Luxury',
        listingType: 'BUY',
        price: 185000000,
        priceDisplay: 'Request for Quote',
        location: 'Independence Layout, Enugu',
        state: 'Enugu',
        beds: 5,
        baths: 6,
        cars: 4,
        landSize: '1,100 sqm',
        titleDoc: 'State C of O',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        dealerName: 'Apex Build & Construction',
        dealerVerified: false,
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN FIRST
        featured: false,
        description: 'Newly submitted estate awaiting compliance verification. Premium finishes, private pool, smart automation.',
        features: ['Olympic Swimming Pool', 'Gym House', 'Solar Inverter 15kVA']
      },
      {
        id: 'prop_8',
        title: 'Furnished 3 Bedroom Apartment — Short Let',
        slug: 'furnished-3bed-shortlet-aba',
        category: 'Residential',
        listingType: 'SHORT_LET',
        price: 3500000,
        priceDisplay: '₦3,500,000 / year',
        location: 'Old GRA, Aba, Abia State',
        state: 'Abia',
        beds: 3,
        baths: 2,
        cars: 1,
        landSize: '220 sqm',
        titleDoc: 'Certificate of Occupancy (C of O)',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Fully furnished and serviced short-let apartment in the Old GRA. Includes 24-hour power, water treatment, and weekly housekeeping.',
        features: ['Fully Furnished', '24hr Power & Water', 'Serviced Weekly', 'Secure Estate']
      },
      {
        id: 'prop_9',
        title: 'Executive 4 Bedroom Family Residence — Long Let',
        slug: 'executive-4bed-longlet-owerri',
        category: 'Residential',
        listingType: 'LONG_LET',
        price: 4800000,
        priceDisplay: '₦4,800,000 / year',
        location: 'Orji, Owerri, Imo State',
        state: 'Imo',
        beds: 4,
        baths: 3,
        cars: 2,
        landSize: '600 sqm',
        titleDoc: 'Governor\'s Consent',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Detached family home available on a minimum 5-year lease. Landlord maintains grounds, security and the generator; tenant handles utilities.',
        features: ['Minimum 5-Year Term', 'Boys\' & Girls\' Quarters', 'Standby Generator', 'Estate Security']
      },
      {
        id: 'prop_10',
        title: 'Grade A Office Space — Commercial Lease',
        slug: 'grade-a-office-lekki-lagos',
        category: 'Commercial',
        listingType: 'COMMERCIAL_LEASE',
        price: 45000000,
        priceDisplay: '₦45,000,000 / year',
        location: 'Victoria Island, Lagos',
        state: 'Lagos',
        beds: 0,
        baths: 4,
        cars: 12,
        landSize: '1,400 sqm',
        titleDoc: 'Governance Lease / Consent',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Grade A fitted-and-furnished office floor on the 4th level with lift access, dedicated power, and 12 allocated parking bays. Suitable for corporate HQ or a professional firm.',
        features: ['4th Floor with Lift', '12 Parking Bays', 'Fitted & Furnished', 'Dedicated Power & HVAC']
      },
      {
        id: 'prop_11',
        title: 'Bonded Warehouse & Factory Floor — Industrial Lease',
        slug: 'bonded-warehouse-aba',
        category: 'Commercial',
        listingType: 'INDUSTRIAL_LEASE',
        price: 25000000,
        priceDisplay: '₦25,000,000 / year',
        location: 'Aba North Industrial Layout, Abia State',
        state: 'Abia',
        beds: 0,
        baths: 2,
        cars: 8,
        landSize: '4,000 sqm',
        titleDoc: 'Registered Survey Deed',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Bonded warehouse and factory floor with 6m clear height, heavy-duty loading bays, and bonded goods access. Suitable for manufacturing, cold storage, or distribution.',
        features: ['6m Clear Height', 'Bonded Goods Access', '3 Loading Bays', '3-Phase Power']
      },
      {
        id: 'prop_12',
        title: '2 Bedroom Staff Quarters — Gated Development',
        slug: 'staff-quarters-guzape-abuja',
        category: 'Residential',
        listingType: 'STAFF_QUARTERS',
        price: 2400000,
        priceDisplay: '₦2,400,000 / year',
        location: 'Guzape, Abuja (FCT)',
        state: 'Abuja',
        beds: 2,
        baths: 2,
        cars: 1,
        landSize: '150 sqm',
        titleDoc: 'FCDA Allocation & Approved Building Plan',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        dealerName: 'Apex Build & Construction',
        dealerVerified: false,
        status: 'APPROVED',
        featured: false,
        description: 'Newly completed staff quarters within a gated estate, walking distance to the site. Let in units of four or the whole block.',
        features: ['Let in Units of 4', 'Gated Estate', 'Borehole & Solar', 'Near Site']
      },
      {
        id: 'prop_13',
        title: '4 Bedroom Duplex — Distress Auction Sale',
        slug: '4bed-duplex-distress-ph',
        category: 'Residential',
        listingType: 'DISTRESS_SALE',
        price: 62000000,
        priceDisplay: '₦62,000,000 (auction reserve)',
        location: 'GRA Phase 2, Port Harcourt, Rivers State',
        state: 'Rivers',
        beds: 4,
        baths: 4,
        cars: 2,
        landSize: '500 sqm',
        titleDoc: 'Governance Lease / Consent',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Vacant possession recovered on a defaulted facility and offered by public auction. Title documents verified by East Gate; reserve price applies.',
        features: ['Vacant Possession', 'Auction Reserve Price', 'Title Verified by East Gate', 'Legal & Advisory Available']
      },
      {
        id: 'prop_14',
        title: '4 Bedroom Terrace — 10 Year Lease with Purchase Option',
        slug: '4bed-terrace-long-lease-abuja',
        category: 'Residential',
        listingType: 'LONG_LEASE',
        price: 24000000,
        priceDisplay: '₦24,000,000 / year',
        location: 'Maitama, Abuja (FCT)',
        state: 'Abuja',
        beds: 4,
        baths: 4,
        cars: 2,
        landSize: '350 sqm',
        titleDoc: 'Certificate of Occupancy (C of O)',
        verifiedTitle: true,
        image: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1200&q=80',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        dealerVerified: true,
        status: 'APPROVED',
        featured: false,
        description: 'Ten-year lease with a registered option to purchase at year 10. Rent is fixed for the term with a 5-year review; the option price is indexed and stated in the lease deed.',
        features: ['10-Year Registered Lease', 'Option to Purchase', 'Fixed 5-Year Review', 'Maitama Address']
      }
    ],
    marketplaceProducts: [
      {
        id: 'prod_1',
        name: 'Dangote 42.5R Portland Limestone Cement (50kg)',
        category: 'Building Materials',
        price: 9500,
        priceDisplay: 'Request for Quote',
        vendor: 'East Gate Direct (Official)',
        isOfficial: true,
        image: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
        stock: 'In Stock (Warehouse delivery across SE/SS/Lagos)',
        status: 'APPROVED',
        specs: 'Grade 42.5R high-early strength cement. Ideal for multi-story load-bearing structural columns, beams, and precast concrete.'
      },
      {
        id: 'prod_2',
        name: 'High-Density Vibrated Hollow Blocks (9-inch & 6-inch)',
        category: 'Building Materials',
        price: 650,
        priceDisplay: 'Request for Quote',
        vendor: 'Apex Concrete Works',
        isOfficial: false,
        image: 'https://images.unsplash.com/photo-1590381105924-c72589b9ef3f?auto=format&fit=crop&w=800&q=80',
        stock: 'Ready for batch delivery',
        status: 'APPROVED',
        specs: 'Machine-vibrated 1:4 sharp sand to granite dust ratio. Rigorously tested for compressive strength and thermal insulation.'
      },
      {
        id: 'prod_3',
        name: 'German Stone-Coated Roofing Tiles (Milano Profile)',
        category: 'Building Materials',
        price: 4800,
        priceDisplay: 'Request for Quote',
        vendor: 'East Gate Direct (Official)',
        isOfficial: true,
        image: 'https://images.unsplash.com/photo-1632759145351-1d592919f522?auto=format&fit=crop&w=800&q=80',
        stock: '50-Year Warranty Guarantee',
        status: 'APPROVED',
        specs: 'Galvalume steel core with anti-fade basalt stone granules. Zero rust, acoustic rain dampening, fire resistant.'
      },
      {
        id: 'prod_4',
        name: 'Luxury Italian Velvet Chesterfield 7-Seater Suite',
        category: 'Home & Interior',
        price: 1850000,
        priceDisplay: 'Request for Quote',
        vendor: 'Maison Living Co.',
        isOfficial: false,
        image: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80',
        stock: 'Custom made to order (14 days)',
        status: 'APPROVED',
        specs: 'Hardwood mahogany kiln-dried frame, high-resilience foam cushioning, stain-resistant royal velvet fabric with brass nailheads.'
      },
      {
        id: 'prod_5',
        name: 'Heavy-Duty Reversible Concrete Mixer (500 Liters, Diesel)',
        category: 'Equipment',
        price: 2400000,
        priceDisplay: 'Request for Quote',
        vendor: 'Apex Machinery & Plant Hire',
        isOfficial: false,
        image: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=800&q=80',
        stock: 'Available for purchase & lease',
        status: 'APPROVED',
        specs: 'Equipped with heavy water-cooled diesel engine, hydraulic tipping hopper, rugged all-terrain towing wheels.'
      },
      {
        id: 'prod_6',
        name: 'Handcrafted Solid Teak 8-Seater Dining Suite',
        category: 'Home & Interior',
        price: 920000,
        priceDisplay: 'Request for Quote',
        vendor: 'Heritage Woods Ltd',
        isOfficial: false,
        image: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?auto=format&fit=crop&w=800&q=80',
        stock: 'Pending Admin Verification',
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN FIRST
        specs: 'Seasoned natural teak with natural organic oil finish.'
      }
    ],
    services: [
      {
        id: 'srv_1',
        title: 'Architectural Master Planning & 3D Virtualization',
        category: 'Design',
        providerName: 'Studio Archaea',
        state: 'Enugu & Lagos',
        rating: 4.9,
        reviewsCount: 29,
        status: 'APPROVED',
        description: 'Award-winning sustainable architectural blueprints tailored for tropical climates, maximizing natural cross-ventilation and daylighting.',
        badges: ['East Gate Verified', 'NIA Registered']
      },
      {
        id: 'srv_2',
        title: 'Civil & Structural Engineering Consulting',
        category: 'Construction',
        providerName: 'Engr. Emeka & Partners Ltd',
        state: 'Aba & Port Harcourt',
        rating: 4.8,
        reviewsCount: 42,
        status: 'APPROVED',
        description: 'Comprehensive soil tests, foundation engineering, raft design, and structural calculation reports compliant with COREN guidelines.',
        badges: ['East Gate Verified', 'COREN Certified']
      },
      {
        id: 'srv_3',
        title: 'Turnkey Building Construction & General Contracting',
        category: 'Construction',
        providerName: 'Apex Build & Construction',
        state: 'Nationwide',
        rating: 4.7,
        reviewsCount: 19,
        status: 'APPROVED',
        description: 'From virgin land excavation to final roof installation. Accountable timelines, milestone-based escrow payments, transparent site logs.',
        badges: ['CAC Verified']
      },
      {
        id: 'srv_4',
        title: 'High-End Residential Interior Architecture',
        category: 'Design',
        providerName: 'Maison De Luxe Interiors',
        state: 'Lagos & Abuja',
        rating: 5.0,
        reviewsCount: 31,
        status: 'APPROVED',
        description: 'Full-scope bespoke interior turnkey execution: bespoke joinery, bespoke lighting schemes, acoustics, and luxury soft furnishings.',
        badges: ['East Gate Verified', 'Premier Partner']
      },
      {
        id: 'srv_5',
        title: 'Commercial Property & Facilities Management',
        category: 'Property',
        providerName: 'John Properties Ltd',
        state: 'South-East & Rivers',
        rating: 4.9,
        reviewsCount: 47,
        status: 'APPROVED',
        description: 'Stringent tenant vetting, rent collection automation, preventative HVAC maintenance, 24/7 emergency repair dispatch.',
        badges: ['East Gate Verified']
      },
      {
        id: 'srv_6',
        title: 'Cadastral & Topographic Boundary Surveying',
        category: 'Professional',
        providerName: 'GeoMetrics Nig. Ltd',
        state: 'Imo & Abia',
        rating: 4.6,
        reviewsCount: 8,
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN FIRST
        description: 'GPS boundary delineation, registered beacon placement, lodgement with Surveyor General.',
        badges: ['Under Review']
      }
    ],
    inspections: [
      {
        id: 'insp_101',
        userId: 'usr_jay',
        userName: 'Jay Nwosu',
        userPhone: '+234 803 123 4567',
        propertyId: '89bc3c5d-11d8-48b5-bf87-9b95018ae8fd',
        propertyTitle: 'Modern 4 Bedroom Villa',
        propertyLocation: 'Aba, Abia State',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        date: '2026-10-14',
        time: '02:00 PM',
        status: 'CONFIRMED', // 'PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'
        notes: 'Client requested physical on-site walk-through with an independent engineer.'
      },
      {
        id: 'insp_102',
        userId: 'usr_jay',
        userName: 'Jay Nwosu',
        userPhone: '+234 803 123 4567',
        propertyId: 'e86dffae-0a6e-4a93-b458-336366ec9536',
        propertyTitle: 'Executive 5 Bedroom Detached Duplex',
        propertyLocation: 'GRA Phase 2, Port Harcourt',
        dealerId: 'ee050f69-b910-435c-898f-00f298708968',
        dealerName: 'John Properties Ltd',
        date: '2026-10-19',
        time: '11:00 AM',
        status: 'PENDING',
        notes: 'Inquiry regarding power availability and water pressure.'
      }
    ],
    verifications: [
      {
        id: 'ver_201',
        dealerId: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        dealerName: 'Apex Build & Construction',
        dimension: 'CAC_BUSINESS',
        documentName: 'CAC_Incorporation_RC2039481.pdf',
        documentUrl: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=600&q=80',
        submittedAt: '2026-10-01 10:30',
        status: 'PENDING',
        notes: 'Awaiting compliance officer review.'
      },
      {
        id: 'ver_202',
        dealerId: 'beaa266f-c9f9-4147-ba21-fdc2fd011479',
        dealerName: 'Apex Build & Construction',
        dimension: 'TITLE_DOCUMENTS',
        documentName: 'Deed_Of_Conveyance_Apex_Plot.pdf',
        documentUrl: 'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=600&q=80',
        submittedAt: '2026-10-01 11:15',
        status: 'PENDING',
        notes: 'Survey beacon verification required.'
      }
    ],
    reports: [
      {
        id: 'rep_301',
        reporter: 'Chidi E.',
        targetType: 'PROPERTY',
        targetId: '1ae3a47f-5265-42e4-bf7f-dbbdb7ef05c6',
        targetTitle: 'Contemporary 3 Bedroom Apartment',
        reason: 'Price discrepancy reported compared to signpost on site',
        status: 'PENDING',
        submittedAt: '2026-10-01 12:45'
      }
    ],
    auditLogs: [
      {
        id: 'aud_401',
        adminName: 'Administration (Super Admin)',
        action: 'VERIFY_DEALER',
        target: 'John Properties Ltd',
        details: 'Approved Identity, CAC, and Title documentation credentials.',
        timestamp: '2026-10-01 14:15:22'
      },
      {
        id: 'aud_402',
        adminName: 'Administration (Super Admin)',
        action: 'APPROVE_LISTING',
        target: 'Contemporary 3 Bedroom Apartment (Owerri)',
        details: 'Verified Governor’s Consent file before clearing for public view.',
        timestamp: '2026-10-01 14:32:09'
      },
      {
        id: 'aud_403',
        adminName: 'Administration (Super Admin)',
        action: 'ADMIN_CREATE_PRODUCT',
        target: 'Dangote 42.5R Portland Limestone Cement',
        details: 'Admin published direct official East Gate inventory.',
        timestamp: '2026-10-01 15:00:00'
      }
    ]
  };

  // Load from LocalStorage or initialize with default data
  function loadDatabase() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('LocalStorage unavailable, using in-memory store', e);
    }
    saveDatabase(defaultData);
    return JSON.parse(JSON.stringify(defaultData));
  }

  function saveDatabase(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Error saving to LocalStorage', e);
    }
  }

  var db = loadDatabase();

  window.EastGateDB = {
    get: function () {
      return db;
    },
    reset: function () {
      db = JSON.parse(JSON.stringify(defaultData));
      saveDatabase(db);
      return db;
    },

    // Persona Switching
    switchUser: function (role) {
      var found = db.users.filter(function (u) { return u.role === role; })[0];
      if (found) {
        db.currentUser = {
          id: found.id,
          name: found.name,
          email: found.email,
          phone: found.phone,
          role: found.role
        };
        saveDatabase(db);
      }
      return db.currentUser;
    },

    // Adopt an authenticated account (from /api/auth/login) as the active user
    setCurrentUser: function (user) {
      if (!user || !user.id) return db.currentUser;
      db.currentUser = {
        id: user.id,
        name: user.name || user.fullName || '',
        email: user.email || '',
        phone: user.phone || '',
        role: user.role || 'CUSTOMER',
        avatar: user.avatar || db.currentUser.avatar
      };
      saveDatabase(db);
      return db.currentUser;
    },
    toggleSaveProperty: function (propId) {
      var user = db.users.find(function (u) { return u.id === db.currentUser.id; });
      if (!user) return false;
      user.saved = user.saved || [];
      var idx = user.saved.indexOf(propId);
      var isSaved = false;
      if (idx > -1) {
        user.saved.splice(idx, 1);
        isSaved = false;
      } else {
        user.saved.push(propId);
        isSaved = true;
      }
      saveDatabase(db);
      return isSaved;
    },

    isPropertySaved: function (propId) {
      var user = db.users.find(function (u) { return u.id === db.currentUser.id; });
      return user && user.saved ? user.saved.indexOf(propId) > -1 : false;
    },

    // Schedule Inspection
    bookInspection: function (booking) {
      var payload = {
        propertyId: booking.propertyId,
        dealerId: booking.dealerId,
        date: booking.date,
        timeSlot: booking.time || booking.timeSlot,
        clientNotes: booking.notes || booking.clientNotes || 'Inspection requested via website'
      };

      if (!window.EastGateAPI || !window.EastGateAPI.bookInspection) {
        console.error('EastGateAPI.bookInspection is not available');
        throw new Error('API unavailable');
      }

      return window.EastGateAPI.bookInspection(payload).then(function (res) {
        if (!res || !res.success) {
          throw new Error(res && res.error ? res.error : 'Failed to book inspection');
        }
        var data = res.data || {};
        var newInspection = {
          id: data.id || 'insp_' + Date.now(),
          userId: db.currentUser.id,
          userName: booking.name || db.currentUser.name,
          userPhone: booking.phone || db.currentUser.phone,
          propertyId: data.propertyId || payload.propertyId,
          propertyTitle: booking.propertyTitle || data.property?.title,
          propertyLocation: booking.propertyLocation || data.property?.location,
          dealerId: data.dealerId || payload.dealerId,
          dealerName: booking.dealerName || data.dealer?.businessName,
          date: booking.date,
          time: booking.time || payload.timeSlot,
          status: 'PENDING',
          notes: payload.clientNotes
        };
        db.inspections.unshift(newInspection);
        saveDatabase(db);
        return newInspection;
      });
    },

    // DEALER ACTIONS (Submitted items default to PENDING_REVIEW)
    dealerSubmitListing: function (listing) {
      // Same shape the API writes: cover image first, then the gallery. The
      // offline store only ever receives URLs (file uploads need the server),
      // so this stays small enough for localStorage.
      var gallery = Array.isArray(listing.galleryImages) ? listing.galleryImages.slice(0, 12) : [];
      var cover = listing.mainImage || listing.image || gallery[0];

      var newListing = {
        id: 'prop_' + Date.now(),
        title: listing.title,
        slug: listing.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        category: listing.category || 'Residential',
        listingType: listing.listingType || 'BUY',
        price: Number(listing.price),
        priceDisplay: 'Request for Quote',
        location: listing.location,
        state: listing.state || 'Abia',
        beds: Number(listing.beds || 0),
        baths: Number(listing.baths || 0),
        cars: Number(listing.cars || 0),
        landSize: listing.landSize || '500 sqm',
        titleDoc: listing.titleDoc || 'Certificate of Occupancy',
        verifiedTitle: false,
        image: cover || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        mainImage: cover || 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1200&q=80',
        galleryImages: gallery,
        dealerId: db.currentUser.id,
        dealerName: db.currentUser.name,
        dealerVerified: false,
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN
        featured: false,
        description: listing.description || 'Listing submitted by dealer. Under review by East Gate.',
        features: listing.features || ['Verified Beacons', '24/7 Security']
      };
      db.properties.unshift(newListing);
      saveDatabase(db);
      return newListing;
    },

    dealerSubmitProduct: function (product) {
      var newProduct = {
        id: 'prod_' + Date.now(),
        name: product.name,
        category: product.category || 'Building Materials',
        price: Number(product.price),
        priceDisplay: 'Request for Quote',
        vendor: db.currentUser.name,
        isOfficial: false,
        image: product.image || 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=800&q=80',
        stock: product.stock || 'In Stock',
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN
        specs: product.specs || 'Product submitted by vendor.'
      };
      db.marketplaceProducts.unshift(newProduct);
      saveDatabase(db);
      return newProduct;
    },

    dealerSubmitService: function (service) {
      var newService = {
        id: 'srv_' + Date.now(),
        title: service.title,
        category: service.category || 'Construction',
        providerName: db.currentUser.name,
        state: service.state || 'Nationwide',
        rating: 5.0,
        reviewsCount: 0,
        status: 'PENDING_REVIEW', // MUST BE APPROVED BY ADMIN
        description: service.description || 'Service offered by verified specialist.',
        badges: ['Under Review']
      };
      db.services.unshift(newService);
      saveDatabase(db);
      return newService;
    },

    // ADMIN ACTIONS: DIRECT PRODUCT CREATION (Auto-Approved Official Product)
    adminCreateProduct: function (product) {
      var officialProduct = {
        id: 'prod_' + Date.now(),
        name: product.name,
        category: product.category || 'Building Materials',
        price: Number(product.price),
        priceDisplay: 'Request for Quote',
        vendor: 'East Gate Direct (Official)',
        isOfficial: true,
        image: product.image || 'https://images.unsplash.com/photo-1632759145351-1d592919f522?auto=format&fit=crop&w=800&q=80',
        stock: product.stock || 'Direct Warehousing & Delivery',
        status: 'APPROVED', // IMMEDIATELY APPROVED
        specs: product.specs || 'Official East Gate certified housing materials.'
      };
      db.marketplaceProducts.unshift(officialProduct);

      // Record in audit log
      db.auditLogs.unshift({
        id: 'aud_' + Date.now(),
        adminName: db.currentUser.name + ' (Admin)',
        action: 'ADMIN_CREATE_PRODUCT',
        target: officialProduct.name,
        details: 'Admin published direct official marketplace product.',
        timestamp: new Date().toLocaleString()
      });

      saveDatabase(db);
      return officialProduct;
    },

    // ADMIN APPROVAL QUEUE: Approving items
    adminApproveItem: function (type, id) {
      var targetName = '';
      if (type === 'property') {
        var prop = db.properties.find(function (p) { return p.id === id; });
        if (prop) {
          prop.status = 'APPROVED';
          targetName = prop.title;
        }
      } else if (type === 'product') {
        var prod = db.marketplaceProducts.find(function (p) { return p.id === id; });
        if (prod) {
          prod.status = 'APPROVED';
          targetName = prod.name;
        }
      } else if (type === 'service') {
        var srv = db.services.find(function (s) { return s.id === id; });
        if (srv) {
          srv.status = 'APPROVED';
          targetName = srv.title;
        }
      }

      // Record in audit log
      db.auditLogs.unshift({
        id: 'aud_' + Date.now(),
        adminName: db.currentUser.name + ' (Admin)',
        action: 'APPROVE_' + type.toUpperCase(),
        target: targetName || id,
        details: 'Admin reviewed and approved item for live public viewing.',
        timestamp: new Date().toLocaleString()
      });

      saveDatabase(db);
      return true;
    },

    // ADMIN REJECT ITEM
    adminRejectItem: function (type, id, reason) {
      var targetName = '';
      if (type === 'property') {
        var prop = db.properties.find(function (p) { return p.id === id; });
        if (prop) {
          prop.status = 'REJECTED';
          targetName = prop.title;
        }
      } else if (type === 'product') {
        var prod = db.marketplaceProducts.find(function (p) { return p.id === id; });
        if (prod) {
          prod.status = 'REJECTED';
          targetName = prod.name;
        }
      } else if (type === 'service') {
        var srv = db.services.find(function (s) { return s.id === id; });
        if (srv) {
          srv.status = 'REJECTED';
          targetName = srv.title;
        }
      }

      // Record in audit log
      db.auditLogs.unshift({
        id: 'aud_' + Date.now(),
        adminName: db.currentUser.name + ' (Admin)',
        action: 'REJECT_' + type.toUpperCase(),
        target: targetName || id,
        details: 'Reason: ' + (reason || 'Did not meet compliance criteria'),
        timestamp: new Date().toLocaleString()
      });

      saveDatabase(db);
      return true;
    },

    // ADMIN VERIFY DEALER DOCUMENT
    adminVerifyDealerDoc: function (verId) {
      var record = db.verifications.find(function (v) { return v.id === verId; });
      if (record) {
        record.status = 'APPROVED';
        var dealer = db.users.find(function (u) { return u.id === record.dealerId; });
        if (dealer) {
          dealer.verificationStatus = 'VERIFIED';
          if (record.dimension === 'CAC_BUSINESS') dealer.badges.cac = true;
          if (record.dimension === 'TITLE_DOCUMENTS') dealer.badges.titleDocs = true;
        }

        db.auditLogs.unshift({
          id: 'aud_' + Date.now(),
          adminName: db.currentUser.name + ' (Admin)',
          action: 'VERIFY_DOCUMENT',
          target: record.dealerName + ' (' + record.dimension + ')',
          details: 'Verified credentials and updated dealer trust badge.',
          timestamp: new Date().toLocaleString()
        });

        saveDatabase(db);
        return true;
      }
      return false;
    },

    // Submit Report
    submitReport: function (report) {
      var newReport = {
        id: 'rep_' + Date.now(),
        reporter: report.reporter || 'Anonymous',
        targetType: report.targetType,
        targetId: report.targetId,
        targetTitle: report.targetTitle,
        reason: report.reason,
        status: 'PENDING',
        submittedAt: new Date().toLocaleString()
      };
      db.reports.unshift(newReport);
      saveDatabase(db);
      return newReport;
    }
  };
})(window);
