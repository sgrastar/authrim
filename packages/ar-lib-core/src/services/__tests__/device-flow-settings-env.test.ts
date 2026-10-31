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

describe('the user code format from the environment', () => {
  const kv = (documents: Record<string, Record<string, unknown>>) =>
    ({
      get: async (key: string) => (documents[key] ? JSON.stringify(documents[key]) : null),
    }) as unknown as KVNamespace;
  // A new KV object per call: the reader keeps the environment it first saw for each KV binding
  const format = async (env: Record<string, unknown>, stored?: Record<string, unknown>) => {
    const SETTINGS = stored ? kv({ [TENANT]: stored }) : undefined;
    const policy = await resolveDeviceFlowPolicy({ ...env, SETTINGS } as never, 't');
    return [policy.userCodeCharset, policy.userCodeLength];
  };
  const CHARSET = 'DEVICE_FLOW_USER_CODE_CHARSET';
  const LENGTH = 'DEVICE_FLOW_USER_CODE_LENGTH';
  const TENANT = 'settings:tenant:t:device-flow';

  it('takes a valid pair', async () => {
    expect(await format({ [CHARSET]: 'NUMERIC', [LENGTH]: '12' })).toEqual(['NUMERIC', 12]);
    expect(await format({ [CHARSET]: 'BASE20', [LENGTH]: '8' })).toEqual(['BASE20', 8]);
    expect(await format({ [LENGTH]: '11' })).toEqual(['BASE31', 11]);
    expect(await format({ [CHARSET]: 'BASE20' })).toEqual(['BASE20', 8]);
  });

  it('takes the default pair for a valid pair below the entropy floor', async () => {
    expect(await format({ [CHARSET]: 'NUMERIC', [LENGTH]: '8' })).toEqual(['BASE31', 8]);
    expect(await format({ [CHARSET]: 'NUMERIC' })).toEqual(['BASE31', 8]);
    expect(await format({ [LENGTH]: '6' })).toEqual(['BASE31', 8]);
  });

  describe('takes the default PAIR when either variable is set but not allowed', () => {
    it.each([
      // one invalid, one valid: both orders
      [{ [CHARSET]: 'HEX', [LENGTH]: '7' }],
      [{ [CHARSET]: 'NUMERIC', [LENGTH]: 'abc' }],
      [{ [CHARSET]: 'BASE20', [LENGTH]: '17' }],
      [{ [CHARSET]: 'BASE20', [LENGTH]: '12.5' }],
      [{ [CHARSET]: 'BASE20', [LENGTH]: '12junk' }],
      [{ [CHARSET]: 'BASE20', [LENGTH]: '3' }],
      [{ [CHARSET]: 'base20', [LENGTH]: '12' }],
      // one alone
      [{ [CHARSET]: 'HEX' }],
      [{ [LENGTH]: '99' }],
      [{ [LENGTH]: 'abc' }],
      // both invalid
      [{ [CHARSET]: 'HEX', [LENGTH]: '99' }],
    ])('%j', async (env) => {
      expect(await format(env)).toEqual(['BASE31', 8]);
    });

    it('also when the invalid variable is the length and the charset is allowed with the default length', async () => {
      // BASE20 x 8 would be allowed; the pair is still not half applied
      expect(await format({ [CHARSET]: 'BASE20', [LENGTH]: '17' })).toEqual(['BASE31', 8]);
    });

    it('treats an empty variable as not set', async () => {
      expect(await format({ [CHARSET]: '', [LENGTH]: '' })).toEqual(['BASE31', 8]);
      expect(await format({ [CHARSET]: 'NUMERIC', [LENGTH]: '12', X: '' })).toEqual([
        'NUMERIC',
        12,
      ]);
    });
  });

  describe('with a tenant document', () => {
    const pair = { 'device_flow.user_code_charset': 'BASE20', 'device_flow.user_code_length': 9 };

    it('a stored valid pair beats the environment, valid or not', async () => {
      expect(await format({ [CHARSET]: 'NUMERIC', [LENGTH]: '12' }, pair)).toEqual(['BASE20', 9]);
      expect(await format({ [CHARSET]: 'HEX', [LENGTH]: 'abc' }, pair)).toEqual(['BASE20', 9]);
    });

    it('a stored pair below the floor is the default pair, whatever the environment says', async () => {
      const below = {
        'device_flow.user_code_charset': 'NUMERIC',
        'device_flow.user_code_length': 10,
      };
      expect(await format({ [CHARSET]: 'NUMERIC', [LENGTH]: '12' }, below)).toEqual(['BASE31', 8]);
    });

    it.each([
      [{ 'device_flow.user_code_charset': 'HEX', 'device_flow.user_code_length': 12 }],
      [{ 'device_flow.user_code_charset': 'BASE20', 'device_flow.user_code_length': 17 }],
      [{ 'device_flow.user_code_charset': 'BASE20', 'device_flow.user_code_length': 8.5 }],
    ])('a stored invalid value makes the default pair: %j', async (stored) => {
      expect(await format({}, stored)).toEqual(['BASE31', 8]);
    });

    it('a stored charset next to an environment length takes both when they are allowed', async () => {
      const stored = { 'device_flow.user_code_charset': 'NUMERIC' };
      expect(await format({ [LENGTH]: '12' }, stored)).toEqual(['NUMERIC', 12]);
      // below the floor with the environment length
      expect(await format({ [LENGTH]: '10' }, stored)).toEqual(['BASE31', 8]);
    });

    it('a stored value next to an environment value that is not allowed makes the default pair', async () => {
      const charsetOnly = { 'device_flow.user_code_charset': 'BASE20' };
      expect(await format({ [LENGTH]: 'abc' }, charsetOnly)).toEqual(['BASE31', 8]);
      const lengthOnly = { 'device_flow.user_code_length': 11 };
      expect(await format({ [CHARSET]: 'HEX' }, lengthOnly)).toEqual(['BASE31', 8]);
      // the key the document sets is not affected by its own bad variable
      expect(await format({ [LENGTH]: 'abc' }, lengthOnly)).toEqual(['BASE31', 11]);
    });
  });

  it('a client document and its environment are not read for the format', async () => {
    const SETTINGS = kv({
      'settings:client:t:c:device-flow': {
        'device_flow.user_code_charset': 'NUMERIC',
        'device_flow.user_code_length': 16,
      },
    });
    const policy = await resolveDeviceFlowPolicy({ SETTINGS } as never, 't', 'c');
    expect([policy.userCodeCharset, policy.userCodeLength]).toEqual(['BASE31', 8]);
  });
});
