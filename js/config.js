/**
 * East Gate — runtime configuration shared by every page.
 *
 * Why this file exists:
 *
 * Served by Express, the site is same-origin: `API_BASE` is empty, so
 * `fetch('/api/...')` and `<img src="/uploads/properties/x.jpg">` both resolve
 * against whatever host the page came from. Nothing else has to know.
 *
 * The packaged Capacitor app breaks that assumption. Its pages are served by
 * the device from `http://localhost/` (Android) or `capacitor://localhost/`
 * (iOS), while the API and the dealer-uploaded galleries still live on the
 * server. Every API call therefore needs an absolute origin, and every
 * root-relative `/uploads/...` URL that comes back in a JSON payload needs the
 * same origin bolted on before it is put in an `<img src>`.
 *
 * `EastGateConfig` is the single place that knows the difference:
 *
 *   - In a browser (localhost:3000, a LAN address, eastgate.ng, or a page
 *     opened straight off disk) it behaves exactly as before — an empty base,
 *     so every URL stays relative and the local-store fallback keeps working.
 *   - Inside the packaged app it switches to `PACKAGED_API` and rewrites
 *     `/uploads/...` strings as the payloads pass through the API client.
 *
 * `PACKAGED_API` is the address of the machine running `npm run dev` on the
 * same network. It changes with the machine's IP, so it can be overridden at
 * runtime without rebuilding the app: open the app once with
 * `?apiBase=http://192.168.0.50:3000` in the page URL, or write the key
 * `eastgate_api_base` into localStorage. An override of `""` forces the
 * bundled/default behaviour back off.
 */
(function (window) {
  'use strict';

  /** Where the API lives when the pages are running inside the packaged app. */
  var PACKAGED_API = 'http://192.168.18.7:3000';

  var OVERRIDE_KEY = 'eastgate_api_base';

  /**
   * True only for the packaged app's local web server.
   *
   * Deliberately not `file://`: a page opened from disk has no server behind
   * it, and pointing it at a machine on the LAN would change the "viewed
   * statically" fallback that api.js documents. Capacitor serves the bundle
   * from a host with no port (`http://localhost/`, `capacitor://localhost/`),
   * which distinguishes it from the dev server on `http://localhost:3000`.
   */
  function inApp() {
    var protocol = window.location.protocol;
    if (protocol === 'capacitor:' || protocol === 'ionic:') return true;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return window.location.hostname === 'localhost' && window.location.port === '';
  }

  /** Reads a `?apiBase=` query once and keeps it for later launches. */
  function captureOverride() {
    var match = /[?&]apiBase=([^&]*)/.exec(window.location.search || '');
    if (!match) return;
    try {
      var value = decodeURIComponent(match[1]);
      if (value) window.localStorage.setItem(OVERRIDE_KEY, value);
      else window.localStorage.removeItem(OVERRIDE_KEY);
    } catch (err) {
      /* Private mode / storage disabled — the default still applies. */
    }
  }

  function readOverride() {
    try {
      var stored = window.localStorage.getItem(OVERRIDE_KEY);
      return stored === null ? null : stored;
    } catch (err) {
      return null;
    }
  }

  captureOverride();

  var override = readOverride();
  var isApp = inApp();
  var apiBase = override !== null ? override : isApp ? PACKAGED_API : '';
  apiBase = String(apiBase).replace(/\/+$/, '');

  /**
   * Marks the document as the packaged app so css/app.css can inset the fixed
   * chrome around the status bar and gesture bar. Done on <html>, before the
   * body is parsed, so the fixed nav exists only after the class is already
   * there — the same trick the pages use for their own `js` class.
   *
   * The stylesheet is appended rather than linked from each page so the
   * browser never downloads a file it would not apply.
   */
  function flagNativeShell() {
    if (!isApp) return;
    var root = window.document.documentElement;
    root.classList.add('eg-native');
    var link = window.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/app.css';
    window.document.head.appendChild(link);
  }

  flagNativeShell();

  /** Absolute origin for the API, or '' to stay relative to the page. */
  function apiUrl(path) {
    if (typeof path !== 'string' || path === '') return apiBase;
    // Already absolute (https://…, http://…, //cdn…) — leave it alone.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.slice(0, 2) === '//') return path;
    return apiBase + (path.charAt(0) === '/' ? path : '/' + path);
  }

  /** True for `{}`/`{ … }` objects — not Date, File, Blob or FormData. */
  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  /**
   * Makes one root-relative URL absolute.
   *
   * Only `/uploads/...` is rewritten: that is the one class of path the server
   * publishes from its own disk (server/index.ts), every other string the API
   * returns is either already absolute or is data, not a URL.
   */
  function absUrl(value) {
    if (typeof value !== 'string' || !apiBase) return value;
    if (value.slice(0, 9) !== '/uploads/') return value;
    return apiBase + value;
  }

  /**
   * Walks a parsed API response and makes every `/uploads/...` string
   * absolute, wherever it sits in the payload.
   *
   * Rewriting at the boundary rather than at each `<img>` site means a listing
   * card, the lightbox, the admin grid and the dealer gallery all keep working
   * without each one remembering the app exists.
   */
  function absUrls(value) {
    if (!apiBase) return value;
    if (typeof value === 'string') return absUrl(value);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) value[i] = absUrls(value[i]);
      return value;
    }
    if (isPlainObject(value)) {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) value[key] = absUrls(value[key]);
      }
      return value;
    }
    return value;
  }

  /**
   * The inverse of `absUrls`, applied on the way out.
   *
   * A gallery that arrived as `http://192.168.0.170:3000/uploads/…` must go
   * back to `/uploads/…` before it is stored, or the database would remember
   * whatever address the phone happened to reach the PC on — a URL that is
   * meaningless to every other client, and wrong again after the API moves to
   * a public host. Only this API's own origin is stripped; every other string
   * is data and passes through untouched.
   *
   * Returns a copy rather than editing in place: the object being submitted is
   * usually still on screen, and a preview `<img>` must not lose the absolute
   * URL it needs to keep loading from.
   */
  function relUrls(value) {
    if (typeof value === 'string') {
      if (apiBase && value.slice(0, apiBase.length) === apiBase && value.slice(apiBase.length, apiBase.length + 9) === '/uploads/') {
        return value.slice(apiBase.length);
      }
      return value;
    }
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(relUrls(value[i]));
      return list;
    }
    if (isPlainObject(value)) {
      var copy = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) copy[key] = relUrls(value[key]);
      }
      return copy;
    }
    return value;
  }

  window.EastGateConfig = {
    apiBase: apiBase,
    inApp: isApp,
    apiUrl: apiUrl,
    absUrls: absUrls,
    relUrls: relUrls
  };
})(window);
