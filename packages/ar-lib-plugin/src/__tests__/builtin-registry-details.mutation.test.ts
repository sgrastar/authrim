import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBuiltinPlugins,
  needsBuiltinRegistration,
  registerBuiltinPlugins,
  resolveBuiltinPluginBootstrapConfig,
  type PluginRegistryEntry,
} from '../core/builtin-registry';

function memoryKV(initial?: string, failOn?: (key: string) => boolean) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set('plugins:registry', initial);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      if (failOn?.(key)) throw new Error(`put failed for ${key}`);
      values.set(key, value);
    }),
  } as unknown as KVNamespace & { values: Map<string, string>; put: ReturnType<typeof vi.fn> };
}

function savedRegistry(kv: { values: Map<string, string> }) {
  return JSON.parse(kv.values.get('plugins:registry') ?? '{}') as Record<
    string,
    PluginRegistryEntry
  >;
}

afterEach(() => vi.useRealTimers());

describe('builtin registration entries', () => {
  it('lists the notifier plugins before the security plugins', () => {
    expect(getBuiltinPlugins().map((plugin) => plugin.id)).toEqual([
      'notifier-console',
      'notifier-cloudflare',
      'notifier-resend',
      'human-verification-cloudflare-turnstile',
      'human-verification-hcaptcha',
      'human-verification-google-recaptcha',
    ]);
  });

  it('records each plugin with its source, trust level, registration time and display metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T08:09:10.000Z'));
    const kv = memoryKV();
    await registerBuiltinPlugins(kv);
    const turnstile = savedRegistry(kv)['human-verification-cloudflare-turnstile'];
    expect(turnstile).toEqual({
      id: 'human-verification-cloudflare-turnstile',
      version: '1.0.0',
      capabilities: ['human_verification.turnstile'],
      official: true,
      meta: {
        name: 'Cloudflare Turnstile',
        description:
          'Human verification for Login UI flows using Cloudflare Turnstile and server-side Siteverify.',
        icon: 'shield-check',
        category: 'security',
        documentationUrl: 'https://developers.cloudflare.com/turnstile/',
        author: { name: 'Authrim', url: 'https://authrim.com' },
        license: 'MIT',
        tags: ['cloudflare', 'turnstile', 'captcha', 'bot-protection', 'login-ui'],
        stability: 'beta',
      },
      source: {
        type: 'builtin',
        identifier: 'ar-lib-plugin/builtin/security/human-verification-cloudflare-turnstile',
      },
      trustLevel: 'official',
      registeredAt: Date.parse('2026-06-07T08:09:10.000Z'),
    });
  });

  it('stores one JSON schema per plugin under its own key', async () => {
    const kv = memoryKV();
    await registerBuiltinPlugins(kv);
    for (const plugin of getBuiltinPlugins()) {
      const stored = kv.values.get(`plugins:schema:${plugin.id}`);
      expect(stored, plugin.id).toBeDefined();
      expect((JSON.parse(stored ?? '{}') as { type?: string }).type).toBe('object');
    }
  });

  it('reports its progress through the log function', async () => {
    const log = vi.fn();
    await registerBuiltinPlugins(memoryKV(), { log, force: true });
    expect(log).toHaveBeenCalledWith('Registering 6 builtin plugins', { force: true });
    expect(log).toHaveBeenCalledWith('Registered plugin: notifier-console v1.0.0');
    expect(log).toHaveBeenCalledWith('Saved registry with 6 plugins');
  });

  it('writes the registry only when something was registered, or when forced', async () => {
    const kv = memoryKV();
    await registerBuiltinPlugins(kv);
    kv.put.mockClear();
    await registerBuiltinPlugins(kv);
    expect(kv.put).not.toHaveBeenCalled();
    await registerBuiltinPlugins(kv, { force: true });
    expect(kv.put).toHaveBeenCalledWith('plugins:registry', expect.any(String));
  });
});

describe('builtin registration upgrades and failures', () => {
  it('updates a plugin whose registered version differs, and keeps the others', async () => {
    const kv = memoryKV();
    await registerBuiltinPlugins(kv);
    const registry = savedRegistry(kv);
    const stale = { ...registry['notifier-console'], version: '0.9.0' } as PluginRegistryEntry;
    kv.values.set('plugins:registry', JSON.stringify({ ...registry, 'notifier-console': stale }));

    const log = vi.fn();
    const result = await registerBuiltinPlugins(kv, { log });
    expect(result).toEqual({ registered: 1, skipped: 5, errors: [] });
    expect(log).toHaveBeenCalledWith('Updating plugin notifier-console: 0.9.0 -> 1.0.0');
    expect(savedRegistry(kv)['notifier-console']?.version).toBe('1.0.0');
  });

  it.each([['[]'], ['null'], ['5'], ['"text"']])(
    'starts fresh from a stored registry that is not an object (%s)',
    async (stored) => {
      const kv = memoryKV(stored);
      await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);
      const result = await registerBuiltinPlugins(kv);
      expect(result.registered).toBe(6);
      expect(Object.keys(savedRegistry(kv))).toHaveLength(6);
    }
  );

  it('logs a corrupted registry and starts fresh', async () => {
    const log = vi.fn();
    await registerBuiltinPlugins(memoryKV('{oops'), { log });
    expect(log).toHaveBeenCalledWith('Failed to parse existing registry, starting fresh');
  });

  it('still registers a plugin whose schema cannot be stored, and logs why', async () => {
    const kv = memoryKV(undefined, (key) => key === 'plugins:schema:notifier-console');
    const log = vi.fn();
    const result = await registerBuiltinPlugins(kv, { log });
    expect(result).toEqual({ registered: 6, skipped: 0, errors: [] });
    expect(log).toHaveBeenCalledWith('Failed to store schema for notifier-console', {
      error: 'put failed for plugins:schema:notifier-console',
    });
  });

  it('reports the registry write failure to the caller', async () => {
    const kv = memoryKV(undefined, (key) => key === 'plugins:registry');
    await expect(registerBuiltinPlugins(kv)).rejects.toThrow('put failed for plugins:registry');
  });
});

describe('needsBuiltinRegistration', () => {
  it('is true for an empty store, a missing plugin and a different version, false when current', async () => {
    const kv = memoryKV();
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);
    await registerBuiltinPlugins(kv);
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(false);

    const registry = savedRegistry(kv);
    const { 'notifier-resend': _removed, ...withoutResend } = registry;
    kv.values.set('plugins:registry', JSON.stringify(withoutResend));
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);

    kv.values.set(
      'plugins:registry',
      JSON.stringify({
        ...registry,
        'notifier-resend': { ...registry['notifier-resend'], version: '0.1.0' },
      })
    );
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);
  });

  it('is true when the store cannot be read', async () => {
    const kv = { get: vi.fn().mockRejectedValue(new Error('kv down')) } as unknown as KVNamespace;
    await expect(needsBuiltinRegistration(kv)).resolves.toBe(true);
  });
});

describe('resolveBuiltinPluginBootstrapConfig', () => {
  it('only passes the values that are set', () => {
    expect(resolveBuiltinPluginBootstrapConfig({}, 'notifier-cloudflare')).toEqual({});
    expect(
      resolveBuiltinPluginBootstrapConfig(
        { EMAIL_FROM: '', EMAIL_FROM_NAME: '' },
        'notifier-cloudflare'
      )
    ).toEqual({});
    expect(
      resolveBuiltinPluginBootstrapConfig({ EMAIL_FROM: 'a@example.com' }, 'notifier-cloudflare')
    ).toEqual({ defaultFrom: 'a@example.com' });
    expect(
      resolveBuiltinPluginBootstrapConfig({ EMAIL_FROM_NAME: 'Acme' }, 'notifier-cloudflare')
    ).toEqual({ fromName: 'Acme' });
  });

  it('gives Resend nothing without its API key, and only the sender with it', () => {
    expect(
      resolveBuiltinPluginBootstrapConfig(
        { EMAIL_FROM: 'a@example.com', EMAIL_FROM_NAME: 'Acme' },
        'notifier-resend'
      )
    ).toEqual({});
    expect(
      resolveBuiltinPluginBootstrapConfig({ RESEND_API_KEY: 're_k' }, 'notifier-resend')
    ).toEqual({
      apiKey: 're_k',
    });
    expect(
      resolveBuiltinPluginBootstrapConfig(
        { RESEND_API_KEY: 're_k', EMAIL_FROM: 'a@example.com', EMAIL_FROM_NAME: 'Acme' },
        'notifier-resend'
      )
    ).toEqual({ apiKey: 're_k', defaultFrom: 'a@example.com' });
  });

  it('never leaks the secrets to other plugins', () => {
    const env = { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@example.com', EMAIL_FROM_NAME: 'n' };
    expect(resolveBuiltinPluginBootstrapConfig(env, 'notifier-console')).toEqual({});
    expect(resolveBuiltinPluginBootstrapConfig(env, 'unknown')).toEqual({});
  });
});
