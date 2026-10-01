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

  window.EastGateAPI = {
    // 1. PUBLIC QUERIES (Filtered to APPROVED only)
    getProperties: async function (filters) {
      filters = filters || {};
      var params = new URLSearchParams();
      if (filters.category) params.append('category', filters.category);
      if (filters.state) params.append('state', filters.state);
      if (filters.listingType) params.append('listingType', filters.listingType);

      var res = await apiFetch('/api/properties?' + params.toString());
      if (res && res.success) return res.data;

      // Fallback
      if (window.EastGateDB) {
        return window.EastGateDB.get().properties.filter(function (p) {
          return p.status === 'APPROVED';
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
          return p.status === 'APPROVED';
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
          return s.status === 'APPROVED';
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
      var res = await apiFetch('/api/dealer/properties', {
        method: 'POST',
        body: JSON.stringify(listing)
      });
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.dealerSubmitListing(listing);
      }
      return null;
    },

    dealerSubmitProduct: async function (product) {
      var res = await apiFetch('/api/dealer/products', {
        method: 'POST',
        body: JSON.stringify(product)
      });
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.dealerSubmitProduct(product);
      }
      return null;
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
          verifications: db.verifications.filter(function (v) { return v.status === 'PENDING'; })
        };
      }
      return { properties: [], products: [], services: [], verifications: [] };
    },

    getAuditLogs: async function () {
      var res = await apiFetch('/api/admin/audit-logs');
      if (res && res.success) return res.data;

      if (window.EastGateDB) {
        return window.EastGateDB.get().auditLogs;
      }
      return [];
    }
  };
})(window);
