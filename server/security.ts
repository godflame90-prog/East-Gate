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
 * Requests with no Origin header (curl, server-to-server, same-origin fetches)
 * are not cross-origin and pass through untouched. Only a browser-supplied
 * Origin is checked.
 */
export function buildCorsOptions(): CorsOptions {
  const allowed = allowedOrigins();

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.includes(origin.replace(/\/+$/, ''))) return callback(null, true);

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
function buildCsp(directives: string[]): string {
  return [
    "default-src 'self'",
    // See note above: tighten to nonces once inline scripts are templated.
    `script-src 'self' 'unsafe-inline'`,
    // Inline style attributes are used pervasively for one-off layout tweaks.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://images.unsplash.com",
    // Bearer tokens live in localStorage, so this is what stops an injected
    // script from POSTing them to an attacker's host.
    ...directives,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    'upgrade-insecure-requests'
  ].join('; ');
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {  const connect = ["connect-src 'self'"];
  for (const origin of allowedOrigins()) connect.push(origin);

  res.setHeader('Content-Security-Policy', buildCsp(connect));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // The API only ever speaks JSON; nothing here should be framed or sniffed.
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=15552000; includeSubDomains'
  );

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
