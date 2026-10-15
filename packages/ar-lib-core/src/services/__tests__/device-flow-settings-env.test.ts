import { describe, expect, it } from 'vitest';
import { resolveDeviceFlowPolicy } from '../device-flow-settings';

/** These go through the real settings reader, so environment variables are parsed as deployed. */
describe('device flow settings from the environment', () => {
  it.each([
    ['DEVICE_FLOW_DEFAULT_EXPIRES_IN', 'expiresIn', '900', 900, 600],
    ['DEVICE_FLOW_MIN_EXPIRES_IN', 'minExpiresIn', '400', 400, 300],
    ['DEVICE_FLOW_MAX_EXPIRES_IN', 'maxExpiresIn', '1500', 1500, 1800],
    ['DEVICE_FLOW_DEFAULT_INTERVAL', 'pollInterval', '10', 10, 5],
    ['DEVICE_FLOW_MIN_INTERVAL', 'minInterval', '3', 3, 5],
    ['DEVICE_FLOW_MAX_INTERVAL', 'maxInterval', '120', 120, 60],
    ['DEVICE_FLOW_SLOW_DOWN_INCREMENT', 'slowDownIncrement', '10', 10, 5],
    ['DEVICE_FLOW_MAX_POLL_COUNT', 'maxPollCount', '200', 200, 120],
  ] as const)('%s is read whole and in range', async (name, field, good, expected, fallback) => {
    await expect(resolveDeviceFlowPolicy({ [name]: good } as never, 't')).resolves.toMatchObject({
      [field]: expected,
    });
    for (const bad of ['4000.9', '60junk', '1e2', '-5', 'abc', '0', '99999']) {
      const policy = await resolveDeviceFlowPolicy({ [name]: bad } as never, 't');
      expect(policy[field], `${name}=${bad}`).toBe(fallback);
    }
  });

  it('DEVICE_FLOW_SLOW_DOWN_INCREMENT below the 5 seconds RFC 8628 requires keeps the default', async () => {
    for (const low of ['1', '4']) {
      await expect(
        resolveDeviceFlowPolicy({ DEVICE_FLOW_SLOW_DOWN_INCREMENT: low } as never, 't')
      ).resolves.toMatchObject({ slowDownIncrement: 5 });
    }
  });

  const kv = (documents: Record<string, Record<string, unknown>>) =>
    ({
      get: async (key: string) => (documents[key] ? JSON.stringify(documents[key]) : null),
    }) as unknown as KVNamespace;

  it('a stored tenant value beats the environment', async () => {
    const SETTINGS = kv({ 'settings:tenant:t:device-flow': { 'device_flow.expires_in': 700 } });
    await expect(
      resolveDeviceFlowPolicy({ SETTINGS, DEVICE_FLOW_DEFAULT_EXPIRES_IN: '900' } as never, 't')
    ).resolves.toMatchObject({ expiresIn: 700 });
  });

  it('a stored client value beats the tenant value, held to the tenant bounds', async () => {
    const SETTINGS = kv({
      'settings:tenant:t:device-flow': {
        'device_flow.expires_in': 700,
        'device_flow.max_expires_in': 800,
      },
      'settings:client:t:c:device-flow': { 'device_flow.expires_in': 1500 },
    });
    await expect(resolveDeviceFlowPolicy({ SETTINGS } as never, 't', 'c')).resolves.toMatchObject({
      expiresIn: 800,
    });
    await expect(resolveDeviceFlowPolicy({ SETTINGS } as never, 't')).resolves.toMatchObject({
      expiresIn: 700,
    });
  });

  it('a stored client value beats the tenant value', async () => {
    const SETTINGS = kv({
      'settings:tenant:t:device-flow': { 'device_flow.poll_interval': 10 },
      'settings:client:t:c:device-flow': { 'device_flow.poll_interval': 20 },
    });
    await expect(resolveDeviceFlowPolicy({ SETTINGS } as never, 't', 'c')).resolves.toMatchObject({
      pollInterval: 20,
    });
    await expect(
      resolveDeviceFlowPolicy({ SETTINGS } as never, 't', 'other')
    ).resolves.toMatchObject({
      pollInterval: 10,
    });
  });
});
