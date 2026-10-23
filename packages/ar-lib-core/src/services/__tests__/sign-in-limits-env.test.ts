import { describe, expect, it } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';
import { resolveTotpAttemptLimit } from '../sign-in-limits';

// Through the real settings resolver: the environment variables of the authenticator-app limit.
describe('resolveTotpAttemptLimit from the environment', () => {
  const resolve = (vars: Record<string, string>) =>
    resolveTotpAttemptLimit(vars as unknown as EffectiveSettingsEnv, 'tenant-a');

  it('applies values in range', async () => {
    await expect(
      resolve({ TOTP_RATE_LIMIT_MAX_REQUESTS: '40', TOTP_RATE_LIMIT_WINDOW: '600' })
    ).resolves.toEqual({ maxRequests: 40, windowSeconds: 600 });
  });

  it.each([
    ['fractions', '1000.9', '60.5'],
    ['trailing text', '40junk', '600s'],
    ['values out of range', '1001', '59'],
  ])('keeps the defaults for %s', async (_label, maxRequests, windowSeconds) => {
    await expect(
      resolve({ TOTP_RATE_LIMIT_MAX_REQUESTS: maxRequests, TOTP_RATE_LIMIT_WINDOW: windowSeconds })
    ).resolves.toEqual({ maxRequests: 10, windowSeconds: 900 });
  });
});
