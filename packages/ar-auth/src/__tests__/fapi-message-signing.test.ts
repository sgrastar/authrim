import { describe, expect, it } from 'vitest';
import { validateFAPI2MessageSigningRequestObjectClaims } from '../fapi-message-signing';

describe('FAPI 2.0 Message Signing request object claims', () => {
  const now = 1_800_000_000;

  it('accepts a bounded request object and a small future nbf', () => {
    expect(
      validateFAPI2MessageSigningRequestObjectClaims(
        { nbf: now + 8, exp: now + 308 },
        { nowSeconds: now }
      )
    ).toBeNull();
  });

  it.each([
    [{ exp: now + 60 }, 'nbf claim is required'],
    [{ nbf: now }, 'exp claim is required'],
    [{ nbf: now - 4200, exp: now + 60 }, 'nbf claim must not be more than 3600 seconds'],
    [{ nbf: now, exp: now + 3601 }, 'request object lifetime must not exceed 3600 seconds'],
    [{ nbf: now, exp: now }, 'exp claim must be later than nbf'],
    [{ nbf: 1.5, exp: now + 60 }, 'nbf claim is required'],
  ])('rejects invalid claims %#', (claims, expected) => {
    expect(
      validateFAPI2MessageSigningRequestObjectClaims(claims, { nowSeconds: now })
    ).toContain(expected);
  });
});
