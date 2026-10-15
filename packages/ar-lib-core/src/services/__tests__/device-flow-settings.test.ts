import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { DEVICE_FLOW_HARD_LIMITS, resolveDeviceFlowPolicy } from '../device-flow-settings';
import { DEVICE_FLOW_CONSTANTS } from '../../utils/device-flow';

const env = {} as EffectiveSettingsEnv;

/** The tenant's document, and (for a client) the client's, which falls back to the tenant's. */
const resolveWith = (tenant: Record<string, unknown>, client?: Record<string, unknown>) => {
  resolveEffectiveSettings.mockImplementation(
    async (_env: unknown, _category: string, target: { clientId?: string }) =>
      target.clientId ? { ...tenant, ...client } : tenant
  );
  return resolveDeviceFlowPolicy(env, 't', client ? 'c' : undefined);
};

describe('resolveDeviceFlowPolicy', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it('reads the device-flow category of the tenant', async () => {
    await resolveWith({});
    expect(resolveEffectiveSettings).toHaveBeenCalledTimes(1);
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'device-flow', { tenantId: 't' });
  });

  it('reads the tenant and the client when the client is known', async () => {
    await resolveWith({}, {});
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'device-flow', { tenantId: 't' });
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'device-flow', {
      tenantId: 't',
      clientId: 'c',
    });
  });

  it('defaults are what the endpoint always issued', async () => {
    const expected = {
      expiresIn: DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN,
      minExpiresIn: DEVICE_FLOW_CONSTANTS.MIN_EXPIRES_IN,
      maxExpiresIn: DEVICE_FLOW_CONSTANTS.MAX_EXPIRES_IN,
      pollInterval: DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL,
      // the default lower bound (5) is not the old unused constant (1); it equals the default
      // interval, so the default interval is unchanged
      minInterval: 5,
      maxInterval: DEVICE_FLOW_CONSTANTS.MAX_INTERVAL,
      slowDownIncrement: DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT,
      maxPollCount: DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT,
    };
    await expect(resolveWith({})).resolves.toEqual(expected);
    await expect(resolveWith({}, {})).resolves.toEqual(expected);
  });

  it('uses values inside the setting ranges', async () => {
    await expect(
      resolveWith({
        'device_flow.expires_in': 900,
        'device_flow.min_expires_in': 400,
        'device_flow.max_expires_in': 1500,
        'device_flow.poll_interval': 10,
        'device_flow.min_interval': 4,
        'device_flow.max_interval': 120,
        'device_flow.slow_down_increment': 12,
        'device_flow.max_poll_count': 300,
      })
    ).resolves.toEqual({
      expiresIn: 900,
      minExpiresIn: 400,
      maxExpiresIn: 1500,
      pollInterval: 10,
      minInterval: 4,
      maxInterval: 120,
      slowDownIncrement: 12,
      maxPollCount: 300,
    });
  });

  it.each([
    ['device_flow.expires_in', 299, 'expiresIn', 600],
    ['device_flow.expires_in', 1801, 'expiresIn', 600],
    ['device_flow.min_expires_in', 59, 'minExpiresIn', 300],
    ['device_flow.max_expires_in', 3601, 'maxExpiresIn', 1800],
    ['device_flow.poll_interval', 0, 'pollInterval', 5],
    ['device_flow.poll_interval', 61, 'pollInterval', 5],
    ['device_flow.min_interval', 61, 'minInterval', 5],
    ['device_flow.max_interval', 301, 'maxInterval', 60],
    ['device_flow.max_interval', 4, 'maxInterval', 60],
    ['device_flow.slow_down_increment', 4, 'slowDownIncrement', 5],
    ['device_flow.slow_down_increment', 1, 'slowDownIncrement', 5],
    ['device_flow.slow_down_increment', 31, 'slowDownIncrement', 5],
    ['device_flow.max_poll_count', 9, 'maxPollCount', 120],
    ['device_flow.max_poll_count', 501, 'maxPollCount', 120],
  ] as const)(
    'keeps the default for %s = %j (out of range)',
    async (key, value, field, fallback) => {
      expect((await resolveWith({ [key]: value }))[field]).toBe(fallback);
      expect((await resolveWith({}, { [key]: value }))[field]).toBe(fallback);
    }
  );

  it.each([5.5, '8', null, true, NaN, Infinity])(
    'keeps every default for %j (not a whole number)',
    async (value) => {
      const policy = await resolveWith({
        'device_flow.expires_in': value,
        'device_flow.min_expires_in': value,
        'device_flow.max_expires_in': value,
        'device_flow.poll_interval': value,
        'device_flow.min_interval': value,
        'device_flow.max_interval': value,
        'device_flow.slow_down_increment': value,
        'device_flow.max_poll_count': value,
      });
      expect(policy).toEqual(await resolveWith({}));
    }
  );

  it('takes the edges of the ranges', async () => {
    expect(
      await resolveWith({
        'device_flow.slow_down_increment': 5,
        'device_flow.max_poll_count': 10,
        'device_flow.min_interval': 1,
        'device_flow.poll_interval': 1,
      })
    ).toMatchObject({ slowDownIncrement: 5, maxPollCount: 10, minInterval: 1, pollInterval: 1 });
    expect(
      await resolveWith({
        'device_flow.slow_down_increment': 30,
        'device_flow.max_poll_count': 500,
        'device_flow.max_interval': 300,
        'device_flow.max_expires_in': 3600,
      })
    ).toMatchObject({
      slowDownIncrement: 30,
      maxPollCount: 500,
      maxInterval: 300,
      maxExpiresIn: 3600,
    });
  });

  it('throws when the settings cannot be read, so the caller refuses', async () => {
    resolveEffectiveSettings.mockRejectedValue(new Error('settings unavailable'));
    await expect(resolveDeviceFlowPolicy(env, 't')).rejects.toThrow('settings unavailable');
    await expect(resolveDeviceFlowPolicy(env, 't', 'c')).rejects.toThrow('settings unavailable');
  });

  it('throws when only the client document cannot be read', async () => {
    resolveEffectiveSettings.mockImplementation(
      async (_env: unknown, _category: string, target: { clientId?: string }) => {
        if (target.clientId) throw new Error('client settings unavailable');
        return {};
      }
    );
    await expect(resolveDeviceFlowPolicy(env, 't', 'c')).rejects.toThrow(
      'client settings unavailable'
    );
  });

  describe('relations', () => {
    it('uses the defaults of both expiry bounds when the minimum is above the maximum', async () => {
      const policy = await resolveWith({
        'device_flow.min_expires_in': 1500,
        'device_flow.max_expires_in': 400,
      });
      expect(policy.minExpiresIn).toBe(300);
      expect(policy.maxExpiresIn).toBe(1800);
    });

    it('uses the defaults of both interval bounds when the minimum is above the maximum', async () => {
      const policy = await resolveWith({
        'device_flow.min_interval': 40,
        'device_flow.max_interval': 10,
      });
      expect(policy.minInterval).toBe(5);
      expect(policy.maxInterval).toBe(60);
    });

    it('treats equal bounds as usable', async () => {
      const policy = await resolveWith({
        'device_flow.min_expires_in': 400,
        'device_flow.max_expires_in': 400,
        'device_flow.min_interval': 10,
        'device_flow.max_interval': 10,
      });
      expect(policy).toMatchObject({
        expiresIn: 400,
        minExpiresIn: 400,
        maxExpiresIn: 400,
        pollInterval: 10,
        minInterval: 10,
        maxInterval: 10,
      });
    });

    it('clamps the code lifetime into the bounds', async () => {
      expect((await resolveWith({ 'device_flow.min_expires_in': 900 })).expiresIn).toBe(900);
      expect((await resolveWith({ 'device_flow.max_expires_in': 400 })).expiresIn).toBe(400);
      expect(
        (await resolveWith({ 'device_flow.expires_in': 1500, 'device_flow.max_expires_in': 700 }))
          .expiresIn
      ).toBe(700);
    });

    it('clamps the poll interval into the bounds', async () => {
      expect((await resolveWith({ 'device_flow.min_interval': 20 })).pollInterval).toBe(20);
      expect((await resolveWith({ 'device_flow.max_interval': 5 })).pollInterval).toBe(5);
      expect(
        (await resolveWith({ 'device_flow.poll_interval': 50, 'device_flow.max_interval': 30 }))
          .pollInterval
      ).toBe(30);
      // a poll interval below the default lower bound (5) is raised to it
      expect((await resolveWith({ 'device_flow.poll_interval': 2 })).pollInterval).toBe(5);
      expect(
        (
          await resolveWith({
            'device_flow.poll_interval': 2,
            'device_flow.min_interval': 1,
          })
        ).pollInterval
      ).toBe(2);
    });

    it('clamps against the defaults of a pair that was the wrong way round', async () => {
      const policy = await resolveWith({
        'device_flow.expires_in': 1700,
        'device_flow.min_expires_in': 1500,
        'device_flow.max_expires_in': 400,
      });
      expect(policy.expiresIn).toBe(1700);
    });
  });

  describe('a client within the tenant guard-rails', () => {
    const tenant = {
      'device_flow.min_expires_in': 400,
      'device_flow.max_expires_in': 900,
      'device_flow.min_interval': 5,
      'device_flow.max_interval': 30,
    };

    it('uses its own lifetime and interval when they are inside the tenant bounds', async () => {
      const policy = await resolveWith(tenant, {
        'device_flow.expires_in': 450,
        'device_flow.poll_interval': 8,
      });
      expect(policy).toMatchObject({ expiresIn: 450, pollInterval: 8 });
    });

    it('is held to the tenant bounds when its lifetime and interval are outside them', async () => {
      expect((await resolveWith(tenant, { 'device_flow.expires_in': 1700 })).expiresIn).toBe(900);
      expect((await resolveWith(tenant, { 'device_flow.expires_in': 350 })).expiresIn).toBe(400);
      expect((await resolveWith(tenant, { 'device_flow.poll_interval': 55 })).pollInterval).toBe(
        30
      );
      expect(
        (
          await resolveWith(tenant, {
            'device_flow.poll_interval': 2,
            'device_flow.min_interval': 1,
          })
        ).pollInterval
      ).toBe(5);
    });

    it('cannot widen the tenant bounds with bounds of its own', async () => {
      const policy = await resolveWith(tenant, {
        'device_flow.min_expires_in': 60,
        'device_flow.max_expires_in': 3600,
        'device_flow.min_interval': 1,
        'device_flow.max_interval': 300,
        'device_flow.expires_in': 1700,
        'device_flow.poll_interval': 55,
      });
      expect(policy).toMatchObject({
        minExpiresIn: 400,
        maxExpiresIn: 900,
        minInterval: 5,
        maxInterval: 30,
        expiresIn: 900,
        pollInterval: 30,
      });
    });

    it('can narrow the tenant bounds', async () => {
      const policy = await resolveWith(tenant, {
        'device_flow.min_expires_in': 500,
        'device_flow.max_expires_in': 600,
        'device_flow.min_interval': 10,
        'device_flow.max_interval': 15,
        'device_flow.expires_in': 800,
        'device_flow.poll_interval': 5,
      });
      expect(policy).toMatchObject({
        minExpiresIn: 500,
        maxExpiresIn: 600,
        minInterval: 10,
        maxInterval: 15,
        expiresIn: 600,
        pollInterval: 10,
      });
    });

    it('keeps the tenant bounds when its own cannot be combined with them', async () => {
      const policy = await resolveWith(tenant, {
        // entirely above the tenant's longest lifetime and interval
        'device_flow.min_expires_in': 1000,
        'device_flow.max_expires_in': 1200,
        'device_flow.min_interval': 40,
        'device_flow.max_interval': 50,
      });
      expect(policy).toMatchObject({
        minExpiresIn: 400,
        maxExpiresIn: 900,
        minInterval: 5,
        maxInterval: 30,
      });
    });

    it('inherits the slow_down increment and the poll count from its own document', async () => {
      const policy = await resolveWith(
        { 'device_flow.slow_down_increment': 10, 'device_flow.max_poll_count': 200 },
        { 'device_flow.slow_down_increment': 15 }
      );
      expect(policy).toMatchObject({ slowDownIncrement: 15, maxPollCount: 200 });
    });

    it('does not let the tenant tighten what the client document inherits from nowhere else', async () => {
      // a tenant bound that is out of range is the default, for the client too
      const policy = await resolveWith({ 'device_flow.max_interval': 301 }, {});
      expect(policy.maxInterval).toBe(60);
    });
  });

  describe('limits held in code', () => {
    it('never goes past them whatever is stored', async () => {
      const stored = {
        'device_flow.max_expires_in': 99999,
        'device_flow.max_interval': 99999,
        'device_flow.expires_in': 99999,
        'device_flow.poll_interval': 99999,
        'device_flow.max_poll_count': 99999,
        'device_flow.slow_down_increment': 99999,
      };
      for (const policy of [await resolveWith(stored), await resolveWith({}, stored)]) {
        expect(policy.maxExpiresIn).toBeLessThanOrEqual(DEVICE_FLOW_HARD_LIMITS.maxExpiresIn);
        expect(policy.maxInterval).toBeLessThanOrEqual(DEVICE_FLOW_HARD_LIMITS.maxInterval);
        expect(policy.expiresIn).toBeLessThanOrEqual(DEVICE_FLOW_HARD_LIMITS.maxExpiresIn);
        expect(policy.pollInterval).toBeLessThanOrEqual(DEVICE_FLOW_HARD_LIMITS.maxInterval);
        expect(policy.maxPollCount).toBeLessThanOrEqual(DEVICE_FLOW_HARD_LIMITS.maxPollCount);
        expect(policy.slowDownIncrement).toBeLessThanOrEqual(
          DEVICE_FLOW_HARD_LIMITS.maxSlowDownIncrement
        );
      }
    });

    it('keeps the slow_down increment within 5..30 seconds whatever is stored', async () => {
      for (const value of [-1, 0, 1, 4, 31, 99999]) {
        const { slowDownIncrement } = await resolveWith({
          'device_flow.slow_down_increment': value,
        });
        expect(slowDownIncrement, String(value)).toBeGreaterThanOrEqual(
          DEVICE_FLOW_HARD_LIMITS.minSlowDownIncrement
        );
        expect(slowDownIncrement, String(value)).toBeLessThanOrEqual(
          DEVICE_FLOW_HARD_LIMITS.maxSlowDownIncrement
        );
      }
      expect(DEVICE_FLOW_HARD_LIMITS.minSlowDownIncrement).toBe(5);
    });

    it('never polls faster than once a second even for a stored 0', async () => {
      const policy = await resolveWith({
        'device_flow.min_interval': 0,
        'device_flow.poll_interval': 0,
      });
      expect(policy.minInterval).toBeGreaterThanOrEqual(DEVICE_FLOW_HARD_LIMITS.minInterval);
      expect(policy.pollInterval).toBeGreaterThanOrEqual(DEVICE_FLOW_HARD_LIMITS.minInterval);
    });
  });
});
