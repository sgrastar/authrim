import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { resolveAuthMaxFailedAttempts, resolveEmailCodeTtlSeconds } from '../sign-in-limits';

const env = {} as EffectiveSettingsEnv;

describe('sign-in limits', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it('reads the tenant lockout threshold and code lifetime from their categories', async () => {
    resolveEffectiveSettings.mockImplementation(async (_env, category: string) =>
      category === 'rate-limit'
        ? { 'rate_limit.auth_max_failed_attempts': 8 }
        : { 'credentials.email_code_ttl': 600 }
    );

    await expect(resolveAuthMaxFailedAttempts(env, 't')).resolves.toBe(8);
    await expect(resolveEmailCodeTtlSeconds(env, 't')).resolves.toBe(600);
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'rate-limit', { tenantId: 't' });
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'credentials', { tenantId: 't' });
  });

  it.each([2, 21, 5.5, '8'])('keeps the default lockout threshold for %j', async (value) => {
    resolveEffectiveSettings.mockResolvedValue({ 'rate_limit.auth_max_failed_attempts': value });
    await expect(resolveAuthMaxFailedAttempts(env, 't')).resolves.toBe(5);
  });

  it.each([59, 901, 120.5])('keeps the default code lifetime for %j', async (value) => {
    resolveEffectiveSettings.mockResolvedValue({ 'credentials.email_code_ttl': value });
    await expect(resolveEmailCodeTtlSeconds(env, 't')).resolves.toBe(300);
  });

  it('keeps the limits it always used when the settings cannot be read', async () => {
    resolveEffectiveSettings.mockImplementation(async () => {
      throw new Error('settings unavailable');
    });
    await expect(resolveAuthMaxFailedAttempts(env, 't')).resolves.toBe(5);
    await expect(resolveEmailCodeTtlSeconds(env, 't')).resolves.toBe(300);
  });
});
