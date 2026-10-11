import cors, { CorsOptions } from 'cors';
import type { Request, Response, NextFunction } from 'express';

/* ============================================================
   CORS
   Was `app.use(cors())`, which reflects any requesting origin back in
   Access-Control-Allow-Origin. Paired with a Bearer token in localStorage that
   means any site the admin visits could read authenticated API responses.
   Now only configured origins are allowed.
   ============================================================ */

/**
 * Origins permitted to call the API from a browser.
 *
 * Same-origin requests never send an Origin header, so serving the pages from
 * this same process keeps working with no configuration at all. Cross-origin
 * callers must be listed explicitly.
 */
function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS;
  if (!configured) {
    return [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      // Vite-style dev servers.
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    ];
  }

  return configured
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Marker set by buildCorsOptions on a rejection, so the error handler can answer
 * a blocked cross-origin request with a clean 403 instead of a generic 500.
 */
export interface CorsRejection extends Error {
  corsRejected?: boolean;
}

/**
 * The origin the current request was addressed to, reconstructed from the Host
 * header so it can be compared against a browser-supplied Origin. Used to treat
 * the site's own origin as same-origin no matter what address it is reached on
 * (localhost, a LAN IP, a public hostname).
 */
function requestOrigin(req: Request): string {
  const host = req.get('host');
  if (!host) return '';
  return `${forwardedProto(req) || req.protocol}://${host}`;
}

/**
 * The scheme the client actually used, honouring X-Forwarded-Proto when the
 * server sits behind a TLS-terminating proxy.
 */
function forwardedProto(req: Request): string {
  const header = req.get('x-forwarded-proto');
  return typeof header === 'string' ? header.split(',')[0].trim().toLowerCase() : '';
}

/**
 * True when the request arrived over HTTPS. Plain HTTP (the dev/LAN server)
 * must not be told to upgrade its own subresources — see securityHeaders().
 */
function isSecureRequest(req: Request): boolean {
  return req.secure || forwardedProto(req) === 'https';
}

/**
 * Requests with no Origin header (curl, server-to-server, same-origin fetches)
 * are not cross-origin and pass through untouched. Only a browser-supplied
 * Origin is checked.
 */
export function buildCorsOptions(req?: Request): CorsOptions {
  const allowed = allowedOrigins();

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/+$/, '');
      if (allowed.includes(normalized)) return callback(null, true);

      // The frontend is served by this same process, so a browser talking to it
      // sends its own origin in the Origin header on every non-GET request
      // (login, register, uploads, ...). The request's own origin must therefore
      // always be accepted — otherwise the site's own pages get a 403 from the
      // server on any host that is not in the allowlist (e.g. a LAN address).
      if (req && normalized === requestOrigin(req)) return callback(null, true);

      const error: CorsRejection = new Error(`Origin not allowed by CORS: ${origin}`);
      error.corsRejected = true;
      callback(error);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
  };
}

/* ============================================================
   SECURITY HEADERS
   ============================================================ */

/**
 * Content-Security-Policy.
 *
 * The pages currently ship ~26 inline <script> blocks and several hundred inline
 * style attributes. Moving those behind nonces or hashes is the only way to drop
 * 'unsafe-inline' from script-src, and it is worth doing — but it means
 * templating every HTML response, so it is deliberately left as a follow-up
 * rather than half-applied here.
 *
 * What this policy does buy today, even with 'unsafe-inline' on script-src:
 * scripts and XHR/fetch targets are confined to 'self', so a compromised
 * third-party host cannot be used to pull in or exfiltrate code. object-src,
 * base-uri and frame-ancestors remove the plugin-content, base-tag-hijack and
 * clickjacking classes outright — none of which need 'unsafe-inline' to work.
 */
function buildCsp(directives: string[], secure: boolean): string {
  return [
    "default-src 'self'",
    // See note above: tighten to nonces once inline scripts are templated.
    `script-src 'self' 'unsafe-inline'`,
    // Inline style attributes are used pervasively for one-off layout tweaks.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // 'self' is the dealer-uploaded gallery (uploads/), data: and blob: cover
    // inline previews, and unsplash the seeded catalogue. `https:` is here
    // because dealers may paste a link to a photo on their own host — without
    // it the browser would silently show a broken image for every such listing.
    "img-src 'self' data: blob: https: https://images.unsplash.com",
    // Bearer tokens live in localStorage, so this is what stops an injected
    // script from POSTing them to an attacker's host.
    ...directives,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    // Only meaningful over HTTPS. Over plain HTTP this makes the browser
    // rewrite every subresource and fetch to https://, which has no listener
    // on this server — so the page loads but every script, stylesheet and API
    // call fails. localhost is exempt from the upgrade, an address like
    // 192.168.x.x is not, which is exactly why LAN visitors broke.
    ...(secure ? ['upgrade-insecure-requests'] : [])
  ].join('; ');
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // buildCsp() joins directives with '; ', so every source for one directive has
  // to travel in a single array entry. Pushing each origin as its own entry made
  // Chrome read "http://localhost:3000" as a directive name — a parse error on
  // every page load, and the origins silently dropped from the policy.
  const connectSrc = ["connect-src 'self'", ...allowedOrigins()].join(' ');
  const secure = isSecureRequest(req);

  res.setHeader('Content-Security-Policy', buildCsp([connectSrc], secure));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // HSTS only makes sense over HTTPS; browsers ignore it on plain HTTP, and
  // emitting it from the dev/LAN server would just be noise.
  if (secure) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains'
    );
  }

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

/**
 * Turns a CORS rejection into a 403. Placed straight after the cors middleware;
 * anything that is not a CORS rejection is forwarded untouched to the real
 * handler at the end of the stack.
 */
export function corsErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error && typeof error === 'object' && (error as CorsRejection).corsRejected) {
    // Deliberately does not echo the offending origin back — no need to help
    // anyone probe which origins are permitted.
    res.status(403).json({ success: false, error: 'Origin not allowed.' });
    return;
  }

  next(error);
}
