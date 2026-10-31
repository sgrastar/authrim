import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { CIBA_HARD_LIMITS, resolveCibaConfig } from '../ciba-config';
import { CIBA_CONSTANTS } from '../../utils/ciba';

const env = {} as EffectiveSettingsEnv;

const resolveWith = (values: Record<string, unknown>) => {
  resolveEffectiveSettings.mockResolvedValue(values);
  return resolveCibaConfig(env, 't');
};

describe('resolveCibaConfig', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it('reads the tenant ciba category', async () => {
    await resolveWith({});
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'ciba', { tenantId: 't' });
  });

  it('defaults are the constants the endpoint always used', async () => {
    await expect(resolveWith({})).resolves.toEqual({
      expiresIn: CIBA_CONSTANTS.DEFAULT_EXPIRES_IN,
      minExpiresIn: CIBA_CONSTANTS.MIN_EXPIRES_IN,
      maxExpiresIn: CIBA_CONSTANTS.MAX_EXPIRES_IN,
      pollInterval: CIBA_CONSTANTS.DEFAULT_INTERVAL,
      minInterval: CIBA_CONSTANTS.MIN_INTERVAL,
      maxInterval: CIBA_CONSTANTS.MAX_INTERVAL,
      maxBindingMessageLength: CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH,
      bindingMessageRequired: false,
      slowDownIncrement: CIBA_CONSTANTS.SLOW_DOWN_INCREMENT,
      maxPollCount: CIBA_CONSTANTS.MAX_POLL_COUNT,
      userCodeEnabled: false,
      // PING_NOTIFICATION_TIMEOUT_MS of notifications/ciba-ping.ts
      pingNotificationTimeoutMs: 5000,
    });
  });

  it('uses values inside the setting ranges', async () => {
    await expect(
      resolveWith({
        'ciba.expires_in': 120,
        'ciba.min_expires_in': 90,
        'ciba.max_expires_in': 900,
        'ciba.poll_interval': 10,
        'ciba.min_interval': 4,
        'ciba.max_interval': 120,
        'ciba.max_binding_message_length': 200,
        'ciba.binding_message_required': true,
        'ciba.slow_down_increment': 12,
        'ciba.max_poll_count': 300,
        'ciba.user_code_enabled': true,
        'ciba.ping_notification_timeout_ms': 12000,
      })
    ).resolves.toEqual({
      expiresIn: 120,
      minExpiresIn: 90,
      maxExpiresIn: 900,
      pollInterval: 10,
      minInterval: 4,
      maxInterval: 120,
      maxBindingMessageLength: 200,
      bindingMessageRequired: true,
      slowDownIncrement: 12,
      maxPollCount: 300,
      userCodeEnabled: true,
      pingNotificationTimeoutMs: 12000,
    });
  });

  it.each([
    ['ciba.expires_in', 59, 'expiresIn', 300],
    ['ciba.expires_in', 601, 'expiresIn', 300],
    ['ciba.min_expires_in', 29, 'minExpiresIn', 60],
    ['ciba.max_expires_in', 3601, 'maxExpiresIn', 600],
    ['ciba.poll_interval', 1, 'pollInterval', 5],
    ['ciba.poll_interval', 61, 'pollInterval', 5],
    ['ciba.min_interval', 61, 'minInterval', 2],
    ['ciba.max_interval', 301, 'maxInterval', 60],
    ['ciba.max_binding_message_length', 49, 'maxBindingMessageLength', 140],
    ['ciba.max_binding_message_length', 501, 'maxBindingMessageLength', 140],
    ['ciba.slow_down_increment', 4, 'slowDownIncrement', 5],
    ['ciba.slow_down_increment', 1, 'slowDownIncrement', 5],
    ['ciba.slow_down_increment', 31, 'slowDownIncrement', 5],
    ['ciba.max_poll_count', 9, 'maxPollCount', 120],
    ['ciba.max_poll_count', 501, 'maxPollCount', 120],
    ['ciba.ping_notification_timeout_ms', 999, 'pingNotificationTimeoutMs', 5000],
    ['ciba.ping_notification_timeout_ms', 30001, 'pingNotificationTimeoutMs', 5000],
  ] as const)(
    'keeps the default for %s = %j (out of range)',
    async (key, value, field, fallback) => {
      expect((await resolveWith({ [key]: value }))[field]).toBe(fallback);
    }
  );

  it.each([5.5, '8', null, true, NaN, Infinity])(
    'keeps the default poll interval and binding message length for %j (not a whole number)',
    async (value) => {
      expect((await resolveWith({ 'ciba.poll_interval': value })).pollInterval).toBe(5);
      expect(
        (await resolveWith({ 'ciba.max_binding_message_length': value })).maxBindingMessageLength
      ).toBe(140);
    }
  );

  it.each([5.5, '8', null, true, NaN, Infinity])(
    'keeps the default slow_down increment, poll count and ping timeout for %j (not a whole number)',
    async (value) => {
      expect((await resolveWith({ 'ciba.slow_down_increment': value })).slowDownIncrement).toBe(5);
      expect((await resolveWith({ 'ciba.max_poll_count': value })).maxPollCount).toBe(120);
      expect(
        (await resolveWith({ 'ciba.ping_notification_timeout_ms': value }))
          .pingNotificationTimeoutMs
      ).toBe(5000);
    }
  );

  it.each(['true', 1, 'yes', null, undefined])(
    'keeps user_code_enabled off for %j (not a boolean)',
    async (value) => {
      expect((await resolveWith({ 'ciba.user_code_enabled': value })).userCodeEnabled).toBe(false);
    }
  );

  it('takes the edges of the new ranges', async () => {
    expect(
      await resolveWith({
        'ciba.slow_down_increment': 5,
        'ciba.max_poll_count': 10,
        'ciba.ping_notification_timeout_ms': 1000,
      })
    ).toMatchObject({ slowDownIncrement: 5, maxPollCount: 10, pingNotificationTimeoutMs: 1000 });
    expect(
      await resolveWith({
        'ciba.slow_down_increment': 30,
        'ciba.max_poll_count': 500,
        'ciba.ping_notification_timeout_ms': 30000,
      })
    ).toMatchObject({ slowDownIncrement: 30, maxPollCount: 500, pingNotificationTimeoutMs: 30000 });
  });

  it.each(['true', 1, 'yes', null, undefined])(
    'keeps binding_message_required off for %j (not a boolean)',
    async (value) => {
      expect(
        (await resolveWith({ 'ciba.binding_message_required': value })).bindingMessageRequired
      ).toBe(false);
    }
  );

  it('throws when the settings cannot be read, so the caller refuses', async () => {
    resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
    await expect(resolveCibaConfig(env, 't')).rejects.toThrow('settings unavailable');
  });

  describe('relations', () => {
    it('uses the defaults of both expiry bounds when the minimum is above the maximum', async () => {
      const config = await resolveWith({
        'ciba.min_expires_in': 500,
        'ciba.max_expires_in': 100,
      });
      expect(config.minExpiresIn).toBe(60);
      expect(config.maxExpiresIn).toBe(600);
    });

    it('uses the defaults of both interval bounds when the minimum is above the maximum', async () => {
      const config = await resolveWith({ 'ciba.min_interval': 40, 'ciba.max_interval': 10 });
      expect(config.minInterval).toBe(2);
      expect(config.maxInterval).toBe(60);
    });

    it('treats equal bounds as usable', async () => {
      const config = await resolveWith({
        'ciba.min_expires_in': 120,
        'ciba.max_expires_in': 120,
        'ciba.min_interval': 10,
        'ciba.max_interval': 10,
      });
      expect(config).toMatchObject({
        expiresIn: 120,
        minExpiresIn: 120,
        maxExpiresIn: 120,
        pollInterval: 10,
        minInterval: 10,
        maxInterval: 10,
      });
    });

    it('clamps the default lifetime into the bounds', async () => {
      expect((await resolveWith({ 'ciba.min_expires_in': 400 })).expiresIn).toBe(400);
      expect((await resolveWith({ 'ciba.max_expires_in': 100 })).expiresIn).toBe(100);
      expect(
        (await resolveWith({ 'ciba.expires_in': 600, 'ciba.max_expires_in': 200 })).expiresIn
      ).toBe(200);
    });

    it('clamps the poll interval into the bounds', async () => {
      expect((await resolveWith({ 'ciba.min_interval': 20 })).pollInterval).toBe(20);
      expect((await resolveWith({ 'ciba.max_interval': 5 })).pollInterval).toBe(5);
      expect(
        (await resolveWith({ 'ciba.poll_interval': 50, 'ciba.max_interval': 30 })).pollInterval
      ).toBe(30);
    });

    it('clamps against the defaults of a pair that was the wrong way round', async () => {
      const config = await resolveWith({
        'ciba.expires_in': 600,
        'ciba.min_expires_in': 500,
        'ciba.max_expires_in': 100,
      });
      expect(config.expiresIn).toBe(600);
    });
  });

  describe('limits held in code', () => {
    it('never goes past them whatever is stored', async () => {
      const config = await resolveWith({
        'ciba.max_expires_in': 99999,
        'ciba.max_interval': 99999,
        'ciba.max_binding_message_length': 99999,
        'ciba.expires_in': 99999,
        'ciba.poll_interval': 99999,
      });
      expect(config.maxExpiresIn).toBeLessThanOrEqual(CIBA_HARD_LIMITS.maxExpiresIn);
      expect(config.maxInterval).toBeLessThanOrEqual(CIBA_HARD_LIMITS.maxInterval);
      expect(config.maxBindingMessageLength).toBeLessThanOrEqual(
        CIBA_HARD_LIMITS.maxBindingMessageLength
      );
      expect(config.expiresIn).toBeLessThanOrEqual(CIBA_HARD_LIMITS.maxExpiresIn);
      expect(config.pollInterval).toBeLessThanOrEqual(CIBA_HARD_LIMITS.maxInterval);
    });

    it('keeps the slow_down increment within 5..30 seconds whatever is stored', async () => {
      // out of the setting's range, so the default (5) stands; and the floor holds on its own
      for (const value of [-1, 0, 1, 4, 31, 99999]) {
        const { slowDownIncrement } = await resolveWith({ 'ciba.slow_down_increment': value });
        expect(slowDownIncrement, String(value)).toBeGreaterThanOrEqual(
          CIBA_HARD_LIMITS.minSlowDownIncrement
        );
        expect(slowDownIncrement, String(value)).toBeLessThanOrEqual(
          CIBA_HARD_LIMITS.maxSlowDownIncrement
        );
      }
      expect(CIBA_HARD_LIMITS.minSlowDownIncrement).toBe(5);
    });

    it('keeps the poll count and the ping timeout within their caps', async () => {
      const config = await resolveWith({
        'ciba.max_poll_count': 99999,
        'ciba.ping_notification_timeout_ms': 99999,
      });
      expect(config.maxPollCount).toBeLessThanOrEqual(CIBA_HARD_LIMITS.maxPollCount);
      expect(config.pingNotificationTimeoutMs).toBeLessThanOrEqual(
        CIBA_HARD_LIMITS.maxPingNotificationTimeoutMs
      );
    });

    it('keeps the minimum interval at 2 seconds even for a stored 1', async () => {
      const config = await resolveWith({ 'ciba.min_interval': 1, 'ciba.poll_interval': 2 });
      expect(config.minInterval).toBe(2);
      expect(config.pollInterval).toBeGreaterThanOrEqual(2);
    });
  });
});
