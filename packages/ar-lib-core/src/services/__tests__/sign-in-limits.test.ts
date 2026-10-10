import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import {
  resolveAuthMaxFailedAttempts,
  resolveEmailCodeTtlSeconds,
  resolveEmailSendLimit,
} from '../sign-in-limits';

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

  describe('resolveEmailSendLimit', () => {
    it('reads the tenant email send limit and its window from rate-limit', async () => {
      resolveEffectiveSettings.mockResolvedValue({
        'rate_limit.email_max_requests': 6,
        'rate_limit.email_window': 1800,
      });
      await expect(resolveEmailSendLimit(env, 't')).resolves.toEqual({
        maxRequests: 6,
        windowSeconds: 1800,
      });
      expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'rate-limit', { tenantId: 't' });
    });

    it('keeps 3 sends per 15 minutes where nothing is set', async () => {
      resolveEffectiveSettings.mockResolvedValue({});
      await expect(resolveEmailSendLimit(env, 't')).resolves.toEqual({
        maxRequests: 3,
        windowSeconds: 900,
      });
    });

    it('falls back for each value that is out of range, and keeps the other', async () => {
      resolveEffectiveSettings.mockResolvedValue({
        'rate_limit.email_max_requests': 11,
        'rate_limit.email_window': 1200,
      });
      await expect(resolveEmailSendLimit(env, 't')).resolves.toEqual({
        maxRequests: 3,
        windowSeconds: 1200,
      });
      resolveEffectiveSettings.mockResolvedValue({
        'rate_limit.email_max_requests': 5,
        'rate_limit.email_window': 60,
      });
      await expect(resolveEmailSendLimit(env, 't')).resolves.toEqual({
        maxRequests: 5,
        windowSeconds: 900,
      });
    });

    it.each([0, 11, 2.5, '5', null])('keeps 3 sends for %j', async (value) => {
      resolveEffectiveSettings.mockResolvedValue({ 'rate_limit.email_max_requests': value });
      await expect(resolveEmailSendLimit(env, 't')).resolves.toMatchObject({ maxRequests: 3 });
    });

    it.each([299, 3601, 900.5, '900'])('keeps a 900 second window for %j', async (value) => {
      resolveEffectiveSettings.mockResolvedValue({ 'rate_limit.email_window': value });
      await expect(resolveEmailSendLimit(env, 't')).resolves.toMatchObject({ windowSeconds: 900 });
    });

    it('keeps the limit it always used when the settings cannot be read', async () => {
      resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
      await expect(resolveEmailSendLimit(env, 't')).resolves.toEqual({
        maxRequests: 3,
        windowSeconds: 900,
      });
    });
  });
});
