import { describe, expect, it } from 'vitest';
import {
  AGENT_GRANT_DEFAULT_TTL_MS,
  AGENT_GRANT_MAX_TTL_MS,
  AGENT_GRANT_MIN_TTL_MS,
  resolveAgentGrantExpiration,
} from '../grant-lifecycle';

describe('Agent Grant recertification deadline', () => {
  const now = 1_800_000_000_000;

  it('defaults a new Grant to 30 days and accepts seconds or milliseconds', () => {
    expect(resolveAgentGrantExpiration(undefined, now)).toBe(now + AGENT_GRANT_DEFAULT_TTL_MS);
    expect(resolveAgentGrantExpiration((now + AGENT_GRANT_MIN_TTL_MS) / 1000, now)).toBe(
      now + AGENT_GRANT_MIN_TTL_MS
    );
    expect(resolveAgentGrantExpiration(now + AGENT_GRANT_MAX_TTL_MS, now)).toBe(
      now + AGENT_GRANT_MAX_TTL_MS
    );
  });

  it('rejects permanent, near-expiry, expired, malformed, and over-90-day Grants', () => {
    expect(resolveAgentGrantExpiration(null, now)).toBeNull();
    expect(resolveAgentGrantExpiration(now, now)).toBeNull();
    expect(resolveAgentGrantExpiration(now + AGENT_GRANT_MIN_TTL_MS - 1, now)).toBeNull();
    expect(resolveAgentGrantExpiration(now + AGENT_GRANT_MAX_TTL_MS + 1, now)).toBeNull();
    expect(resolveAgentGrantExpiration('tomorrow', now)).toBeNull();
  });
});
