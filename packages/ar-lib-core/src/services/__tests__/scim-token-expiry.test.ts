import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { resolveScimTokenExpiryDays } from '../scim-token-expiry';

const env = {} as EffectiveSettingsEnv;
const DAY = 86400;

describe('resolveScimTokenExpiryDays', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it('gives a year by default and at most a year where nothing is set', async () => {
    resolveEffectiveSettings.mockResolvedValue({});
    await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toEqual({
      defaultDays: 365,
      maxDays: 365,
    });
  });

  it("reads the tenant's default and maximum in seconds and gives them in days", async () => {
    resolveEffectiveSettings.mockResolvedValue({
      'federation.scim_token_default_expiry': 30 * DAY,
      'federation.scim_token_max_expiry': 90 * DAY,
    });
    await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toEqual({
      defaultDays: 30,
      maxDays: 90,
    });
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'federation', { tenantId: 't' });
  });

  it('rounds a value that is not whole days down, and keeps at least a day', async () => {
    resolveEffectiveSettings.mockResolvedValue({
      'federation.scim_token_default_expiry': 2 * DAY + 3600,
      'federation.scim_token_max_expiry': 10 * DAY + 86399,
    });
    await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toEqual({
      defaultDays: 2,
      maxDays: 10,
    });
  });

  it('never gives a default longer than the maximum', async () => {
    resolveEffectiveSettings.mockResolvedValue({ 'federation.scim_token_max_expiry': 30 * DAY });
    await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toEqual({
      defaultDays: 30,
      maxDays: 30,
    });
    resolveEffectiveSettings.mockResolvedValue({
      'federation.scim_token_default_expiry': 200 * DAY,
      'federation.scim_token_max_expiry': 100 * DAY,
    });
    await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toEqual({
      defaultDays: 100,
      maxDays: 100,
    });
  });

  it.each([0, DAY - 1, 365 * DAY + 1, 10 * 365 * DAY, 1.5 * DAY + 0.5, '30', null, Infinity])(
    'keeps the one-year maximum for %j',
    async (value) => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.scim_token_max_expiry': value });
      await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toMatchObject({ maxDays: 365 });
    }
  );

  it.each([0, DAY - 1, 365 * DAY + 1, 0.5, '30', null])(
    'keeps the one-year default for %j',
    async (value) => {
      resolveEffectiveSettings.mockResolvedValue({ 'federation.scim_token_default_expiry': value });
      await expect(resolveScimTokenExpiryDays(env, 't')).resolves.toMatchObject({
        defaultDays: 365,
      });
    }
  );

  it('does not answer when the settings cannot be read: a maximum is never relaxed by an outage', async () => {
    resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
    await expect(resolveScimTokenExpiryDays(env, 't')).rejects.toThrow('settings unavailable');
  });
});
