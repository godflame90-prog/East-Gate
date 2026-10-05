import { prisma } from './db';

/**
 * Failed-login throttling, persisted in Postgres.
 *
 * This was an in-process Map, which had two consequences that quietly defeated
 * the control it existed to provide: a server restart cleared every lockout, and
 * more than one instance enforced its own independent count. The table is the
 * single source of truth, so counters now survive restarts and are shared.
 */

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 8;

/**
 * Short-lived read cache. Sign-in is not a hot path, but the throttle is consulted
 * on every login request and a cache keeps the common case off the database. It is
 * only ever a cache: a miss falls through to the table, so correctness never
 * depends on it and eviction can only cost an extra query.
 */
const CACHE_TTL_MS = 5_000;
interface CacheEntry {
  count: number;
  firstAt: number;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string, now: number): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size > 10_000) cache.clear();
  cache.set(key, entry);
}

/** Identifies the caller for throttling purposes. */
export function throttleKey(ip: string | undefined): string {
  return ip || 'unknown';
}

/** True when this client has burned through its attempts for the current window. */
export async function isThrottled(key: string): Promise<boolean> {
  const now = Date.now();

  const cached = cacheGet(key, now);
  if (cached) return cached.count >= LOGIN_MAX_ATTEMPTS;

  const record = await prisma.loginThrottle.findUnique({ where: { key } });

  if (!record) {
    cacheSet(key, { count: 0, firstAt: now, expiresAt: now + CACHE_TTL_MS });
    return false;
  }

  // The window has rolled over — the stored count no longer applies.
  if (now - record.firstAt.getTime() > LOGIN_WINDOW_MS) {
    await prisma.loginThrottle.delete({ where: { key } }).catch(() => undefined);
    cacheSet(key, { count: 0, firstAt: now, expiresAt: now + CACHE_TTL_MS });
    return false;
  }

  const entry: CacheEntry = {
    count: record.count,
    firstAt: record.firstAt.getTime(),
    expiresAt: now + CACHE_TTL_MS
  };
  cacheSet(key, entry);
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

/** Adds one failed attempt, starting a fresh window if the last one expired. */
export async function recordFailedAttempt(key: string): Promise<void> {
  const now = new Date();

  const existing = await prisma.loginThrottle.findUnique({ where: { key } });

  if (!existing || now.getTime() - existing.firstAt.getTime() > LOGIN_WINDOW_MS) {
    await prisma.loginThrottle.upsert({
      where: { key },
      create: { key, count: 1, firstAt: now },
      update: { count: 1, firstAt: now }
    });
    cacheSet(key, { count: 1, firstAt: now.getTime(), expiresAt: Date.now() + CACHE_TTL_MS });
    return;
  }

  const count = existing.count + 1;
  await prisma.loginThrottle.update({ where: { key }, data: { count } });
  cacheSet(key, { count, firstAt: existing.firstAt.getTime(), expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clears the counter after a successful sign-in. */
export async function clearAttempts(key: string): Promise<void> {
  cache.delete(key);
  await prisma.loginThrottle.delete({ where: { key } }).catch(() => undefined);
}

/** Drops counters whose window closed long ago. Call periodically. */
export async function pruneThrottles(): Promise<number> {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MS);
  const result = await prisma.loginThrottle.deleteMany({
    where: { firstAt: { lt: cutoff } }
  });
  return result.count;
}
