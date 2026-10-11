import crypto from 'crypto';
import { promisify } from 'util';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from './db';

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const SESSION_TTL_HOURS = 12;
export const SESSION_TTL_HOURS_REMEMBER = 24 * 30;

export type SessionRole = 'CUSTOMER' | 'DEALER' | 'ADMIN' | 'SUPER_ADMIN';

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  role: SessionRole;
  /** Unique token id. The unit that gets revoked on logout. */
  jti: string;
  /**
   * Session-generation marker (see User.sessionVersion). Minted at sign-in and
   * re-checked on every request, so changing the password can retire every other
   * session without needing to know their token ids.
   */
  sv: number;
  iat: number;
  exp: number;
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (secret) {
    console.warn('[auth] SESSION_SECRET is shorter than 32 characters — using a derived key instead.');
  } else {
    console.warn('[auth] SESSION_SECRET is not set — using an insecure development key.');
  }
  return crypto.createHash('sha256').update(`east-gate-dev-secret:${secret || 'local'}`).digest('hex');
}

/* ============================================================
   PASSWORD HASHING — scrypt (no native dependencies)
   Stored format: scrypt$<keylen>$<saltHex>$<hashHex>
   ============================================================ */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = await scryptAsync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${SCRYPT_KEYLEN}$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const keylen = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'hex');
  if (!keylen || !salt || expected.length !== keylen) return false;

  const derived = await scryptAsync(plain, salt, keylen);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// Compared against when no user is found, so a missing account and a wrong
// password take a comparable amount of time.
const DUMMY_HASH_PROMISE = hashPassword('east_gate_absent_user_dummy');

export async function absentUserTimingGuard(): Promise<void> {
  await DUMMY_HASH_PROMISE;
}

/* ============================================================
   PASSWORD POLICY
   Sign-up used to accept anything 8 characters or longer, which accepts
   "password1". Length is the property that actually helps, so this leans on
   length plus a blocklist rather than symbol-class rules that push people
   toward predictable substitutions. Shared by both registration endpoints so
   the two cannot drift apart.
   ============================================================ */

export const PASSWORD_MIN_LENGTH = 10;

// Passwords that show up at the top of every breach corpus. A full check against
// such a list needs a dependency; this covers the ones actually worth blocking
// for a consumer property platform.
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  '123456789',
  'qwertyuiop',
  'letmein1234',
  'iloveyou123',
  'admin12345',
  'welcome123',
  'eastgate123',
  'eastgate2026',
  'property123',
  'sunshine123'
]);

/**
 * Validates a candidate password at sign-up.
 *
 * @returns human-readable problems; empty means acceptable.
 */
export function validatePasswordStrength(password: string, email?: string): string[] {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  // Anything over 200 chars is scrypt input we have no reason to accept, and it
  // is a cheap way to make a hash operation expensive.
  if (password.length > 200) {
    problems.push('Password must be 200 characters or fewer.');
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('That password is too common. Choose something less predictable.');
  }

  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase();
    // Catches "jay@example.com" / "jayjay123" without demanding symbols.
    if (localPart && localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
      problems.push('Password must not contain your email address.');
    }
  }

  return problems;
}

/* ============================================================
   SESSION TOKENS — HMAC-SHA256 signed, self-contained
   Format: base64url(payload).base64url(signature)
   ============================================================ */
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
}

export function createSessionToken(
  user: { id: string; email: string; fullName: string; role: SessionRole; sessionVersion?: number },
  rememberMe = false
): { token: string; expiresAt: string } {
  const ttlHours = rememberMe ? SESSION_TTL_HOURS_REMEMBER : SESSION_TTL_HOURS;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlHours * 3600;

  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    name: user.fullName,
    role: user.role,
    jti: crypto.randomUUID(),
    sv: user.sessionVersion ?? 0,
    iat: issuedAt,
    exp: expiresAt
  };

  const encoded = base64url(JSON.stringify(payload));
  return {
    token: `${encoded}.${sign(encoded)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expected = sign(encoded);
  const received = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (received.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(received, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.sub || !payload.exp) return null;
    // A token with no jti cannot be revoked, which is the whole point of the
    // revocation list. Reject it rather than issue an unkillable session.
    if (!payload.jti) return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/* ============================================================
   TOKEN REVOCATION
   A verified signature only proves the token was issued by us — it says
   nothing about whether it should still be honoured. These functions are
   what make POST /api/auth/logout actually mean something.
   ============================================================ */

// Short-lived memo of jti -> "not revoked". Without it every authenticated
// request costs an extra indexed SELECT. Entries are cleared on revoke, so a
// logout is never masked by a warm cache.
const REVOKED_TTL_MS = 60_000;
const revocationCache = new Set<string>();

// The Set carries no timestamps, so bound it by clearing wholesale once it grows
// past a size implying many distinct tokens have passed through. This only ever
// costs a re-SELECT, never correctness: a missed memo re-reads the table.
function cacheSweep(): void {
  if (revocationCache.size > 5000) revocationCache.clear();
}

export async function revokeSession(session: SessionPayload): Promise<void> {
  const expiresAt = new Date(session.exp * 1000);

  // Already expired — nothing to remember, and the row would be prunable at once.
  if (expiresAt.getTime() <= Date.now()) return;

  await prisma.revokedSession.upsert({
    where: { jti: session.jti },
    create: { jti: session.jti, userId: session.sub, expiresAt },
    update: {}
  });

  // Purge any cached "still good" verdict for this token.
  revocationCache.delete(session.jti);
}

export async function isSessionRevoked(session: SessionPayload): Promise<boolean> {
  if (revocationCache.has(session.jti)) return true;

  const row = await prisma.revokedSession.findUnique({
    where: { jti: session.jti },
    select: { jti: true }
  });

  cacheSweep();
  if (!row) return false;

  // Remember the verdict only for tokens whose own lifetime outruns the memo,
  // so a stale "revoked" can never outlive the token it refers to.
  const ttl = Math.min(REVOKED_TTL_MS, session.exp * 1000 - Date.now());
  if (ttl > 0) revocationCache.add(session.jti);
  return true;
}

/**
 * Deletes revocation rows for tokens that expired before now. A token that is
 * past its exp is already rejected by verifySessionToken, so its row is dead
 * weight. Call periodically.
 */
export async function pruneRevokedSessions(): Promise<number> {
  const result = await prisma.revokedSession.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  });
  return result.count;
}

/* ============================================================
   SESSION GENERATION
   A password reset has to strand the sessions that the old password could
   already have been read from. Rather than track every outstanding token id,
   the user carries a counter that every token embeds and every request checks;
   bumping it makes every older token fail the check at once.
   ============================================================ */

// Memo of userId -> current version. Purely to avoid a SELECT on every request;
// invalidateSessions() drops the entry, so a reset is felt on the next call.
const VERSION_TTL_MS = 30_000;
const versionCache = new Map<string, { sv: number; at: number }>();

/** Increments the user's session version, retiring every token minted before now. */
export async function invalidateSessions(userId: string): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true }
  });
  versionCache.set(userId, { sv: updated.sessionVersion, at: Date.now() });
}

/**
 * True when the token still matches the user's current session generation and
 * the account still exists. Tokens issued before this feature carry no `sv` and
 * are treated as generation 0, so it rolls out without signing anyone out.
 */
export async function isSessionCurrent(session: SessionPayload): Promise<boolean> {
  const cached = versionCache.get(session.sub);
  let current: number;

  if (cached && Date.now() - cached.at < VERSION_TTL_MS) {
    current = cached.sv;
  } else {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { sessionVersion: true }
    });
    if (!user) return false;
    current = user.sessionVersion;
    if (versionCache.size > 5000) versionCache.clear();
    versionCache.set(session.sub, { sv: current, at: Date.now() });
  }

  return (session.sv ?? 0) === current;
}

/* ============================================================
   MIDDLEWARE
   ============================================================ */
export interface AuthenticatedRequest extends Request {
  session?: SessionPayload;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  const session = token ? verifySessionToken(token) : null;

  if (!session) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  // The revocation lookup touches the database, so it can fail. This runs ahead
  // of every route's own try/catch, and in Express 5 a rejection here escapes as
  // an unhandled error — which returns a full stack trace, absolute paths and
  // all, straight to the caller. Catch it and answer like any other 401.
  try {
    if (await isSessionRevoked(session)) {
      res.status(401).json({ success: false, error: 'This session has been signed out.' });
      return;
    }
    if (!(await isSessionCurrent(session))) {
      res.status(401).json({ success: false, error: 'This session is no longer valid. Please sign in again.' });
      return;
    }
  } catch (error) {
    console.error('[auth] revocation check failed — refusing the request', error);
    res.status(503).json({ success: false, error: 'Authentication is temporarily unavailable.' });
    return;
  }

  req.session = session;
  next();
}

export function requireRole(...roles: SessionRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const role = req.session?.role;
    if (!role) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const permitted = roles.includes(role) || (role === 'SUPER_ADMIN' && roles.includes('ADMIN'));
    if (!permitted) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/* ============================================================
   ONE-TIME EMAIL TOKENS (verification & password reset)
   ============================================================ */

export type AuthTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export const PASSWORD_RESET_TTL_MINUTES = 30;
export const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Mints a one-time token for a user and returns the raw value to embed in the
 * email link. Only the hash is persisted.
 *
 * Any earlier, still-unused token of the same purpose is consumed first, so a
 * user who clicks "resend" repeatedly cannot accumulate live links.
 */
export async function issueAuthToken(
  userId: string,
  type: AuthTokenPurpose,
  ttlMinutes: number
): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');

  await prisma.authToken.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() }
  });

  await prisma.authToken.create({
    data: {
      userId,
      type,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000)
    }
  });

  return raw;
}

/**
 * Validates and consumes a one-time token, returning the owning user id.
 * Returns null for an unknown, already-used, expired or wrong-purpose token —
 * the caller must not distinguish between those cases to the client.
 */
export async function consumeAuthToken(raw: string, type: AuthTokenPurpose): Promise<string | null> {
  if (!raw || raw.length > 200) return null;

  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { id: true, userId: true, type: true, expiresAt: true, usedAt: true }
  });

  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  // Single-use: mark consumed before the caller acts on it.
  await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row.userId;
}

/** Clears spent or expired tokens. Safe to call on a timer. */
export async function pruneAuthTokens(): Promise<number> {
  const result = await prisma.authToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] }
  });
  return result.count;
}

/* ============================================================
   ROLE ROUTING
   ============================================================ */
export function landingPageFor(role: SessionRole): string {
  switch (role) {
    case 'ADMIN':
    case 'SUPER_ADMIN':
      return 'admin.html';
    case 'DEALER':
      return 'dealer-dashboard.html';
    default:
      return 'dashboard.html';
  }
}