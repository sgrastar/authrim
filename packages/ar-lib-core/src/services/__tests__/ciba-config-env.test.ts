import { describe, expect, it } from 'vitest';
import { resolveCibaConfig } from '../ciba-config';

/** These go through the real settings reader, so environment variables are parsed as deployed. */
describe('CIBA settings from the environment', () => {
  it.each([
    ['CIBA_DEFAULT_EXPIRES_IN', 'expiresIn', '400', 400, 300],
    ['CIBA_MIN_EXPIRES_IN', 'minExpiresIn', '90', 90, 60],
    ['CIBA_MAX_EXPIRES_IN', 'maxExpiresIn', '900', 900, 600],
    ['CIBA_DEFAULT_INTERVAL', 'pollInterval', '10', 10, 5],
    ['CIBA_MIN_INTERVAL', 'minInterval', '3', 3, 2],
    ['CIBA_MAX_INTERVAL', 'maxInterval', '120', 120, 60],
    ['CIBA_MAX_BINDING_MESSAGE_LENGTH', 'maxBindingMessageLength', '200', 200, 140],
  ] as const)('%s is read whole and in range', async (name, field, good, expected, fallback) => {
    await expect(resolveCibaConfig({ [name]: good } as never, 't')).resolves.toMatchObject({
      [field]: expected,
    });
    for (const bad of ['4000.9', '60junk', '1e2', '-5', 'abc', '0', '99999']) {
      const config = await resolveCibaConfig({ [name]: bad } as never, 't');
      expect(config[field], `${name}=${bad}`).toBe(fallback);
    }
  });

  it('CIBA_BINDING_MESSAGE_REQUIRED turns the requirement on only when it says true', async () => {
    await expect(
      resolveCibaConfig({ CIBA_BINDING_MESSAGE_REQUIRED: 'true' } as never, 't')
    ).resolves.toMatchObject({ bindingMessageRequired: true });
    for (const other of ['false', 'no', '', 'maybe']) {
      await expect(
        resolveCibaConfig({ CIBA_BINDING_MESSAGE_REQUIRED: other } as never, 't')
      ).resolves.toMatchObject({ bindingMessageRequired: false });
    }
  });

  it('a stored tenant value beats the environment', async () => {
    const kv = {
      get: async (key: string) =>
        key === 'settings:tenant:t:ciba' ? JSON.stringify({ 'ciba.expires_in': 200 }) : null,
    } as unknown as KVNamespace;
    await expect(
      resolveCibaConfig({ SETTINGS: kv, CIBA_DEFAULT_EXPIRES_IN: '400' } as never, 't')
    ).resolves.toMatchObject({ expiresIn: 200 });
  });
});
