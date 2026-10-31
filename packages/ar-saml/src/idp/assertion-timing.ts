import { DEFAULTS } from '../common/constants';
import { formatDateTime } from '../common/xml-utils';

export interface SAMLAssertionTimingOptions {
  /** The issue instant: when the assertion is made. */
  now?: Date;
  /**
   * When the person authenticated (milliseconds), for AuthnInstant (see resolveSAMLAuthnInstant).
   * Never later than `now`; one that is missing or not a time counts as `now`.
   */
  authenticatedAtMs?: number;
  assertionValiditySeconds?: number;
  notBeforeSkewSeconds?: number;
}

export interface SAMLAssertionTiming {
  issueInstant: string;
  authnInstant: string;
  notBefore: string;
  notOnOrAfter: string;
}

/** Where the authentication time of an assertion came from. */
export type SAMLAuthnInstantSource =
  | 'proven_at'
  | 'reauth_proven_at'
  | 'auth_time'
  | 'session_created_at'
  /** Nothing usable was recorded: the time the assertion is issued stands in. */
  | 'unknown';

export interface SAMLAuthnInstant {
  /** When the person authenticated, in milliseconds (never later than the issue instant). */
  ms: number;
  source: SAMLAuthnInstantSource;
}

/** Nothing in the session can date an authentication before 2000. */
const EARLIEST_PLAUSIBLE_AUTHN_MS = Date.UTC(2000, 0, 1);

/**
 * A time the session recorded, as milliseconds the assertion can state: a number that is a time
 * between 2000 and now (a clock a little ahead of this one is read as now). Anything else (not a
 * number, seconds where milliseconds are expected, a time well in the future) is no time at all.
 */
function plausibleAuthnMs(value: unknown, nowMs: number, skewMs: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < EARLIEST_PLAUSIBLE_AUTHN_MS || value >= nowMs + skewMs) return undefined;
  return Math.min(value, nowMs);
}

/**
 * When the person authenticated, for the AuthnInstant of an assertion (SAML Core: the time at
 * which the authentication took place, not the time the assertion is issued).
 *
 * The latest of what the session records, all of it Authrim's own clock:
 * - `proven_at` (milliseconds): when the proof was verified;
 * - `reauth_proven_at` (milliseconds): a re-authentication completed in the session, which is a
 *   new authentication;
 * - `authTime` / `auth_time` (seconds): the login time the flows write (`authTime`; the DID login
 *   writes `auth_time`), taken from Authrim's clock when the login completed. A login by an
 *   external IdP records no `proven_at`: the IdP's own auth_time is in the IdP's clock, and no
 *   flow stores it in the session (Direct Auth gives such a login Authrim's redeem time as
 *   `authTime`; the bridge callback records neither, so `createdAt` dates it). A step-up login
 *   combined into the session keeps its own `authTime` while `proven_at` is rewritten to the
 *   oldest proof, so it counts.
 * When none is usable: the time the session was created (`createdAt`, Authrim's clock as well),
 * and when that is not usable either, the issue instant (`source: 'unknown'`; the caller logs it).
 * A session reused for single sign-on therefore keeps the time of its login.
 */
export function resolveSAMLAuthnInstant(
  data: Record<string, unknown> | undefined,
  options: { createdAt?: unknown; nowMs: number; clockSkewSeconds?: number }
): SAMLAuthnInstant {
  const { nowMs } = options;
  const skewMs = (options.clockSkewSeconds ?? DEFAULTS.CLOCK_SKEW_SECONDS) * 1000;
  const seconds = (value: unknown): unknown =>
    typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;

  const candidates: Array<[SAMLAuthnInstantSource, unknown]> = [
    ['proven_at', data?.proven_at],
    ['reauth_proven_at', data?.reauth_proven_at],
    ['auth_time', seconds(data?.authTime)],
    ['auth_time', seconds(data?.auth_time)],
  ];
  let best: SAMLAuthnInstant | undefined;
  for (const [source, value] of candidates) {
    const ms = plausibleAuthnMs(value, nowMs, skewMs);
    if (ms !== undefined && (!best || ms > best.ms)) best = { ms, source };
  }
  if (best) return best;

  const created = plausibleAuthnMs(options.createdAt, nowMs, skewMs);
  if (created !== undefined) return { ms: created, source: 'session_created_at' };
  return { ms: nowMs, source: 'unknown' };
}

export function buildSAMLAssertionTiming(
  options: SAMLAssertionTimingOptions = {}
): SAMLAssertionTiming {
  const now = options.now ?? new Date();
  const validitySeconds = options.assertionValiditySeconds ?? DEFAULTS.ASSERTION_VALIDITY_SECONDS;
  const notBeforeSkewSeconds = options.notBeforeSkewSeconds ?? DEFAULTS.CLOCK_SKEW_SECONDS;

  if (!Number.isFinite(validitySeconds) || validitySeconds <= 0) {
    throw new Error('SAML assertion validity must be a positive number of seconds');
  }
  if (!Number.isFinite(notBeforeSkewSeconds) || notBeforeSkewSeconds < 0) {
    throw new Error('SAML assertion NotBefore skew must be zero or a positive number of seconds');
  }

  const notBefore = new Date(now.getTime() - notBeforeSkewSeconds * 1000);
  const notOnOrAfter = new Date(now.getTime() + validitySeconds * 1000);

  // The authentication happened at or before the issue instant, never after it; a time that
  // cannot be one stands for the issue instant.
  const authenticatedAt = options.authenticatedAtMs;
  const authnInstant =
    typeof authenticatedAt === 'number' &&
    Number.isFinite(authenticatedAt) &&
    authenticatedAt >= EARLIEST_PLAUSIBLE_AUTHN_MS
      ? new Date(Math.min(authenticatedAt, now.getTime()))
      : now;

  return {
    issueInstant: formatDateTime(now),
    authnInstant: formatDateTime(authnInstant),
    notBefore: formatDateTime(notBefore),
    notOnOrAfter: formatDateTime(notOnOrAfter),
  };
}
