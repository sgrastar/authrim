import { describe, expect, it } from 'vitest';
import {
  decodeBase32,
  encodeBase32,
  generateTotpCode,
  getTotpTimeStep,
  verifyTotpCode,
  type TotpProfile,
} from '../totp';

const SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';

describe('TOTP utilities', () => {
  it.each([
    [59, 'SHA1', SHA1_SECRET, '94287082'],
    [59, 'SHA256', SHA256_SECRET, '46119246'],
    [1_111_111_109, 'SHA1', SHA1_SECRET, '07081804'],
    [1_111_111_109, 'SHA256', SHA256_SECRET, '68084774'],
    [1_111_111_111, 'SHA1', SHA1_SECRET, '14050471'],
    [1_111_111_111, 'SHA256', SHA256_SECRET, '67062674'],
    [1_234_567_890, 'SHA1', SHA1_SECRET, '89005924'],
    [1_234_567_890, 'SHA256', SHA256_SECRET, '91819424'],
    [2_000_000_000, 'SHA1', SHA1_SECRET, '69279037'],
    [2_000_000_000, 'SHA256', SHA256_SECRET, '90698825'],
    [20_000_000_000, 'SHA1', SHA1_SECRET, '65353130'],
    [20_000_000_000, 'SHA256', SHA256_SECRET, '77737706'],
  ] as const)(
    'matches RFC 6238 vector at %s seconds with %s',
    async (timestampSeconds, algorithm, secret, expected) => {
      const profile: TotpProfile = {
        algorithm,
        digits: 8,
        period: 30,
        window: 1,
      };
      const timeStep = getTotpTimeStep(timestampSeconds * 1000, profile.period);

      await expect(generateTotpCode(secret, profile, timeStep)).resolves.toBe(expected);
    }
  );

  it('accepts adjacent time steps within the configured window', async () => {
    const profile: TotpProfile = {
      algorithm: 'SHA1',
      digits: 8,
      period: 30,
      window: 1,
    };
    const code = await generateTotpCode(SHA1_SECRET, profile, 10);

    await expect(
      verifyTotpCode({
        code,
        secretBase32: SHA1_SECRET,
        profile,
        nowMs: 11 * 30 * 1000,
      })
    ).resolves.toEqual({ valid: true, timeStep: 10 });
  });

  it('rejects replayed time steps', async () => {
    const profile: TotpProfile = {
      algorithm: 'SHA1',
      digits: 8,
      period: 30,
      window: 1,
    };
    const code = await generateTotpCode(SHA1_SECRET, profile, 10);

    await expect(
      verifyTotpCode({
        code,
        secretBase32: SHA1_SECRET,
        profile,
        nowMs: 10 * 30 * 1000,
        lastUsedTimeStep: 10,
      })
    ).resolves.toEqual({ valid: false, timeStep: null });
  });

  it('round trips base32 secrets', () => {
    const bytes = new TextEncoder().encode('authrim-totp-secret');
    expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
  });
});
