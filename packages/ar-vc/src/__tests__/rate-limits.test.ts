import { describe, expect, it } from 'vitest';
import { VC_RATE_LIMITS } from '../rate-limits';

describe('VC rate limits', () => {
  it('gives every endpoint its own bucket', () => {
    const classes = VC_RATE_LIMITS.map((limit) => limit.endpointClass);
    expect(new Set(classes).size).toBe(classes.length);
    expect(new Set(VC_RATE_LIMITS.map((limit) => limit.path)).size).toBe(VC_RATE_LIMITS.length);
  });

  it('keeps the issuance and presentation exchanges usable behind a shared NAT', () => {
    const profileOf = (path: string) =>
      VC_RATE_LIMITS.find((limit) => limit.path === path)?.profile;
    for (const path of [
      '/vci/offers/*',
      '/vci/token',
      '/vci/credential',
      '/vp/initiate',
      '/vp/response',
      '/vp/attribute-response',
    ]) {
      expect(profileOf(path)).toBe('lenient');
    }
    // Nonces are unauthenticated and stored until they expire.
    expect(profileOf('/vci/nonce')).toBe('moderate');
  });
});
