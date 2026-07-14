import { describe, expect, it, vi } from 'vitest';
import {
  getBuiltinPlugins,
  needsBuiltinRegistration,
  registerBuiltinPlugins,
  resolveBuiltinPluginBootstrapConfig,
} from '../core/builtin-registry';

function memoryKV(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('plugins:registry', initial);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => values.set(key, value)),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

describe('builtin plugin registry', () => {
  it('registers every builtin with builtin trust metadata and schemas', async () => {
    const kv = memoryKV();
    const plugins = getBuiltinPlugins();

    await expect(registerBuiltinPlugins(kv)).resolves.toEqual({
      registered: plugins.length,
      skipped: 0,
      errors: [],
    });
    const registry = JSON.parse(kv.values.get('plugins:registry') ?? '{}') as Record<
      string,
      { source: { type: string }; trustLevel: string }
    >;
    expect(Object.keys(registry)).toHaveLength(plugins.length);
    expect(Object.values(registry).every((entry) => entry.source.type === 'builtin')).toBe(true);
    expect(Object.values(registry).every((entry) => entry.trustLevel === 'official')).toBe(true);
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(false);
  });

  it('does not overwrite current registry entries unless forced', async () => {
    const kv = memoryKV();
    await registerBuiltinPlugins(kv);
    const putsAfterFirstRegistration = vi.mocked(kv.put).mock.calls.length;

    const skipped = await registerBuiltinPlugins(kv);
    expect(skipped).toMatchObject({ registered: 0, skipped: getBuiltinPlugins().length });
    expect(vi.mocked(kv.put).mock.calls.length).toBe(putsAfterFirstRegistration);

    const forced = await registerBuiltinPlugins(kv, { force: true });
    expect(forced.registered).toBe(getBuiltinPlugins().length);
  });

  it('recovers from corrupted registry JSON instead of trusting it', async () => {
    const kv = memoryKV('{not-json');
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);
    await expect(registerBuiltinPlugins(kv)).resolves.toMatchObject({
      registered: getBuiltinPlugins().length,
      errors: [],
    });
    expect(() => JSON.parse(kv.values.get('plugins:registry') ?? '')).not.toThrow();
  });

  it('only exposes deployment secrets to the plugin that owns them', () => {
    const env = {
      EMAIL_FROM: 'login@example.com',
      EMAIL_FROM_NAME: 'Authrim',
      RESEND_API_KEY: 'secret-resend-key',
    };

    expect(resolveBuiltinPluginBootstrapConfig(env, 'notifier-cloudflare')).toEqual({
      defaultFrom: 'login@example.com',
      fromName: 'Authrim',
    });
    expect(resolveBuiltinPluginBootstrapConfig(env, 'notifier-resend')).toEqual({
      apiKey: 'secret-resend-key',
      defaultFrom: 'login@example.com',
    });
    expect(resolveBuiltinPluginBootstrapConfig(env, 'security-turnstile')).toEqual({});
  });
});
