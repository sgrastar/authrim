export const AGENT_GRANT_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AGENT_GRANT_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AGENT_GRANT_MIN_TTL_MS = 60 * 60 * 1000;

/**
 * Agent Grants are never permanent. Expiration is also the recertification deadline: renewal
 * increments consent_version and revokes the previous token family through the existing update
 * transaction.
 */
export function resolveAgentGrantExpiration(value: unknown, now: number): number | null {
  const candidate =
    value === undefined
      ? now + AGENT_GRANT_DEFAULT_TTL_MS
      : typeof value === 'number' && Number.isFinite(value)
        ? value < 1e12
          ? Math.floor(value * 1000)
          : Math.floor(value)
        : Number.NaN;
  if (!Number.isSafeInteger(candidate)) return null;
  if (candidate < now + AGENT_GRANT_MIN_TTL_MS || candidate > now + AGENT_GRANT_MAX_TTL_MS) {
    return null;
  }
  return candidate;
}
