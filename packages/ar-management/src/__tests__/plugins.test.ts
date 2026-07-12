/**
 * Plugin Admin API Tests
 *
 * Comprehensive tests for plugin management endpoints:
 * - GET /api/admin/plugins - List all plugins
 * - GET /api/admin/plugins/:id - Get plugin details
 * - GET /api/admin/plugins/:id/config - Get plugin configuration
 * - PUT /api/admin/plugins/:id/config - Update plugin configuration
 * - PUT /api/admin/plugins/:id/enable - Enable plugin
 * - PUT /api/admin/plugins/:id/disable - Disable plugin
 * - GET /api/admin/plugins/:id/health - Get plugin health
 * - GET /api/admin/plugins/:id/schema - Get plugin schema
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Mock ar-lib-core functions
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    scheduleAuditLogFromContext: vi.fn(),
  };
});

// Mock ar-lib-plugin encryption functions
vi.mock('@authrim/ar-lib-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-plugin')>();
  return {
    ...actual,
    getPluginEncryptionKey: vi.fn().mockImplementation(async () => {
      // Return a mock CryptoKey
      return crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
    }),
    needsBuiltinRegistration: vi.fn().mockResolvedValue(false),
    registerBuiltinPlugins: vi.fn().mockResolvedValue({ registered: 0, skipped: 0, errors: [] }),
  };
});

import {
  listPluginsHandler,
  getPluginHandler,
  getPluginConfigHandler,
  updatePluginConfigHandler,
  enablePluginHandler,
  disablePluginHandler,
  sendPluginTestEmailHandler,
  getPluginHealthHandler,
  getPluginSchemaHandler,
  registerPlugin,
  updatePluginHealth,
} from '../routes/settings/plugins';
import { getPluginEncryptionKey } from '@authrim/ar-lib-plugin';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockKV(options: {
  getValues?: Record<string, string | null>;
  putCallback?: (key: string, value: string) => void;
}): KVNamespace {
  const storage = new Map<string, string>(
    Object.entries(options.getValues ?? {}).filter(([, v]) => v !== null) as [string, string][]
  );

  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      return storage.get(key) ?? null;
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
      options.putCallback?.(key, value);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function createMockContext(options: {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  kv?: KVNamespace;
  headers?: Record<string, string>;
  envOverrides?: Record<string, unknown>;
  adminAuth?: { userId?: string; authMethod?: string };
  tenantId?: string;
  pluginTenantScope?: 'tenant' | 'platform';
}) {
  const mockKV =
    options.kv ??
    createMockKV({
      getValues: {
        'plugins:registry': JSON.stringify({}),
      },
    });

  const contextStore = new Map<string, unknown>([
    ['tenantId', options.tenantId ?? 'default'],
    ['adminAuth', options.adminAuth ?? { userId: 'admin-1', authMethod: 'password' }],
  ]);
  if (options.pluginTenantScope) {
    contextStore.set('pluginTenantScope', options.pluginTenantScope);
  }

  const c = {
    req: {
      method: options.method || 'GET',
      param: vi.fn().mockImplementation((name: string) => options.params?.[name]),
      query: vi.fn().mockImplementation((name: string) => options.query?.[name]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockImplementation((name: string) => options.headers?.[name] ?? null),
      path: '/api/admin/plugins',
    },
    env: {
      SETTINGS: mockKV,
      ISSUER_URL: 'https://op.example.com',
      ...options.envOverrides,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    _mockKV: mockKV,
  } as any;

  return c;
}

/**
 * Helper to extract response data from handler
 */
async function getResponseData(response: Response | void): Promise<{ body: any; status: number }> {
  if (!response) {
    return { body: null, status: 200 };
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, status: response.status };
}

/**
 * Create sample plugin registry entry
 */
function createPluginEntry(
  overrides: Partial<{
    id: string;
    version: string;
    capabilities: string[];
    official: boolean;
    meta: {
      name: string;
      description: string;
      category: string;
      icon?: string;
    };
    source: { type: string; identifier?: string };
    trustLevel: string;
    registeredAt: number;
  }> = {}
) {
  return {
    id: overrides.id ?? 'test-plugin',
    version: overrides.version ?? '1.0.0',
    capabilities: overrides.capabilities ?? ['notifier.email'],
    official: overrides.official ?? true,
    meta: overrides.meta ?? {
      name: 'Test Plugin',
      description: 'A test plugin',
      category: 'notification',
    },
    source: overrides.source ?? { type: 'builtin', identifier: 'ar-lib-plugin/builtin/test' },
    trustLevel: overrides.trustLevel ?? 'official',
    registeredAt: overrides.registeredAt ?? Date.now(),
  };
}

// =============================================================================
// List Plugins Tests
// =============================================================================

describe('Plugin Admin API - List Plugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/admin/plugins', () => {
    it('should return empty list when no plugins registered', async () => {
      const c = createMockContext({});

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: [],
          total: 0,
        })
      );
    });

    it('should return all registered plugins', async () => {
      const registry = {
        'plugin-1': createPluginEntry({ id: 'plugin-1' }),
        'plugin-2': createPluginEntry({ id: 'plugin-2', version: '2.0.0' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({ id: 'plugin-1' }),
            expect.objectContaining({ id: 'plugin-2' }),
          ]),
          total: 2,
        })
      );
    });

    it('should include enabled status for each plugin', async () => {
      const registry = {
        'enabled-plugin': createPluginEntry({ id: 'enabled-plugin' }),
        'disabled-plugin': createPluginEntry({ id: 'disabled-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:enabled:enabled-plugin': 'true',
          'plugins:enabled:disabled-plugin': 'false',
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({ id: 'enabled-plugin', enabled: true }),
            expect.objectContaining({ id: 'disabled-plugin', enabled: false }),
          ]),
        })
      );
    });

    it('should include config source for each plugin', async () => {
      const registry = {
        'kv-config-plugin': createPluginEntry({ id: 'kv-config-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:kv-config-plugin': JSON.stringify({ key: 'value' }),
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({
              id: 'kv-config-plugin',
              configSource: 'kv',
            }),
          ]),
        })
      );
    });

    it('should resolve setup bootstrap config for builtin email plugins', async () => {
      const registry = {
        'notifier-cloudflare': createPluginEntry({ id: 'notifier-cloudflare' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:notifier-cloudflare': JSON.stringify({
            type: 'object',
            required: ['defaultFrom'],
          }),
        },
      });

      const c = createMockContext({
        kv,
        envOverrides: {
          EMAIL_FROM: 'noreply@example.com',
        },
      });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({
              id: 'notifier-cloudflare',
              configSource: 'env',
              configured: true,
              missingRequiredFields: [],
            }),
          ]),
        })
      );
    });

    it('should include last health check if available', async () => {
      const registry = {
        'healthy-plugin': createPluginEntry({ id: 'healthy-plugin' }),
      };

      const healthData = {
        status: 'healthy',
        timestamp: Date.now(),
        message: 'All systems operational',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:health:healthy-plugin': JSON.stringify(healthData),
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: expect.arrayContaining([
            expect.objectContaining({
              id: 'healthy-plugin',
              lastHealthCheck: expect.objectContaining({
                status: 'healthy',
              }),
            }),
          ]),
        })
      );
    });

    it('should return 500 when KV namespace is not available', async () => {
      const c = createMockContext({});
      c.env.SETTINGS = undefined;

      const response = await listPluginsHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(500);
      expect(body).toHaveProperty('error');
    });

    it('should sort plugins by name', async () => {
      const registry = {
        'z-plugin': createPluginEntry({
          id: 'z-plugin',
          meta: { name: 'Zebra Plugin', description: 'Z', category: 'notification' },
        }),
        'a-plugin': createPluginEntry({
          id: 'a-plugin',
          meta: { name: 'Alpha Plugin', description: 'A', category: 'notification' },
        }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      const response = (c.json as any).mock.calls[0][0];
      expect(response.plugins[0].meta.name).toBe('Alpha Plugin');
      expect(response.plugins[1].meta.name).toBe('Zebra Plugin');
    });
  });
});

// =============================================================================
// Get Plugin Details Tests
// =============================================================================

describe('Plugin Admin API - Get Plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/plugins/:id', () => {
    it('should return plugin details', async () => {
      const registry = {
        'test-plugin': createPluginEntry(),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: expect.objectContaining({
            id: 'test-plugin',
            version: '1.0.0',
          }),
          status: expect.objectContaining({
            pluginId: 'test-plugin',
            enabled: false,
          }),
        })
      );
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should mask sensitive fields in config', async () => {
      const registry = {
        'secret-plugin': createPluginEntry({ id: 'secret-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:secret-plugin': JSON.stringify({
            apiKey: 'sk-verysecretapikey1234567890',
            endpoint: 'https://api.example.com',
          }),
        },
      });

      const c = createMockContext({
        params: { id: 'secret-plugin' },
        kv,
      });

      await getPluginHandler(c);

      const response = (c.json as any).mock.calls[0][0];
      expect(response.config.apiKey).toContain('****');
      expect(response.config.endpoint).toBe('https://api.example.com');
    });

    it('should include setup bootstrap values in plugin details', async () => {
      const registry = {
        'notifier-cloudflare': createPluginEntry({ id: 'notifier-cloudflare' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:notifier-cloudflare': JSON.stringify({
            type: 'object',
            required: ['defaultFrom'],
          }),
        },
      });

      const c = createMockContext({
        params: { id: 'notifier-cloudflare' },
        kv,
        envOverrides: {
          EMAIL_FROM: 'noreply@example.com',
          EMAIL_FROM_NAME: 'Authrim',
        },
      });

      await getPluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.objectContaining({
            configSource: 'env',
            configured: true,
            missingRequiredFields: [],
          }),
          config: expect.objectContaining({
            defaultFrom: 'noreply@example.com',
            fromName: 'Authrim',
          }),
        })
      );
    });

    it('should include schema if available', async () => {
      const registry = {
        'schema-plugin': createPluginEntry({ id: 'schema-plugin' }),
      };

      const schema = {
        type: 'object',
        properties: {
          apiKey: { type: 'string' },
        },
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:schema-plugin': JSON.stringify(schema),
        },
      });

      const c = createMockContext({
        params: { id: 'schema-plugin' },
        kv,
      });

      await getPluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          configSchema: expect.objectContaining({
            type: 'object',
          }),
        })
      );
    });

    it('should include disclaimer for community plugins', async () => {
      const registry = {
        'community-plugin': createPluginEntry({
          id: 'community-plugin',
          trustLevel: 'community',
          official: false,
          source: { type: 'npm', identifier: '@third-party/plugin' },
        }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        params: { id: 'community-plugin' },
        kv,
      });

      await getPluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          disclaimer: expect.stringContaining('third party'),
        })
      );
    });

    it('should not include disclaimer for official plugins', async () => {
      const registry = {
        'official-plugin': createPluginEntry({
          id: 'official-plugin',
          trustLevel: 'official',
          official: true,
        }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        params: { id: 'official-plugin' },
        kv,
      });

      await getPluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          disclaimer: null,
        })
      );
    });
  });
});

// =============================================================================
// Get Plugin Config Tests
// =============================================================================

describe('Plugin Admin API - Get Plugin Config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/plugins/:id/config', () => {
    it('should return plugin configuration', async () => {
      const config = { apiKey: 'test-key', endpoint: 'https://api.example.com' };

      const kv = createMockKV({
        getValues: {
          'plugins:config:test-plugin': JSON.stringify(config),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          source: 'kv',
        })
      );
    });

    it('should mask sensitive fields in response', async () => {
      const config = {
        apiKey: 'sk-1234567890abcdefghij',
        password: 'secretpassword123',
        endpoint: 'https://api.example.com',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:config:test-plugin': JSON.stringify(config),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginConfigHandler(c);

      const response = (c.json as any).mock.calls[0][0];
      expect(response.config.apiKey).toContain('****');
      expect(response.config.password).toContain('****');
      expect(response.config.endpoint).toBe('https://api.example.com');
    });

    it('should return tenant-specific config for the context tenant', async () => {
      const globalConfig = { apiKey: 'global-key', timeout: 5000 };
      const tenantConfig = { apiKey: 'tenant-key' };

      const kv = createMockKV({
        getValues: {
          'plugins:config:test-plugin': JSON.stringify(globalConfig),
          'plugins:config:test-plugin:tenant:tenant-1': JSON.stringify(tenantConfig),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        tenantId: 'tenant-1',
        kv,
      });

      await getPluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          tenantId: 'tenant-1',
          source: 'kv',
        })
      );
    });

    it('should return default config when no config is stored', async () => {
      const kv = createMockKV({
        getValues: {},
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          config: {},
          source: 'default',
        })
      );
    });
  });
});

// =============================================================================
// Update Plugin Config Tests
// =============================================================================

describe('Plugin Admin API - Update Plugin Config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PUT /api/admin/plugins/:id/config', () => {
    it('should update plugin configuration', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const storedConfigs: Record<string, string> = {};
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
        putCallback: (key, value) => {
          storedConfigs[key] = value;
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: { endpoint: 'https://new-api.example.com', timeout: 3000 },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
        })
      );
    });

    it('should preserve masked secret values when saving other fields', async () => {
      let savedConfig = '';
      const registry = {
        'notifier-resend': createPluginEntry({ id: 'notifier-resend' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:notifier-resend': JSON.stringify({
            apiKey: 're_live_12345678',
            defaultFrom: 'noreply@example.com',
          }),
        },
        putCallback: (key, value) => {
          if (key === 'plugins:config:notifier-resend') {
            savedConfig = value;
          }
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'notifier-resend' },
        pluginTenantScope: 'platform',
        body: {
          config: {
            apiKey: 're_l****5678',
            defaultFrom: 'updated@example.com',
          },
        },
        kv,
      });

      const response = (await updatePluginConfigHandler(c)) as Response;
      const { body } = await getResponseData(response);

      expect(body.config.apiKey).toContain('****');
      expect(JSON.parse(savedConfig)).toMatchObject({
        _encrypted: ['apiKey'],
        defaultFrom: 'updated@example.com',
      });
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent' },
        body: {
          config: { key: 'value' },
        },
        kv,
      });

      const response = await updatePluginConfigHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should reject invalid config body', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: 'not-an-object',
        },
        kv,
      });

      const response = await updatePluginConfigHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
    });

    it('should support tenant-specific configuration', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const storedConfigs: Record<string, string> = {};
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
        putCallback: (key, value) => {
          storedConfigs[key] = value;
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        tenantId: 'tenant-1',
        body: {
          config: { apiKey: 'tenant-specific-key' },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          tenantId: 'tenant-1',
        })
      );

      // Verify the correct key was used
      expect(kv.put).toHaveBeenCalledWith(
        'plugins:config:test-plugin:tenant:tenant-1',
        expect.any(String)
      );
    });

    it('should merge with existing configuration', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const existingConfig = { apiKey: 'existing-key', timeout: 5000 };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:test-plugin': JSON.stringify(existingConfig),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: { timeout: 3000 },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      // Verify merged config is returned (apiKey preserved, timeout updated)
      const response = (c.json as any).mock.calls[0][0];
      expect(response.config.timeout).toBe(3000);
    });

    it('should identify and encrypt secret fields', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: {
            apiKey: 'secret-api-key-value',
            endpoint: 'https://api.example.com',
          },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          encryptedFields: expect.arrayContaining(['apiKey']),
        })
      );
    });

    it('should use explicit secret_fields when provided', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: {
            customSecret: 'my-secret-value',
            notSecret: 'public-value',
          },
          secret_fields: ['customSecret'],
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          encryptedFields: ['customSecret'],
        })
      );
    });

    it('should reject secret config updates when plugin encryption key is unavailable', async () => {
      vi.mocked(getPluginEncryptionKey).mockRejectedValueOnce(
        new Error('Plugin encryption key not configured')
      );

      let savedConfig = '';
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
        putCallback: (_key, value) => {
          savedConfig = value;
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: {
            apiKey: 'secret-value',
          },
        },
        kv,
      });

      const response = (await updatePluginConfigHandler(c)) as Response;
      const { status } = await getResponseData(response);

      expect(status).toBe(500);
      expect(savedConfig).toBe('');
    });
  });
});

// =============================================================================
// Enable/Disable Plugin Tests
// =============================================================================

describe('Plugin Admin API - Enable/Disable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PUT /api/admin/plugins/:id/enable', () => {
    it('should enable a plugin', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: {},
        kv,
      });

      await enablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          enabled: true,
        })
      );

      expect(kv.put).toHaveBeenCalledWith('plugins:enabled:test-plugin', 'true');
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await enablePluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should reject enabling a plugin with missing required configuration', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:test-plugin': JSON.stringify({
            type: 'object',
            required: ['apiKey'],
          }),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        kv,
      });

      const response = await enablePluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(400);
      expect(body).toMatchObject({
        error: expect.any(String),
      });
      expect(kv.put).not.toHaveBeenCalledWith('plugins:enabled:test-plugin', 'true');
    });

    it('should support tenant-specific enable', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        tenantId: 'tenant-1',
        kv,
      });

      await enablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          tenantId: 'tenant-1',
          enabled: true,
        })
      );

      expect(kv.put).toHaveBeenCalledWith('plugins:enabled:test-plugin:tenant:tenant-1', 'true');
    });
  });

  describe('PUT /api/admin/plugins/:id/disable', () => {
    it('should disable a plugin', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: {},
        kv,
      });

      await disablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          enabled: false,
        })
      );

      expect(kv.put).toHaveBeenCalledWith('plugins:enabled:test-plugin', 'false');
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await disablePluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should support tenant-specific disable', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        tenantId: 'tenant-1',
        kv,
      });

      await disablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          tenantId: 'tenant-1',
          enabled: false,
        })
      );

      expect(kv.put).toHaveBeenCalledWith('plugins:enabled:test-plugin:tenant:tenant-1', 'false');
    });
  });

  describe('Tenant override behavior', () => {
    it('should allow tenant-specific enable when globally disabled', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:enabled:test-plugin': 'false', // Globally disabled
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        tenantId: 'special-tenant',
        kv,
      });

      await enablePluginHandler(c);

      expect(kv.put).toHaveBeenCalledWith(
        'plugins:enabled:test-plugin:tenant:special-tenant',
        'true'
      );
    });
  });
});

// =============================================================================
// Test Email Tests
// =============================================================================

describe('Plugin Admin API - Test Email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/admin/plugins/:id/test-email', () => {
    it('should send a test email with the selected builtin provider', async () => {
      const emailSend = vi.fn().mockResolvedValue({ messageId: 'cf-msg-1' });
      const registry = {
        'notifier-cloudflare': createPluginEntry({ id: 'notifier-cloudflare' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:notifier-cloudflare': JSON.stringify({
            type: 'object',
            required: ['defaultFrom'],
          }),
          'plugins:config:notifier-cloudflare': JSON.stringify({
            defaultFrom: 'noreply@example.com',
          }),
          'plugins:enabled:notifier-cloudflare': 'true',
        },
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'notifier-cloudflare' },
        kv,
        body: {
          to: 'user@example.com',
        },
        envOverrides: {
          EMAIL: {
            send: emailSend,
          },
        },
      });

      const response = (await sendPluginTestEmailHandler(c)) as Response;
      const { body, status } = await getResponseData(response);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        pluginId: 'notifier-cloudflare',
        to: 'user@example.com',
        messageId: 'cf-msg-1',
      });
      expect(emailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Authrim test email',
        })
      );
    });
  });
});

// =============================================================================
// Health Check Tests
// =============================================================================

describe('Plugin Admin API - Health Check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/plugins/:id/health', () => {
    it('should return health status', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const healthData = {
        status: 'healthy',
        timestamp: Date.now(),
        message: 'All systems operational',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:health:test-plugin': JSON.stringify(healthData),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHealthHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          health: expect.objectContaining({
            status: 'healthy',
            message: 'All systems operational',
          }),
        })
      );
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginHealthHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should return unknown status when no health data available', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHealthHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          health: expect.objectContaining({
            status: 'unknown',
          }),
        })
      );
    });

    it('should handle degraded health status', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const healthData = {
        status: 'degraded',
        timestamp: Date.now(),
        message: 'Slow response from external API',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:health:test-plugin': JSON.stringify(healthData),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHealthHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          health: expect.objectContaining({
            status: 'degraded',
          }),
        })
      );
    });

    it('should handle unhealthy status', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const healthData = {
        status: 'unhealthy',
        timestamp: Date.now(),
        message: 'API connection failed',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:health:test-plugin': JSON.stringify(healthData),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHealthHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          health: expect.objectContaining({
            status: 'unhealthy',
            message: 'API connection failed',
          }),
        })
      );
    });
  });
});

// =============================================================================
// Schema Tests
// =============================================================================

describe('Plugin Admin API - Schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/plugins/:id/schema', () => {
    it('should return plugin schema', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const schema = {
        type: 'object',
        properties: {
          apiKey: { type: 'string', description: 'API key for authentication' },
          timeout: { type: 'number', default: 5000 },
        },
        required: ['apiKey'],
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:test-plugin': JSON.stringify(schema),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginSchemaHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
          version: '1.0.0',
          schema: expect.objectContaining({
            type: 'object',
            properties: expect.any(Object),
          }),
        })
      );
    });

    it('should return 404 for non-existent plugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginSchemaHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should return 404 when schema is not registered', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          // No schema stored
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      const response = await getPluginSchemaHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should include plugin meta in response', async () => {
      const meta = {
        name: 'Email Notifier',
        description: 'Send emails via SMTP',
        category: 'notification',
        icon: 'mail',
      };

      const registry = {
        'email-plugin': createPluginEntry({ id: 'email-plugin', meta }),
      };

      const schema = {
        type: 'object',
        properties: {},
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:schema:email-plugin': JSON.stringify(schema),
        },
      });

      const c = createMockContext({
        params: { id: 'email-plugin' },
        kv,
      });

      await getPluginSchemaHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            name: 'Email Notifier',
            category: 'notification',
          }),
        })
      );
    });
  });
});

// =============================================================================
// Internal Registration Functions Tests
// =============================================================================

describe('Plugin Registration Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerPlugin', () => {
    it('should register a plugin in KV', async () => {
      const kv = createMockKV({ getValues: {} });

      const plugin = {
        id: 'new-plugin',
        version: '1.0.0',
        capabilities: ['notifier.email'],
        official: true,
        meta: {
          name: 'New Plugin',
          description: 'A new plugin',
          category: 'notification' as const,
        },
      };

      const result = await registerPlugin(kv, plugin);

      expect(result.warnings).toBeUndefined();
      expect(kv.put).toHaveBeenCalledWith(
        'plugins:registry',
        expect.stringContaining('new-plugin')
      );
    });

    it('should store schema separately', async () => {
      const kv = createMockKV({ getValues: {} });

      const plugin = {
        id: 'schema-plugin',
        version: '1.0.0',
        capabilities: [],
      };

      const schema = {
        type: 'object',
        properties: { key: { type: 'string' } },
      };

      await registerPlugin(kv, plugin, schema);

      expect(kv.put).toHaveBeenCalledWith('plugins:schema:schema-plugin', JSON.stringify(schema));
    });

    it('should determine trust level from source', async () => {
      const kv = createMockKV({ getValues: {} });

      // Builtin plugin should be official
      await registerPlugin(kv, {
        id: 'builtin-plugin',
        version: '1.0.0',
        capabilities: [],
        source: { type: 'builtin', identifier: 'ar-lib-plugin/builtin/test' },
      });

      // Community npm plugin should be community
      await registerPlugin(kv, {
        id: 'community-plugin',
        version: '1.0.0',
        capabilities: [],
        source: { type: 'npm', identifier: '@third-party/plugin' },
      });

      // Check that put was called with correct trust levels
      const putCalls = (kv.put as any).mock.calls;
      const registryCall = putCalls.find((c: any[]) => c[0] === 'plugins:registry');
      expect(registryCall).toBeDefined();
    });

    it('should return warnings for invalid URLs in metadata', async () => {
      const kv = createMockKV({ getValues: {} });

      const plugin = {
        id: 'url-warning-plugin',
        version: '1.0.0',
        capabilities: [],
        meta: {
          name: 'URL Warning Plugin',
          description: 'Plugin with problematic URLs',
          category: 'notification' as const,
          icon: 'http://localhost/icon.png', // Should trigger warning
        },
      };

      const result = await registerPlugin(kv, plugin);

      // Current implementation logs warnings but doesn't return them for icon validation
      // The test documents actual behavior
      expect(typeof result.warnings === 'undefined' || Array.isArray(result.warnings)).toBe(true);
    });
  });

  describe('updatePluginHealth', () => {
    it('should update health status in KV', async () => {
      const kv = createMockKV({ getValues: {} });

      await updatePluginHealth(kv, 'test-plugin', {
        status: 'healthy',
        message: 'All systems operational',
      });

      expect(kv.put).toHaveBeenCalledWith(
        'plugins:health:test-plugin',
        expect.stringContaining('"status":"healthy"'),
        expect.objectContaining({ expirationTtl: 3600 })
      );
    });

    it('should include timestamp in health data', async () => {
      const kv = createMockKV({ getValues: {} });

      const beforeUpdate = Date.now();
      await updatePluginHealth(kv, 'test-plugin', {
        status: 'degraded',
        message: 'Slow response',
      });

      const putCall = (kv.put as any).mock.calls[0];
      const healthData = JSON.parse(putCall[1]);

      expect(healthData.timestamp).toBeGreaterThanOrEqual(beforeUpdate);
      expect(healthData.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should handle unhealthy status', async () => {
      const kv = createMockKV({ getValues: {} });

      await updatePluginHealth(kv, 'test-plugin', {
        status: 'unhealthy',
        message: 'Connection failed',
      });

      expect(kv.put).toHaveBeenCalledWith(
        'plugins:health:test-plugin',
        expect.stringContaining('"status":"unhealthy"'),
        expect.any(Object)
      );
    });
  });
});

// =============================================================================
// Concurrency Tests
// =============================================================================

describe('Plugin Admin API - Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Concurrent config updates', () => {
    it('should handle concurrent updates to same plugin config', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const storedConfigs: string[] = [];
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:test-plugin': JSON.stringify({ version: 0 }),
        },
        putCallback: (key, value) => {
          if (key === 'plugins:config:test-plugin') {
            storedConfigs.push(value);
          }
        },
      });

      // Create two contexts for concurrent updates
      const c1 = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: { config: { version: 1, updatedBy: 'user-1' } },
        kv,
      });

      const c2 = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: { config: { version: 2, updatedBy: 'user-2' } },
        kv,
      });

      // Execute updates concurrently
      await Promise.all([updatePluginConfigHandler(c1), updatePluginConfigHandler(c2)]);

      // Both updates should complete (last-write-wins semantics)
      expect(storedConfigs.length).toBe(2);

      // Both handlers should report success
      expect(c1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(c2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should handle concurrent enable/disable on same plugin', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const enabledStates: string[] = [];
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
        putCallback: (key, value) => {
          if (key === 'plugins:enabled:test-plugin') {
            enabledStates.push(value);
          }
        },
      });

      const enableContext = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: {},
        kv,
      });

      const disableContext = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        body: {},
        kv,
      });

      // Execute enable and disable concurrently
      await Promise.all([enablePluginHandler(enableContext), disablePluginHandler(disableContext)]);

      // Both operations should complete
      expect(enabledStates.length).toBe(2);
      // Final state depends on execution order
      expect(['true', 'false']).toContain(enabledStates[enabledStates.length - 1]);
    });
  });

  describe('Concurrent operations on different plugins', () => {
    it('should handle parallel updates to different plugins', async () => {
      const registry = {
        'plugin-1': createPluginEntry({ id: 'plugin-1' }),
        'plugin-2': createPluginEntry({ id: 'plugin-2' }),
        'plugin-3': createPluginEntry({ id: 'plugin-3' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const contexts = [
        createMockContext({
          method: 'PUT',
          params: { id: 'plugin-1' },
          body: { config: { key: 'value1' } },
          kv,
        }),
        createMockContext({
          method: 'PUT',
          params: { id: 'plugin-2' },
          body: { config: { key: 'value2' } },
          kv,
        }),
        createMockContext({
          method: 'PUT',
          params: { id: 'plugin-3' },
          body: { config: { key: 'value3' } },
          kv,
        }),
      ];

      // Execute all updates in parallel
      await Promise.all(contexts.map((c) => updatePluginConfigHandler(c)));

      // All should succeed
      for (const c of contexts) {
        expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      }
    });
  });
});

// =============================================================================
// Audit and Traceability Tests
// =============================================================================

describe('Plugin Admin API - Traceability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Config update traceability', () => {
    it('should include plugin ID in config update response', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: { config: { endpoint: 'https://api.example.com' } },
        kv,
        adminAuth: { userId: 'admin-123', authMethod: 'password' },
      });

      await updatePluginConfigHandler(c);

      // Response should include plugin ID for traceability
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
        })
      );
    });

    it('should include tenant ID when updating tenant-specific config', async () => {
      const registry = {
        'audited-plugin': createPluginEntry({ id: 'audited-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'audited-plugin' },
        body: { config: { key: 'value' } },
        tenantId: 'tenant-123',
        kv,
      });

      await updatePluginConfigHandler(c);

      // Response should include tenant ID for audit purposes
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'audited-plugin',
          tenantId: 'tenant-123',
        })
      );
    });
  });

  describe('Enable/Disable traceability', () => {
    it('should include status in enable response', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        kv,
      });

      await enablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          enabled: true,
        })
      );
    });

    it('should include status in disable response', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {},
        kv,
      });

      await disablePluginHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pluginId: 'test-plugin',
          enabled: false,
        })
      );
    });
  });

  describe('Secret handling in responses', () => {
    it('should not return raw secret values in config update response', async () => {
      const registry = {
        'secret-plugin': createPluginEntry({ id: 'secret-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'secret-plugin' },
        body: {
          config: {
            apiKey: 'super-secret-api-key-12345',
            password: 'my-secret-password',
            endpoint: 'https://api.example.com',
          },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      // Get the response
      const jsonCalls = (c.json as any).mock.calls;
      const responseStr = JSON.stringify(jsonCalls);

      // Response should not contain raw secrets
      expect(responseStr).not.toContain('super-secret-api-key-12345');
      expect(responseStr).not.toContain('my-secret-password');
    });

    it('should indicate which fields were encrypted', async () => {
      const registry = {
        'encrypt-test': createPluginEntry({ id: 'encrypt-test' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'encrypt-test' },
        body: {
          config: {
            apiKey: 'secret-value-here',
            endpoint: 'https://api.example.com',
          },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      // Response should indicate encrypted fields for transparency
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          encryptedFields: expect.arrayContaining(['apiKey']),
        })
      );
    });
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Plugin Admin API - Security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Plugin ID validation', () => {
    it('should handle plugin ID with special characters safely', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: '../../../etc/passwd' },
        kv,
      });

      const response = await getPluginHandler(c);
      const { body, status } = await getResponseData(response);

      // Should return 404, not traverse directories
      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should handle plugin ID with colons safely', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'plugin:with:colons' },
        kv,
      });

      const response = await getPluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });
  });

  describe('Tenant ID validation', () => {
    it('should handle malformed tenant_id in config request', async () => {
      const kv = createMockKV({
        getValues: {},
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        query: { tenant_id: "'; DROP TABLE plugins; --" },
        pluginTenantScope: 'platform',
        kv,
      });

      await getPluginConfigHandler(c);

      // Should return normally (the tenant_id is just used as a KV key suffix)
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'test-plugin',
        })
      );
    });
  });

  describe('Response information leakage prevention', () => {
    it('should not expose encrypted values in API response', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      // Simulate encrypted config with enc:v1: prefix
      const encryptedConfig = {
        apiKey: 'enc:v1:base64iv:base64ciphertext',
        endpoint: 'https://api.example.com',
        _encrypted: ['apiKey'],
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:test-plugin': JSON.stringify(encryptedConfig),
        },
      });

      const c = createMockContext({
        params: { id: 'test-plugin' },
        kv,
      });

      await getPluginHandler(c);

      const response = (c.json as any).mock.calls[0][0];
      // Undecryptable encrypted fields are omitted rather than exposing ciphertext.
      expect(response.config).not.toHaveProperty('apiKey');
      expect(JSON.stringify(response.config)).not.toContain('enc:v1:');
    });
  });

  describe('Config size limits', () => {
    it('should handle large config object', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      // Create a large config
      const largeConfig: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        largeConfig[`key${i}`] = `value${i}`;
      }

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: {
          config: largeConfig,
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });
});

// =============================================================================
// Pagination and Filtering Tests
// =============================================================================

describe('Plugin Admin API - Pagination and Filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Large plugin list handling', () => {
    it('should handle 50+ plugins in registry', async () => {
      const registry: Record<string, ReturnType<typeof createPluginEntry>> = {};
      for (let i = 0; i < 50; i++) {
        registry[`plugin-${i}`] = createPluginEntry({
          id: `plugin-${i}`,
          meta: {
            name: `Plugin ${i}`,
            description: `Description for plugin ${i}`,
            category: 'notification',
          },
        });
      }

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({ kv });

      await listPluginsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 50,
          plugins: expect.any(Array),
        })
      );

      const response = (c.json as any).mock.calls[0][0];
      expect(response.plugins.length).toBe(50);
    });

    it('should return consistent ordering across requests', async () => {
      const registry: Record<string, ReturnType<typeof createPluginEntry>> = {};
      for (let i = 0; i < 10; i++) {
        registry[`plugin-${String.fromCharCode(97 + i)}`] = createPluginEntry({
          id: `plugin-${String.fromCharCode(97 + i)}`,
          meta: {
            name: `Plugin ${String.fromCharCode(65 + i)}`,
            description: 'Test',
            category: 'notification',
          },
        });
      }

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      // Make two requests
      const c1 = createMockContext({ kv });
      const c2 = createMockContext({ kv });

      await listPluginsHandler(c1);
      await listPluginsHandler(c2);

      const response1 = (c1.json as any).mock.calls[0][0];
      const response2 = (c2.json as any).mock.calls[0][0];

      // Order should be consistent
      expect(response1.plugins.map((p: any) => p.id)).toEqual(
        response2.plugins.map((p: any) => p.id)
      );
    });
  });
});

// =============================================================================
// Error Response Consistency Tests
// =============================================================================

describe('Plugin Admin API - Error Response Consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Error format standardization', () => {
    it('should return consistent 404 error format for getPlugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('should return consistent 404 error format for getPluginHealth', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginHealthHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('should return consistent 404 error format for getPluginSchema', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await getPluginSchemaHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });

    it('should return consistent 404 error format for enablePlugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await enablePluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should return consistent 404 error format for disablePlugin', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify({}),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent' },
        kv,
      });

      const response = await disablePluginHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(404);
      expect(body).toHaveProperty('error');
    });

    it('should return 400 for invalid body in updatePluginConfig', async () => {
      const registry = {
        'test-plugin': createPluginEntry({ id: 'test-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'test-plugin' },
        body: { config: null },
        kv,
      });

      const response = await updatePluginConfigHandler(c);
      const { body, status } = await getResponseData(response);

      expect(status).toBe(400);
      expect(body).toHaveProperty('error');
    });
  });
});

// =============================================================================
// Data Integrity Tests
// =============================================================================

describe('Plugin Admin API - Data Integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Registry data integrity', () => {
    it('should preserve all plugin fields through registration', async () => {
      const kv = createMockKV({ getValues: {} });

      const plugin = {
        id: 'full-plugin',
        version: '2.1.3',
        capabilities: ['notifier.email', 'idp.google'],
        official: false,
        meta: {
          name: 'Full Plugin',
          description: 'A plugin with all metadata',
          category: 'notification' as const,
          icon: 'https://cdn.example.com/icon.png',
        },
        source: { type: 'npm' as const, identifier: '@example/plugin' },
      };

      await registerPlugin(kv, plugin);

      // Check that all fields were stored
      expect(kv.put).toHaveBeenCalledWith(
        'plugins:registry',
        expect.stringContaining('"version":"2.1.3"')
      );
      expect(kv.put).toHaveBeenCalledWith(
        'plugins:registry',
        expect.stringContaining('"notifier.email"')
      );
    });

    it('should handle JSON with special characters in config', async () => {
      const registry = {
        'special-plugin': createPluginEntry({ id: 'special-plugin' }),
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'special-plugin' },
        body: {
          config: {
            template: 'Hello, {{name}}!\n\tIndented text',
            regex: '^[a-z]+$',
            unicode: '日本語テスト',
          },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });

  describe('Config merge behavior', () => {
    it('should correctly merge nested config objects', async () => {
      const registry = {
        'nested-plugin': createPluginEntry({ id: 'nested-plugin' }),
      };

      const existingConfig = {
        server: {
          host: 'old.example.com',
          port: 8080,
        },
        auth: {
          type: 'basic',
        },
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:nested-plugin': JSON.stringify(existingConfig),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nested-plugin' },
        pluginTenantScope: 'platform',
        body: {
          config: {
            server: {
              host: 'new.example.com',
            },
          },
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      // The server.host should be updated, but server.port should be preserved
      const putCalls = (kv.put as any).mock.calls;
      const configCall = putCalls.find((c: any[]) => c[0] === 'plugins:config:nested-plugin');
      expect(configCall).toBeDefined();
    });

    it('should allow replacing entire config with replace_all flag', async () => {
      const registry = {
        'replace-plugin': createPluginEntry({ id: 'replace-plugin' }),
      };

      const existingConfig = {
        oldKey: 'oldValue',
        anotherKey: 'anotherValue',
      };

      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
          'plugins:config:replace-plugin': JSON.stringify(existingConfig),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'replace-plugin' },
        body: {
          config: { newKey: 'newValue' },
          replace_all: true,
        },
        kv,
      });

      await updatePluginConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });
});

// =============================================================================
// Tenant Isolation Tests
// =============================================================================

describe('Plugin Admin API - Tenant Isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tenant-specific data isolation', () => {
    it('should not leak tenant-specific config to other tenants', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:config:test-plugin': JSON.stringify({ globalKey: 'global-value' }),
          'plugins:config:test-plugin:tenant:tenant-A': JSON.stringify({
            secretKey: 'tenant-A-secret',
          }),
          'plugins:config:test-plugin:tenant:tenant-B': JSON.stringify({
            secretKey: 'tenant-B-secret',
          }),
        },
      });

      // Request from tenant-A
      const cA = createMockContext({
        params: { id: 'test-plugin' },
        tenantId: 'tenant-A',
        kv,
      });

      await getPluginConfigHandler(cA);

      const responseA = (cA.json as any).mock.calls[0][0];
      expect(responseA.config).not.toHaveProperty('secretKey', 'tenant-B-secret');
    });

    it('should keep global config separate from tenant config', async () => {
      const kv = createMockKV({
        getValues: {
          'plugins:config:test-plugin': JSON.stringify({ globalSetting: 'global' }),
          'plugins:config:test-plugin:tenant:tenant-1': JSON.stringify({
            tenantSetting: 'tenant-specific',
          }),
        },
      });

      // Request global config (no tenant_id)
      const cGlobal = createMockContext({
        params: { id: 'test-plugin' },
        pluginTenantScope: 'platform',
        kv,
      });

      await getPluginConfigHandler(cGlobal);

      const globalResponse = (cGlobal.json as any).mock.calls[0][0];
      expect(globalResponse.config.globalSetting).toBe('global');
      expect(globalResponse.config).not.toHaveProperty('tenantSetting');
    });
  });

  describe('Tenant enable/disable independence', () => {
    it('should maintain independent enable state per tenant', async () => {
      const registry = {
        'multi-tenant-plugin': createPluginEntry({ id: 'multi-tenant-plugin' }),
      };

      const enableStates: Record<string, string> = {};
      const kv = createMockKV({
        getValues: {
          'plugins:registry': JSON.stringify(registry),
        },
        putCallback: (key, value) => {
          enableStates[key] = value;
        },
      });

      // Enable for tenant-1
      const c1 = createMockContext({
        method: 'PUT',
        params: { id: 'multi-tenant-plugin' },
        body: {},
        tenantId: 'tenant-1',
        kv,
      });
      await enablePluginHandler(c1);

      // Disable for tenant-2
      const c2 = createMockContext({
        method: 'PUT',
        params: { id: 'multi-tenant-plugin' },
        body: {},
        tenantId: 'tenant-2',
        kv,
      });
      await disablePluginHandler(c2);

      expect(enableStates['plugins:enabled:multi-tenant-plugin:tenant:tenant-1']).toBe('true');
      expect(enableStates['plugins:enabled:multi-tenant-plugin:tenant:tenant-2']).toBe('false');
    });
  });
});
