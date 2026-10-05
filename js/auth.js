/**
 * East Gate Platform — Session Client
 * Wraps the /api/auth endpoints, owns token storage and portal route guards.
 */
(function (window) {
  'use strict';

  var SESSION_KEY = 'east_gate_session';
  var REMEMBER_KEY = 'east_gate_remember_email';

  var LANDING = {
    CUSTOMER: 'dashboard.html',
    DEALER: 'dealer-dashboard.html',
    ADMIN: 'admin.html',
    SUPER_ADMIN: 'admin.html'
  };

  function decodeBase64Url(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) padded += '=';
    return decodeURIComponent(
      atob(padded)
        .split('')
        .map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join('')
    );
  }

  function readStore() {
    return window.sessionStorage.getItem(SESSION_KEY) || window.localStorage.getItem(SESSION_KEY);
  }

  function writeStore(value, persistent) {
    clearStore();
    var target = persistent ? window.localStorage : window.sessionStorage;
    // Must be serialised. setItem() coerces a non-string to "[object Object]",
    // which getToken()'s JSON.parse then throws on — and the catch calls
    // clearStore(), so the guard silently treated every login as anonymous.
    target.setItem(SESSION_KEY, JSON.stringify(value));
  }

  function clearStore() {
    window.sessionStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(SESSION_KEY);
  }

  function request(endpoint, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json';

    var token = window.EastGateAuth.getToken();
    if (token) options.headers['Authorization'] = 'Bearer ' + token;

    return fetch(endpoint, options).then(function (res) {
      return res
        .json()
        .catch(function () {
          return { success: false, error: 'Unexpected server response.' };
        })
        .then(function (body) {
          return { status: res.status, ok: res.ok, body: body || {} };
        });
    });
  }

  var EastGateAuth = {
    /* ---------------- SESSION STATE ---------------- */
    getToken: function () {
      var raw = readStore();
      if (!raw) return null;
      try {
        var session = JSON.parse(raw);
        if (!session.expiresAt) return null;
        if (new Date(session.expiresAt).getTime() <= Date.now()) {
          clearStore();
          return null;
        }
        return session.token || null;
      } catch (e) {
        clearStore();
        return null;
      }
    },

    getSession: function () {
      var token = EastGateAuth.getToken();
      if (!token) return null;
      try {
        var parts = token.split('.');
        if (parts.length !== 2) return null;
        return JSON.parse(decodeBase64Url(parts[0]));
      } catch (e) {
        return null;
      }
    },

    isAuthenticated: function () {
      return Boolean(EastGateAuth.getToken());
    },

    hasRole: function () {
      var session = EastGateAuth.getSession();
      if (!session) return false;
      var allowed = Array.prototype.slice.call(arguments);
      if (!allowed.length) return true;
      if (allowed.indexOf(session.role) > -1) return true;
      // Mirror the server's requireRole: SUPER_ADMIN satisfies any ADMIN grant.
      return session.role === 'SUPER_ADMIN' && allowed.indexOf('ADMIN') > -1;
    },

    landingForRole: function (role) {
      return LANDING[role] || LANDING.CUSTOMER;
    },

    getRememberedEmail: function () {
      try {
        return window.localStorage.getItem(REMEMBER_KEY) || '';
      } catch (e) {
        return '';
      }
    },

    rememberEmail: function (email) {
      try {
        if (email) window.localStorage.setItem(REMEMBER_KEY, email);
        else window.localStorage.removeItem(REMEMBER_KEY);
      } catch (e) {
        /* storage unavailable */
      }
    },

    /* ---------------- CREDENTIALS ---------------- */
    login: function (email, password, rememberMe) {
      return request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email, password: password, rememberMe: Boolean(rememberMe) })
      }).then(function (result) {
        if (!result.ok || !result.body.success) {
          return { ok: false, error: result.body.error || 'Sign in failed. Please try again.' };
        }

        writeStore(
          { token: result.body.token, expiresAt: result.body.expiresAt },
          Boolean(rememberMe)
        );

        EastGateAuth.rememberEmail(rememberMe ? email : '');

        // Keep the local store persona in step with the authenticated account.
        if (window.EastGateDB && result.body.user) {
          window.EastGateDB.setCurrentUser({
            id: result.body.user.id,
            name: result.body.user.fullName,
            email: result.body.user.email,
            phone: result.body.user.phone,
            role: result.body.user.role
          });
        }

        return {
          ok: true,
          user: result.body.user,
          role: result.body.user.role,
          redirectTo: result.body.redirectTo || EastGateAuth.landingForRole(result.body.user.role)
        };
      });
    },

    me: function () {
      return request('/api/auth/me', { method: 'GET' }).then(function (result) {
        if (!result.ok) return { ok: false };
        return { ok: true, user: result.body.data };
      });
    },

    logout: function () {
      return request('/api/auth/logout', { method: 'POST' })
        .catch(function () {
          return { ok: false };
        })
        .then(function () {
          clearStore();
          return { ok: true };
        });
    },

    /* ---------------- PORTAL GUARD ---------------- */
    /**
     * Redirects to the login screen when the visitor has no valid session,
     * or holds a role that is not permitted on this page.
     */
    guardPage: function (allowedRoles) {
      var allowed = Array.isArray(allowedRoles) ? allowedRoles : [];
      var next = EastGateAuth.currentTarget();

      if (!EastGateAuth.isAuthenticated()) {
        window.location.replace('login.html?next=' + encodeURIComponent(next));
        return false;
      }

      if (allowed.length && !EastGateAuth.hasRole.apply(null, allowed)) {
        var session = EastGateAuth.getSession();
        var home = session ? EastGateAuth.landingForRole(session.role) : 'dashboard.html';
        window.location.replace(home);
        return false;
      }

      // Re-check the token with the server. If it has been revoked or the account
      // deactivated we sign out; if the server is simply unreachable we stay on
      // the page, since the frontend has a local-data fallback. Every guarded
      // API call re-validates the token server-side regardless.
      EastGateAuth.me()
        .then(function (result) {
          if (!result.ok) {
            clearStore();
            window.location.replace('login.html?next=' + encodeURIComponent(next));
          }
        })
        .catch(function () {
          /* offline — keep the locally-held session */
        });

      return true;
    },

    /* ---------------- NAVIGATION HELPERS ---------------- */
    /**
     * The page reference to hand to login.html so the visitor lands back
     * where they started. Only same-directory file names are accepted.
     */
    currentTarget: function () {
      var page = window.location.pathname.split('/').pop() || 'index.html';
      var hash = /^#[A-Za-z0-9_-]+$/.test(window.location.hash) ? window.location.hash : '';
      var target = page + window.location.search + hash;
      return /^[\w.-]+\.html(\?[^#]*)?(#[A-Za-z0-9_-]+)?$/.test(target) ? target : 'index.html';
    },

    loginUrlFor: function (target) {
      var page = target || EastGateAuth.currentTarget();
      return 'login.html?next=' + encodeURIComponent(page);
    }
  };

  window.EastGateAuth = EastGateAuth;
})(window);