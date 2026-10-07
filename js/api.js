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
  async function submitJson(endpoint, payload) {
    var headers = { 'Content-Type': 'application/json' };
    if (window.EastGateAuth && window.EastGateAuth.getToken()) {
      headers['Authorization'] = 'Bearer ' + window.EastGateAuth.getToken();
    }

    var res;
    try {
      res = await fetch(API_BASE + endpoint, {
        method: 'POST',
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
    return { success: true, data: body.data };
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

      var res = await apiFetch('/api/properties?' + params.toString());
      if (res && res.success) return res.data;

      // Fallback. The filters have to be re-applied here — returning the whole
      // APPROVED set would silently ignore the visitor's selection and look like
      // the filter simply does nothing.
      if (window.EastGateDB) {
        return window.EastGateDB.get().properties.filter(function (p) {
          // MANDATORY ADMIN APPROVAL RULE — mirrors GET /api/properties
          if (p.status !== 'APPROVED') return false;
          if (isActive(filters.category) && normaliseToken(p.category) !== normaliseToken(filters.category)) return false;
          if (isActive(filters.state) && normaliseToken(p.state) !== normaliseToken(filters.state)) return false;
          if (isActive(filters.listingType) && normaliseToken(p.listingType) !== normaliseToken(filters.listingType)) return false;
          return true;
        });
      }
      return [];
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
    bookInspection: async function (booking) {
      var res = await apiFetch('/api/inspections', {
        method: 'POST',
        body: JSON.stringify(booking)
      });
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.bookInspection(booking);
      }
      return null;
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
          verifiedDealerCount: db.verifications.filter(function (v) { return v.status === 'APPROVED'; }).length
        };
      }
      return { properties: [], products: [], services: [], verifications: [], verifiedDealerCount: 0 };
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

    adminVerifyDealer: async function (docId, adminId) {
      var res = await apiFetch('/api/admin/verify-dealer', {
        method: 'POST',
        body: JSON.stringify({ docId: docId, adminId: adminId })
      });
      if (res && res.success) return res;

      if (window.EastGateDB) {
        window.EastGateDB.adminVerifyDealerDoc(docId);
        return { success: true };
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
