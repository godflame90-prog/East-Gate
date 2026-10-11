/**
 * East Gate Enterprise API Client
 * Connects frontend portals directly to PostgreSQL database via Express / REST API,
 * with seamless fallback to EastGateDB when offline or viewed statically.
 */
(function (window) {
  'use strict';

  var API_BASE = ''; // Same origin or http://localhost:3000

  async function apiFetch(endpoint, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json';

    // Attach the signed session token to protected endpoints
    if (window.EastGateAuth && window.EastGateAuth.getToken()) {
      options.headers['Authorization'] = 'Bearer ' + window.EastGateAuth.getToken();
    }

    try {
      var res = await fetch(API_BASE + endpoint, options);
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' on ' + endpoint);
      }
      return await res.json();
    } catch (err) {
      console.warn('API fetch failed, falling back to local store engine:', err.message);
      return null;
    }
  }

  // The mock store stores Title-Case values ("Buy", "Residential") while the
  // Prisma enum and the API use SCREAMING_SNAKE ("BUY", "RESIDENTIAL"). Fold both
  // sides to one comparable token so a filter means the same thing whether or not
  // the server answered. Mirrors parseEnumValue() in server/index.ts.
  function normaliseToken(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  }

  // True when `filter` is a real constraint, i.e. present and not the ALL sentinel.
  function isActive(filter) {
    var token = normaliseToken(filter);
    return token !== '' && token !== 'ALL';
  }

  /**
   * JSON POST for the dealer submission endpoints.
   *
   * apiFetch cannot be used here: it collapses "the server said no" and "the
   * server did not answer" into one null, and the portal needs them apart —
   * a 400 carries the message that has to reach the dealer ("a listing needs
   * at least 5 images"), while only a genuinely unreachable server should fall
   * back to the local store.
   *
   * Returns one envelope in every case, because the callers read `success`:
   *   { success: true,  data }        — accepted
   *   { success: false, error }       — rejected, `error` is the server's reason
   *   { offline: true }               — no answer at all
   */
  async function submitJson(endpoint, payload, method) {
    var headers = { 'Content-Type': 'application/json' };
    if (window.EastGateAuth && window.EastGateAuth.getToken()) {
      headers['Authorization'] = 'Bearer ' + window.EastGateAuth.getToken();
    }

    var res;
    try {
      res = await fetch(API_BASE + endpoint, {
        method: method || 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
    } catch (err) {
      return { offline: true };
    }

    var body = {};
    try {
      body = await res.json();
    } catch (err) {
      body = {};
    }

    if (!res.ok) {
      return { success: false, error: body.error || 'Submission failed (HTTP ' + res.status + ').' };
    }
    return { success: true, data: body.data, message: body.message };
  }

  window.EastGateAPI = {
    // 0. METADATA
    // The purpose vocabulary, straight from the enum so the UI cannot drift out
    // of sync with the database. Returns null when the server is unreachable, so
    // callers can keep whatever static markup they already shipped.
    getListingTypes: async function () {
      var res = await apiFetch('/api/listing-types');
      if (res && res.success && res.data) return res.data;
      return null;
    },

    // 1. PUBLIC QUERIES (Filtered to APPROVED only)
    getProperties: async function (filters) {
      filters = filters || {};
      var params = new URLSearchParams();
      if (filters.category) params.append('category', filters.category);
      if (filters.state) params.append('state', filters.state);
      if (filters.listingType) params.append('listingType', filters.listingType);
      if (filters.q) params.append('q', filters.q);
      if (filters.minPrice != null && filters.minPrice !== '') params.append('minPrice', filters.minPrice);
      if (filters.maxPrice != null && filters.maxPrice !== '') params.append('maxPrice', filters.maxPrice);
      if (filters.sort) params.append('sort', filters.sort);

      var res = await apiFetch('/api/properties?' + params.toString());
      if (res && res.success) return res.data;

      // Fallback. The filters have to be re-applied here — returning the whole
      // APPROVED set would silently ignore the visitor's selection and look like
      // the filter simply does nothing. Keyword, price and sort are mirrored too.
      if (window.EastGateDB) {
        var term = filters.q ? String(filters.q).trim().toLowerCase() : '';
        var min = filters.minPrice != null && filters.minPrice !== '' ? Number(filters.minPrice) : null;
        var max = filters.maxPrice != null && filters.maxPrice !== '' ? Number(filters.maxPrice) : null;

        var rows = window.EastGateDB.get().properties.filter(function (p) {
          // MANDATORY ADMIN APPROVAL RULE — mirrors GET /api/properties
          if (p.status !== 'APPROVED') return false;
          if (isActive(filters.category) && normaliseToken(p.category) !== normaliseToken(filters.category)) return false;
          if (isActive(filters.state) && normaliseToken(p.state) !== normaliseToken(filters.state)) return false;
          if (isActive(filters.listingType) && normaliseToken(p.listingType) !== normaliseToken(filters.listingType)) return false;

          if (term) {
            var haystack = [p.title, p.location, p.description, p.dealerName]
              .map(function (v) { return String(v == null ? '' : v).toLowerCase(); })
              .join(' ');
            if (haystack.indexOf(term) === -1) return false;
          }

          var price = Number(p.price);
          if (min != null && Number.isFinite(min) && price < min) return false;
          if (max != null && Number.isFinite(max) && price > max) return false;
          return true;
        });

        rows.sort(function (a, b) {
          switch (filters.sort) {
            case 'price_asc': return Number(a.price) - Number(b.price);
            case 'price_desc': return Number(b.price) - Number(a.price);
            case 'beds_desc': return Number(b.beds) - Number(a.beds);
            case 'oldest': return String(a.id).localeCompare(String(b.id));
            default: return String(b.id).localeCompare(String(a.id));
          }
        });

        return rows;
      }
      return [];
    },

    getProperty: async function (id) {
      if (!id) return null;
      var res = await apiFetch('/api/properties/' + encodeURIComponent(id));
      if (res && res.success) return res.data;

      // Offline / static fallback: the mock store keys listings by id.
      if (window.EastGateDB) {
        var found = window.EastGateDB.get().properties.find(function (p) { return p.id === id; });
        return found || null;
      }
      return null;
    },

    getMarketplace: async function (category) {
      var params = new URLSearchParams();
      if (category && category !== 'ALL') params.append('category', category);

      var res = await apiFetch('/api/marketplace?' + params.toString());
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().marketplaceProducts.filter(function (p) {
          if (p.status !== 'APPROVED') return false;
          if (isActive(category) && normaliseToken(p.category) !== normaliseToken(category)) return false;
          return true;
        });
      }
      return [];
    },

    getServices: async function (category) {
      var params = new URLSearchParams();
      if (category && category !== 'ALL') params.append('category', category);

      var res = await apiFetch('/api/services?' + params.toString());
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().services.filter(function (s) {
          if (s.status !== 'APPROVED') return false;
          if (isActive(category) && normaliseToken(s.category) !== normaliseToken(category)) return false;
          return true;
        });
      }
      return [];
    },

    getDealers: async function () {
      var res = await apiFetch('/api/dealers');
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().users.filter(function (u) {
          return u.role === 'DEALER';
        });
      }
      return [];
    },

    // One dealer profile plus their approved catalogue. Supersedes the mock by
    // falling back to whatever the local store knows about the dealer.
    getDealer: async function (id) {
      if (!id) return null;
      var res = await apiFetch('/api/dealers/' + encodeURIComponent(id));
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        var db = window.EastGateDB.get();
        var dealer = db.dealers && db.dealers.find(function (d) { return d.id === id; });
        if (!dealer) {
          var user = db.users.find(function (u) { return u.id === id; });
          if (user) dealer = { id: user.id, businessName: user.businessName || user.fullName, user: user };
        }
        if (!dealer) return null;
        dealer.listings = db.properties.filter(function (p) {
          return p.dealerId === id && p.status === 'APPROVED';
        });
        return dealer;
      }
      return null;
    },

    // The signed-in customer's own inspections. The server rejects any id other
    // than the caller's unless they are an admin, so the caller must pass the id
    // from its own session rather than one supplied by the page.
    getUserInspections: async function (userId) {
      if (!userId) return [];
      var res = await apiFetch('/api/user/inspections/' + encodeURIComponent(userId));
      if (res && res.success) return res.data;

      // Offline fallback. The mock store keys inspections to a demo user id, so
      // filter on it when we know who is signed in and show everything otherwise.
      if (window.EastGateDB) {
        var all = window.EastGateDB.get().inspections;
        if (!window.EastGateAuth || !window.EastGateAuth.isAuthenticated()) return all;
        return all.filter(function (i) { return i.userId === userId; });
      }
      return [];
    },

    // 2. CUSTOMER ACTIONS
    //
    // Returns one envelope rather than raw data, mirroring submitJson: the store
    // has to tell "the server said no" (surface the reason) from "the server did
    // not answer" (fall back to the local store). It must NOT call back into
    // EastGateDB.bookInspection — that was an infinite recursion: the store
    // delegated here, a failed POST landed here again, and here delegated back.
    bookInspection: async function (booking) {
      var result = await submitJson('/api/inspections', booking);
      if (result.success) return { success: true, data: result.data };
      if (result.offline) {
        return { success: false, offline: true, error: 'Could not reach the East Gate server.' };
      }
      return { success: false, error: result.error };
    },

    // SAVED LISTINGS (customer wishlist). The server stores SavedListing rows,
    // each carrying its `property`; the relation is unwrapped here so callers
    // (the dashboard grid) only ever deal with listings.
    getSavedProperties: async function () {
      var res = await apiFetch('/api/user/saved');
      if (res && res.success) {
        return (res.data || [])
          .map(function (row) { return row.property || row; })
          .filter(Boolean);
      }

      // Offline / static fallback: the local store mirrors the saved ids.
      if (window.EastGateDB) {
        var db = window.EastGateDB.get();
        var uid = db.currentUser && db.currentUser.id;
        var ids = (db.saved && uid && db.saved[uid]) || [];
        return ids.map(function (id) {
          return db.properties.find(function (p) { return p.id === id; });
        }).filter(Boolean);
      }
      return [];
    },

    saveProperty: async function (propertyId) {
      if (!propertyId) return { success: false };
      var res = await apiFetch('/api/user/saved', {
        method: 'POST',
        body: JSON.stringify({ propertyId: propertyId })
      });
      return { success: !!(res && res.success) };
    },

    unsaveProperty: async function (propertyId) {
      if (!propertyId) return { success: false };
      var res = await apiFetch('/api/user/saved/' + encodeURIComponent(propertyId), { method: 'DELETE' });
      return { success: !!(res && res.success) };
    },

    // 3. DEALER SUBMISSIONS (MANDATORY PENDING_REVIEW)
    dealerSubmitListing: async function (listing) {
      var result = await submitJson('/api/dealer/properties', listing);
      if (!result.offline) return result;

      // No server: keep the dealer's work in the local store rather than
      // dropping the form on the floor.
      if (window.EastGateDB) {
        return { success: true, data: window.EastGateDB.dealerSubmitListing(listing), offline: true };
      }
      return { success: false, error: 'Cannot reach the East Gate server.' };
    },

    dealerSubmitProduct: async function (product) {
      var result = await submitJson('/api/dealer/products', product);
      if (!result.offline) return result;

      if (window.EastGateDB) {
        return { success: true, data: window.EastGateDB.dealerSubmitProduct(product), offline: true };
      }
      return { success: false, error: 'Cannot reach the East Gate server.' };
    },

    dealerSubmitService: async function (service) {
      var result = await submitJson('/api/dealer/services', service);
      if (!result.offline) return result;

      if (window.EastGateDB) {
        return { success: true, data: window.EastGateDB.dealerSubmitService(service), offline: true };
      }
      return { success: false, error: 'Cannot reach the East Gate server.' };
    },

    // The signed-in dealer's own records, every moderation state included. The
    // public endpoints only expose APPROVED rows, which would hide a pending
    // submission from the very portal that created it. Offline, each one falls
    // back to whatever the local store holds, matching the page's old behaviour.
    getDealerProperties: async function () {
      var res = await apiFetch('/api/dealer/properties');
      if (res && res.success) return res.data;
      if (window.EastGateDB) return window.EastGateDB.get().properties;
      return [];
    },

    getDealerProducts: async function () {
      var res = await apiFetch('/api/dealer/products');
      if (res && res.success) return res.data;
      if (window.EastGateDB) return window.EastGateDB.get().marketplaceProducts;
      return [];
    },

    getDealerServices: async function () {
      var res = await apiFetch('/api/dealer/services/list');
      if (res && res.success) return res.data;
      if (window.EastGateDB) {
        var db = window.EastGateDB.get();
        var persona = db.currentUser && db.currentUser.name;
        return db.services.filter(function (s) { return !persona || s.providerName === persona; });
      }
      return [];
    },

    // Customer self-service: move one of your OWN inspections to a new slot.
    // Goes through submitJson so a server rejection (closed/not-yours) keeps its
    // message; only a truly unreachable server falls back to the local mirror.
    rescheduleInspection: async function (inspectionId, slot) {
      if (!inspectionId || !slot || !slot.date || !slot.timeSlot) {
        return { success: false, error: 'A new date and time slot are required.' };
      }
      var body = { date: slot.date, timeSlot: slot.timeSlot };
      if (slot.notes) body.notes = slot.notes;

      var result = await submitJson(
        '/api/user/inspections/' + encodeURIComponent(inspectionId) + '/reschedule',
        body,
        'PATCH'
      );
      if (!result.offline) return result;

      if (window.EastGateDB && window.EastGateDB.rescheduleInspection) {
        return { success: true, data: window.EastGateDB.rescheduleInspection(inspectionId, slot), offline: true };
      }
      return { success: false, error: 'Cannot reach the East Gate server to reschedule.' };
    },

    getDealerInspections: async function () {
      var res = await apiFetch('/api/dealer/inspections');
      if (res && res.success) return res.data;
      if (window.EastGateDB) return window.EastGateDB.get().inspections;
      return [];
    },

    // Every appointment on the platform, for the admin console.
    getAdminInspections: async function () {
      var res = await apiFetch('/api/admin/inspections');
      if (res && res.success) return res.data;
      if (window.EastGateDB) return window.EastGateDB.get().inspections;
      return [];
    },

    // Admin-only: move an appointment through its lifecycle
    // (CONFIRMED / COMPLETED / RESCHEDULED / CANCELLED). `extra` may carry the
    // new date/time slot (reschedule) or the cancellation reason (notes).
    updateInspectionStatus: async function (inspectionId, status, extra) {
      if (!inspectionId || !status) {
        return { success: false, error: 'Inspection id and status are required.' };
      }
      var body = { status: status };
      if (extra) {
        if (extra.date) body.date = extra.date;
        if (extra.timeSlot) body.timeSlot = extra.timeSlot;
        if (extra.notes) body.notes = extra.notes;
      }
      var result = await submitJson(
        '/api/inspections/' + encodeURIComponent(inspectionId) + '/status',
        body,
        'PATCH'
      );
      if (!result.offline) return result;
      if (window.EastGateDB && window.EastGateDB.updateInspectionStatus) {
        return { success: true, data: window.EastGateDB.updateInspectionStatus(inspectionId, status), offline: true };
      }
      return { success: false, error: 'Cannot reach the East Gate server.' };
    },

    /**
     * Uploads a listing's photos and returns their public URLs.
     *
     * Multipart, so it deliberately does not go through apiFetch — that helper
     * forces Content-Type: application/json, and setting it by hand here would
     * break the boundary the browser is about to write. Never set that header
     * on a FormData request.
     */
    uploadPropertyImages: async function (files) {
      if (!files || !files.length) return { success: false, error: 'Attach at least one image.' };

      var form = new FormData();
      for (var i = 0; i < files.length; i++) {
        form.append('images', files[i], files[i].name || 'photo-' + (i + 1) + '.jpg');
      }

      var headers = {};
      if (window.EastGateAuth && window.EastGateAuth.getToken()) {
        headers['Authorization'] = 'Bearer ' + window.EastGateAuth.getToken();
      }

      var res;
      try {
        res = await fetch(API_BASE + '/api/uploads/property-images', {
          method: 'POST',
          headers: headers,
          body: form
        });
      } catch (err) {
        return { success: false, error: 'Cannot reach the East Gate server to upload images.' };
      }

      var body = {};
      try {
        body = await res.json();
      } catch (err) {
        body = {};
      }

      if (!res.ok || !body.success) {
        return { success: false, error: body.error || 'Upload failed (HTTP ' + res.status + ').' };
      }

      return { success: true, urls: (body.data && body.data.urls) || [] };
    },

    // 4. ADMIN CONTROL FORTRESS & DIRECT PRODUCT CREATION
    adminCreateProduct: async function (product) {
      var res = await apiFetch('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify(product)
      });
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.adminCreateProduct(product);
      }
      return null;
    },

    adminApprove: async function (entityType, entityId, adminId) {
      var res = await apiFetch('/api/admin/approve', {
        method: 'POST',
        body: JSON.stringify({ entityType: entityType, entityId: entityId, adminId: adminId })
      });
      if (res && res.success) return res;

      if (window.EastGateDB) {
        window.EastGateDB.adminApproveItem(entityType, entityId);
        return { success: true };
      }
      return { success: false };
    },

    getAdminQueue: async function () {
      var res = await apiFetch('/api/admin/queue');
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        var db = window.EastGateDB.get();
        return {
          properties: db.properties.filter(function (p) { return p.status === 'PENDING_REVIEW'; }),
          products: db.marketplaceProducts.filter(function (p) { return p.status === 'PENDING_REVIEW'; }),
          services: db.services.filter(function (s) { return s.status === 'PENDING_REVIEW'; }),
          verifications: db.verifications.filter(function (v) { return v.status === 'PENDING'; }),
          pendingDealers: [],
          verifiedDealerCount: db.verifications.filter(function (v) { return v.status === 'APPROVED'; }).length
        };
      }
      return { properties: [], products: [], services: [], verifications: [], pendingDealers: [], verifiedDealerCount: 0 };
    },

    adminReject: async function (entityType, entityId, reason, adminId) {
      var res = await apiFetch('/api/admin/reject', {
        method: 'POST',
        body: JSON.stringify({ entityType: entityType, entityId: entityId, reason: reason, adminId: adminId })
      });
      if (res && res.success) return res;

      if (window.EastGateDB) {
        window.EastGateDB.adminRejectItem(entityType, entityId, reason);
        return { success: true };
      }
      return { success: false };
    },

    adminVerifyDealer: async function (dealerId, adminId) {
      var res = await apiFetch('/api/admin/verify-dealer', {
        method: 'POST',
        body: JSON.stringify({ dealerId: dealerId, adminId: adminId })
      });
      if (res && res.success) return res;

      if (window.EastGateDB) {
        return window.EastGateDB.adminVerifyDealerDoc(dealerId)
          ? { success: true }
          : { success: false, error: 'That dealer is not in the local store.' };
      }
      return { success: false };
    },

    getAdminReports: async function () {
      var res = await apiFetch('/api/admin/reports');
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().reports;
      }
      return [];
    },

    /**
     * Everything already approved and publicly live, grouped by submitter.
     *
     * Returns one envelope either way ({items, total, mineCount, scope}) so the
     * console can render the table and both toggle counts from a single call.
     * `mine` asks the server for this admin's own decisions only.
     */
    getApprovedItems: async function (mine) {
      var res = await apiFetch('/api/admin/approved' + (mine ? '?mine=1' : ''));
      if (res && res.success && res.data) return res.data;

      if (window.EastGateDB) {
        var db = window.EastGateDB.get();
        var self = (window.EastGateAuth && window.EastGateAuth.getSession())
          ? window.EastGateAuth.getSession().name
          : '';
        var selfKey = String(self || '').toLowerCase();

        // The local store records approvals in its audit trail keyed by target
        // NAME rather than id, so the sign-off is looked up by name. The newest
        // matching entry wins, mirroring the server's newest-first resolution.
        function signOff(name) {
          var match = null;
          for (var i = 0; i < db.auditLogs.length; i++) {
            var log = db.auditLogs[i];
            if (!/^APPROVE_|^ADMIN_CREATE_PRODUCT/.test(log.action)) continue;
            if (String(log.target || '') !== String(name)) continue;
            match = log;
            break;
          }
          if (!match) return { by: null, id: null, at: null };
          var by = String(match.adminName || '').replace(/\s*\(.*$/, '');
          var isSelf = !!selfKey && by.toLowerCase().indexOf(selfKey) === 0;
          return { by: by || null, id: isSelf ? 'self' : null, at: match.timestamp || null };
        }

        var items = [];
        var add = function (type, name, category, detail, person, business, key, source) {
          var sign = signOff(name);
          items.push({
            id: source.id,
            type: type,
            name: name,
            category: category || '',
            detail: detail || '',
            location: source.location || '',
            price: source.price != null ? String(source.price) : '',
            currency: source.currency || 'NGN',
            submitterKey: key,
            submittedBy: person,
            submittedByBusiness: business || '',
            approvedBy: sign.by,
            approvedById: sign.id,
            approvedAt: sign.at
          });
        };

        db.properties.forEach(function (p) {
          if (p.status !== 'APPROVED') return;
          add('PROPERTY', p.title, p.category, p.titleDoc || p.titleDocument,
            p.dealerName || 'Unknown dealer', p.dealerName || '', p.dealerId || p.dealerName, p);
        });
        db.marketplaceProducts.forEach(function (p) {
          if (p.status !== 'APPROVED') return;
          var official = p.isOfficial;
          add('PRODUCT', p.name, p.category, p.specs || p.specifications,
            official ? 'East Gate Official' : (p.vendor || p.dealerName || 'Unknown vendor'),
            official ? 'Published by an administrator' : (p.vendor || ''),
            official ? 'east-gate-official' : (p.dealerId || p.vendor || 'vendor'), p);
        });
        db.services.forEach(function (s) {
          if (s.status !== 'APPROVED') return;
          add('SERVICE', s.title, s.category, s.coverageState || s.state,
            s.providerName || s.dealerName || 'Unknown provider',
            s.providerName || '', s.dealerId || s.providerName, s);
        });

        var mineCount = items.filter(function (i) { return i.approvedById === 'self'; }).length;
        return {
          items: mine ? items.filter(function (i) { return i.approvedById === 'self'; }) : items,
          total: items.length,
          mineCount: mineCount,
          scope: mine ? 'mine' : 'all'
        };
      }

      return { items: [], total: 0, mineCount: 0, scope: mine ? 'mine' : 'all' };
    },

    getAuditLogs: async function () {
      var res = await apiFetch('/api/admin/audit-logs');
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().auditLogs;
      }
      return [];
    },

    // CONTACT MESSAGES (public submission + admin inbox)
    //
    // Unlike the read methods above there is no local fallback here: apiFetch
    // collapses a network failure into null, and mistaking "could not reach the
    // server" for "submitted" would repeat the exact bug this replaced — telling
    // a visitor their message was sent when nothing was stored. The caller must
    // handle the failure explicitly.
    sendContactMessage: async function (payload) {
      var res = await apiFetch('/api/contact', {
        method: 'POST',
        body: JSON.stringify(payload || {})
      });

      if (res && res.success) return res.data;

      return null;
    },

    getAdminContactMessages: async function () {
      var res = await apiFetch('/api/admin/contact-messages');
      if (res && res.success) return res.data;
      return [];
    },

    // PASSWORD RESET / EMAIL VERIFICATION
    //
    // All four go through submitJson so the server's own message (expired link,
    // weak password, throttled) reaches the form unchanged. There is no offline
    // fallback: the whole point is that a task happened on the server, and there
    // is no honest way to fake that in localStorage.
    forgotPassword: async function (email) {
      var result = await submitJson('/api/auth/forgot-password', { email: email });
      if (result.success) return { success: true, message: result.message };
      if (result.offline) return { success: false, error: 'Could not reach the East Gate server. Please try again.' };
      return { success: false, error: result.error };
    },

    resetPassword: async function (token, password) {
      var result = await submitJson('/api/auth/reset-password', { token: token, password: password });
      if (result.success) return { success: true, message: result.message };
      if (result.offline) return { success: false, error: 'Could not reach the East Gate server. Please try again.' };
      return { success: false, error: result.error };
    },

    verifyEmail: async function (token) {
      var result = await submitJson('/api/auth/verify-email', { token: token });
      if (result.success) return { success: true, message: result.message };
      if (result.offline) return { success: false, error: 'Could not reach the East Gate server. Please try again.' };
      return { success: false, error: result.error };
    },

    resendVerification: async function () {
      var result = await submitJson('/api/auth/resend-verification', {});
      if (result.success) return { success: true, message: result.message };
      if (result.offline) return { success: false, error: 'Could not reach the East Gate server. Please try again.' };
      return { success: false, error: result.error };
    },

    // LISTING ENQUIRIES
    //
    // Unlike reads, this deliberately never fabricates success: failing to reach
    // the server must surface as an error, or the visitor is told their message
    // was recorded when nothing was stored. Goes through submitJson so the
    // server's own 400 ("add a short message") reaches the form verbatim.
    sendListingEnquiry: async function (payload) {
      var result = await submitJson('/api/enquiries', payload || {});
      if (result.success) return { success: true, data: result.data };
      if (result.offline) {
        return { success: false, offline: true, error: 'Could not reach the East Gate server. Please try again or reach us on WhatsApp.' };
      }
      return { success: false, error: result.error };
    },

    getAdminEnquiries: async function () {
      var res = await apiFetch('/api/admin/enquiries');
      if (res && res.success) return res.data;
      return [];
    },

    markEnquiryRead: async function (id, read) {
      var res = await apiFetch('/api/admin/enquiries/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({ read: read !== false })
      });
      return !!(res && res.success);
    },

    markContactMessageRead: async function (id, read) {
      var res = await apiFetch('/api/admin/contact-messages/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({ read: read !== false })
      });
      return !!(res && res.success);
    },

    deleteContactMessage: async function (id) {
      var res = await apiFetch('/api/admin/contact-messages/' + encodeURIComponent(id), {
        method: 'DELETE'
      });
      return !!(res && res.success);
    }
  };
})(window);
