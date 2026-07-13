import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  clearCache: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getNativeSSOConfig: mocks.getConfig,
    clearNativeSSOConfigCache: mocks.clearCache,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

import {
  clearNativeSSOConfig,
  getNativeSSOSettingsConfig,
  updateNativeSSOConfig,
} from '../routes/settings/native-sso';

const defaults = {
  enabled: false,
  deviceSecretTTLDays: 30,
  maxDeviceSecretsPerUser: 10,
  maxUseCountPerSecret: 10,
  maxSecretsBehavior: 'revoke_oldest',
  deviceSecretRotationPolicy: 'disabled',
  deviceSecretRotationOverlapSeconds: 0,
  allowCrossClientNativeSSO: false,
  rateLimit: { maxAttemptsPerMinute: 10, blockDurationMinutes: 15 },
};

function kv(initial: string | null = null) {
  let stored = initial;
  return {
    get: vi.fn(async () => stored),
    put: vi.fn(async (_key: string, value: string) => {
      stored = value;
    }),
    delete: vi.fn(async () => {
      stored = null;
    }),
  };
}

function context(
  options: {
    body?: unknown;
    jsonError?: unknown;
    config?: ReturnType<typeof kv>;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    req: {
      json: options.jsonError
        ? vi.fn().mockRejectedValue(options.jsonError)
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      ...(options.config ? { AUTHRIM_CONFIG: options.config } : {}),
      ...options.env,
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('Native SSO settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue(defaults);
  });

  describe('read sources', () => {
    it('reports default values and documented security bounds', async () => {
      const response = await getNativeSSOSettingsConfig(context({ config: kv() }));
      const body = (await response.json()) as { settings: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(body.settings).toMatchObject({
        enabled: { value: false, source: 'default', default: false },
        deviceSecretTTLDays: { value: 30, source: 'default', min: 1, max: 90 },
        maxDeviceSecretsPerUser: { value: 10, source: 'default', min: 1, max: 50 },
        maxUseCountPerSecret: { value: 10, source: 'default', min: 1, max: 100 },
        maxSecretsBehavior: { value: 'revoke_oldest', source: 'default' },
        allowCrossClientNativeSSO: { value: false, source: 'default' },
      });
    });

    it('marks every explicitly persisted field as KV-sourced', async () => {
      const persisted = {
        enabled: true,
        deviceSecretTTLDays: 45,
        maxDeviceSecretsPerUser: 20,
        maxUseCountPerSecret: 5,
        maxSecretsBehavior: 'reject',
        allowCrossClientNativeSSO: true,
        rateLimit: { maxAttemptsPerMinute: 20, blockDurationMinutes: 30 },
      };
      mocks.getConfig.mockResolvedValue({ ...defaults, ...persisted });

      const response = await getNativeSSOSettingsConfig(
        context({ config: kv(JSON.stringify(persisted)) })
      );
      const body = (await response.json()) as {
        settings: Record<string, { source?: string; maxAttemptsPerMinute?: { source: string } }>;
      };

      for (const key of [
        'enabled',
        'deviceSecretTTLDays',
        'maxDeviceSecretsPerUser',
        'maxUseCountPerSecret',
        'maxSecretsBehavior',
        'allowCrossClientNativeSSO',
      ]) {
        expect(body.settings[key]?.source).toBe('kv');
      }
      expect(body.settings.rateLimit?.maxAttemptsPerMinute?.source).toBe('kv');
    });

    it('marks each configured environment fallback as env-sourced', async () => {
      const response = await getNativeSSOSettingsConfig(
        context({
          config: kv(),
          env: {
            NATIVE_SSO_ENABLED: 'true',
            NATIVE_SSO_DEVICE_SECRET_TTL_DAYS: '20',
            NATIVE_SSO_MAX_SECRETS_PER_USER: '5',
            NATIVE_SSO_MAX_USE_COUNT_PER_SECRET: '4',
            NATIVE_SSO_MAX_SECRETS_BEHAVIOR: 'reject',
            NATIVE_SSO_ALLOW_CROSS_CLIENT: 'true',
            NATIVE_SSO_RATE_LIMIT_MAX_ATTEMPTS: '8',
            NATIVE_SSO_RATE_LIMIT_BLOCK_MINUTES: '10',
          },
        })
      );
      const body = (await response.json()) as { settings: Record<string, unknown> };
      expect(JSON.stringify(body.settings).match(/"source":"env"/g)).toHaveLength(8);
    });

    it.each([
      ['KV read failure', Object.assign(kv(), { get: vi.fn().mockRejectedValue(new Error('KV')) })],
      ['malformed KV JSON', kv('{')],
    ])('falls back safely after %s', async (_name, config) => {
      const response = await getNativeSSOSettingsConfig(context({ config }));
      expect(response.status).toBe(200);
    });

    it('returns server_error when effective configuration loading fails', async () => {
      mocks.getConfig.mockRejectedValueOnce(new Error('configuration failure'));
      const response = await getNativeSSOSettingsConfig(context({ config: kv() }));
      expect(response.status).toBe(500);
    });
  });

  describe('update validation', () => {
    it('requires the KV binding before parsing input', async () => {
      const response = await updateNativeSSOConfig(context({ body: { enabled: true } }));
      expect(response.status).toBe(500);
    });

    it('rejects malformed JSON', async () => {
      const response = await updateNativeSSOConfig(
        context({ config: kv(), jsonError: new SyntaxError('bad json') })
      );
      expect(response.status).toBe(400);
    });

    it.each([
      [{ enabled: 'true' }, '"enabled" must be a boolean'],
      [{ deviceSecretTTLDays: '30' }, 'must be an integer'],
      [{ deviceSecretTTLDays: 1.5 }, 'must be an integer'],
      [{ deviceSecretTTLDays: 0 }, 'must be between 1 and 90'],
      [{ deviceSecretTTLDays: 91 }, 'must be between 1 and 90'],
      [{ maxDeviceSecretsPerUser: '10' }, 'must be an integer'],
      [{ maxDeviceSecretsPerUser: 1.5 }, 'must be an integer'],
      [{ maxDeviceSecretsPerUser: 0 }, 'must be between 1 and 50'],
      [{ maxDeviceSecretsPerUser: 51 }, 'must be between 1 and 50'],
      [{ maxUseCountPerSecret: '10' }, 'must be an integer'],
      [{ maxUseCountPerSecret: 1.5 }, 'must be an integer'],
      [{ maxUseCountPerSecret: 0 }, 'must be between 1 and 100'],
      [{ maxUseCountPerSecret: 101 }, 'must be between 1 and 100'],
      [{ maxSecretsBehavior: 'discard' }, 'must be one of'],
      [{ allowCrossClientNativeSSO: 'true' }, 'must be a boolean'],
      [{ rateLimit: null }, '"rateLimit" must be an object'],
      [{ rateLimit: 'bad' }, '"rateLimit" must be an object'],
      [{ rateLimit: { maxAttemptsPerMinute: '10' } }, 'must be an integer'],
      [{ rateLimit: { maxAttemptsPerMinute: 1.5 } }, 'must be an integer'],
      [{ rateLimit: { maxAttemptsPerMinute: 0 } }, 'must be between 1 and 100'],
      [{ rateLimit: { maxAttemptsPerMinute: 101 } }, 'must be between 1 and 100'],
      [{ rateLimit: { blockDurationMinutes: '10' } }, 'must be an integer'],
      [{ rateLimit: { blockDurationMinutes: 1.5 } }, 'must be an integer'],
      [{ rateLimit: { blockDurationMinutes: 0 } }, 'must be between 1 and 60'],
      [{ rateLimit: { blockDurationMinutes: 61 } }, 'must be between 1 and 60'],
    ])('rejects invalid setting boundary %#', async (body, description) => {
      const response = await updateNativeSSOConfig(context({ body, config: kv() }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_value',
        error_description: expect.stringContaining(description),
      });
    });
  });

  describe('durable update and clear', () => {
    it('merges all supported fields with existing settings and clears the runtime cache', async () => {
      const config = kv(JSON.stringify({ enabled: false, rateLimit: { maxAttemptsPerMinute: 5 } }));
      const body = {
        enabled: true,
        deviceSecretTTLDays: 45,
        maxDeviceSecretsPerUser: 20,
        maxUseCountPerSecret: 8,
        maxSecretsBehavior: 'reject',
        allowCrossClientNativeSSO: true,
        rateLimit: { blockDurationMinutes: 20 },
      };
      mocks.getConfig.mockResolvedValue({ ...defaults, ...body });

      const response = await updateNativeSSOConfig(context({ body, config }));
      const stored = JSON.parse(config.put.mock.calls[0]?.[1] as string) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(stored).toMatchObject({
        ...body,
        rateLimit: { maxAttemptsPerMinute: 5, blockDurationMinutes: 20 },
      });
      expect(mocks.clearCache).toHaveBeenCalledOnce();
    });

    it('allows an empty patch without deleting existing overrides', async () => {
      const config = kv(JSON.stringify({ enabled: true }));
      const response = await updateNativeSSOConfig(context({ body: {}, config }));
      expect(response.status).toBe(200);
      expect(config.put).toHaveBeenCalledWith(
        'config:native-sso',
        JSON.stringify({ enabled: true })
      );
    });

    it.each([
      [
        'KV read failure',
        Object.assign(kv(), { get: vi.fn().mockRejectedValue(new Error('get')) }),
      ],
      ['malformed existing JSON', kv('{')],
      [
        'KV write failure',
        Object.assign(kv(), { put: vi.fn().mockRejectedValue(new Error('put')) }),
      ],
    ])('returns server_error on %s without claiming success', async (_name, config) => {
      const response = await updateNativeSSOConfig(context({ body: { enabled: true }, config }));
      expect(response.status).toBe(500);
    });

    it('requires the KV binding when clearing overrides', async () => {
      expect((await clearNativeSSOConfig(context())).status).toBe(500);
    });

    it('deletes the override, clears cache, and reports fallback sources', async () => {
      const config = kv(JSON.stringify({ enabled: true }));
      const response = await clearNativeSSOConfig(context({ config }));
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ success: true, settings: defaults });
      expect(config.delete).toHaveBeenCalledWith('config:native-sso');
      expect(mocks.clearCache).toHaveBeenCalledOnce();
    });

    it('returns server_error when clearing KV fails', async () => {
      const config = Object.assign(kv(), {
        delete: vi.fn().mockRejectedValue(new Error('delete failed')),
      });
      expect((await clearNativeSSOConfig(context({ config }))).status).toBe(500);
    });
  });
});
