import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Runtime feature flags.
 *
 * Kept in one place so the rules are auditable rather than scattered across
 * route handlers as inline `process.env` checks.
 */

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Whether the one-click demo accounts are exposed on the login page.
 *
 * Defaults to on outside production so local development keeps working, and off
 * in production so the seeded demo passwords — which are published in README.md
 * and identical on every install — are never handed to whoever loads the page.
 * Set DEMO_LOGIN=0 to disable it locally.
 */
export function demoLoginEnabled(): boolean {
  const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  return envFlag('DEMO_LOGIN', !isProduction);
}

/**
 * Serves the pages themselves. When false, HTML responses get no-store too,
 * which is what you want for a deploy where users should not sit on a stale
 * bundle after a release.
 */
export function isProduction(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}
