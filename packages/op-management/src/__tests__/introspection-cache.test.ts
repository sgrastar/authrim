/**
 * Introspection Cache Settings Unit Tests
 *
 * Tests for Token Introspection Response Cache configuration
 * Admin API endpoints and cache logic in introspect handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/shared';
import {
  getIntrospectionCacheSettings,
  getIntrospectionCacheConfig,
  getIntrospectionCacheConfigHandler,
  updateIntrospectionCacheConfigHandler,
  clearIntrospectionCacheConfigHandler,
} from '../routes/settings/introspection-cache';

// Helper to create mock context for Admin API handlers
function createMockContext(options: { body?: Record<string, unknown>; env?: Partial<Env> }) {
  const mockEnv: Partial<Env> = {
    SETTINGS: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    ...options.env,
  };

  const c = {
    req: {
      json: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any;

  return c;
}

describe('Introspection Cache Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getIntrospectionCacheSettings', () => {
    it('should return default settings when no KV or env override exists', async () => {
      const env = {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
        },
      } as unknown as Env;

      const { settings, sources } = await getIntrospectionCacheSettings(env);

      expect(settings).toEqual({
        enabled: true,
        ttlSeconds: 60,
      });
      expect(sources).toEqual({
        enabled: 'default',
        ttlSeconds: 'default',
      });
    });

    it('should use environment variable when set', async () => {
      const env = {
        INTROSPECTION_CACHE_ENABLED: 'false',
        INTROSPECTION_CACHE_TTL_SECONDS: '30',
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
        },
      } as unknown as Env;

      const { settings, sources } = await getIntrospectionCacheSettings(env);

      expect(settings).toEqual({
        enabled: false,
        ttlSeconds: 30,
      });
      expect(sources).toEqual({
        enabled: 'env',
        ttlSeconds: 'env',
      });
    });

    it('should prioritize KV over environment variable', async () => {
      const env = {
        INTROSPECTION_CACHE_ENABLED: 'false',
        INTROSPECTION_CACHE_TTL_SECONDS: '30',
        SETTINGS: {
          get: vi.fn().mockResolvedValue(
            JSON.stringify({
              oidc: {
                introspectionCache: {
                  enabled: true,
                  ttlSeconds: 120,
                },
              },
            })
          ),
        },
      } as unknown as Env;

      const { settings, sources } = await getIntrospectionCacheSettings(env);

      expect(settings).toEqual({
        enabled: true,
        ttlSeconds: 120,
      });
      expect(sources).toEqual({
        enabled: 'kv',
        ttlSeconds: 'kv',
      });
    });

    it('should handle KV read errors gracefully', async () => {
      const env = {
        SETTINGS: {
          get: vi.fn().mockRejectedValue(new Error('KV error')),
        },
      } as unknown as Env;

      const { settings, sources } = await getIntrospectionCacheSettings(env);

      expect(settings).toEqual({
        enabled: true,
        ttlSeconds: 60,
      });
      expect(sources).toEqual({
        enabled: 'default',
        ttlSeconds: 'default',
      });
    });

    it('should handle invalid TTL in environment variable', async () => {
      const env = {
        INTROSPECTION_CACHE_TTL_SECONDS: 'invalid',
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
        },
      } as unknown as Env;

      const { settings, sources } = await getIntrospectionCacheSettings(env);

      expect(settings.ttlSeconds).toBe(60);
      expect(sources.ttlSeconds).toBe('default');
    });
  });

  describe('getIntrospectionCacheConfig', () => {
    it('should return just the settings object', async () => {
      const env = {
        SETTINGS: {
          get: vi.fn().mockResolvedValue(null),
        },
      } as unknown as Env;

      const config = await getIntrospectionCacheConfig(env);

      expect(config).toEqual({
        enabled: true,
        ttlSeconds: 60,
      });
    });
  });

  describe('GET /api/admin/settings/introspection-cache', () => {
    it('should return settings with sources and descriptions', async () => {
      const c = createMockContext({
        env: {
          SETTINGS: {
            get: vi.fn().mockResolvedValue(null),
          } as unknown as KVNamespace,
        },
      });

      await getIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            enabled: expect.objectContaining({
              value: true,
              source: 'default',
              default: true,
            }),
            ttlSeconds: expect.objectContaining({
              value: 60,
              source: 'default',
              default: 60,
            }),
          }),
          note: expect.stringContaining('active=true'),
        })
      );
    });

    it('should handle errors gracefully', async () => {
      const c = createMockContext({
        env: {
          SETTINGS: {
            get: vi.fn().mockRejectedValue(new Error('KV error')),
          } as unknown as KVNamespace,
        },
      });

      // Force the handler to throw by making json also throw
      let result: any;
      c.json = vi.fn((body, status = 200) => {
        result = { body, status };
        return new Response(JSON.stringify(body), { status });
      });

      await getIntrospectionCacheConfigHandler(c);

      // Should still return successfully with default values
      expect(result.body.settings.enabled.value).toBe(true);
    });
  });

  describe('PUT /api/admin/settings/introspection-cache', () => {
    it('should update enabled setting', async () => {
      const mockPut = vi.fn().mockResolvedValue(undefined);
      // Mock get to return the updated value after put is called
      let savedSettings = JSON.stringify({});
      const mockGet = vi.fn().mockImplementation(() => Promise.resolve(savedSettings));
      mockPut.mockImplementation((key, value) => {
        savedSettings = value;
        return Promise.resolve(undefined);
      });

      const c = createMockContext({
        body: { enabled: false },
        env: {
          SETTINGS: {
            get: mockGet,
            put: mockPut,
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(mockPut).toHaveBeenCalledWith(
        'system_settings',
        expect.stringContaining('"enabled":false')
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          settings: expect.objectContaining({
            enabled: false,
          }),
        })
      );
    });

    it('should update ttlSeconds setting', async () => {
      const mockPut = vi.fn().mockResolvedValue(undefined);
      let savedSettings = JSON.stringify({});
      const mockGet = vi.fn().mockImplementation(() => Promise.resolve(savedSettings));
      mockPut.mockImplementation((key, value) => {
        savedSettings = value;
        return Promise.resolve(undefined);
      });

      const c = createMockContext({
        body: { ttlSeconds: 30 },
        env: {
          SETTINGS: {
            get: mockGet,
            put: mockPut,
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(mockPut).toHaveBeenCalledWith(
        'system_settings',
        expect.stringContaining('"ttlSeconds":30')
      );
    });

    it('should reject invalid enabled value', async () => {
      const c = createMockContext({
        body: { enabled: 'yes' },
        env: {
          SETTINGS: {
            get: vi.fn(),
            put: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('boolean'),
        }),
        400
      );
    });

    it('should reject non-integer ttlSeconds', async () => {
      const c = createMockContext({
        body: { ttlSeconds: 30.5 },
        env: {
          SETTINGS: {
            get: vi.fn(),
            put: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('integer'),
        }),
        400
      );
    });

    it('should reject ttlSeconds out of range (too low)', async () => {
      const c = createMockContext({
        body: { ttlSeconds: 0 },
        env: {
          SETTINGS: {
            get: vi.fn(),
            put: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('between 1 and 3600'),
        }),
        400
      );
    });

    it('should reject ttlSeconds out of range (too high)', async () => {
      const c = createMockContext({
        body: { ttlSeconds: 7200 },
        env: {
          SETTINGS: {
            get: vi.fn(),
            put: vi.fn(),
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('between 1 and 3600'),
        }),
        400
      );
    });

    it('should return 500 when SETTINGS KV is not configured', async () => {
      const c = createMockContext({
        body: { enabled: false },
        env: {
          SETTINGS: undefined as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });

    it('should return 400 for invalid JSON body', async () => {
      const c = createMockContext({
        env: {
          SETTINGS: {
            get: vi.fn(),
            put: vi.fn(),
          } as unknown as KVNamespace,
        },
      });
      c.req.json = vi.fn().mockRejectedValue(new Error('Invalid JSON'));

      await updateIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid JSON body',
        }),
        400
      );
    });

    it('should preserve existing settings when updating', async () => {
      const existingSettings = {
        oidc: {
          tokenExchange: { enabled: true },
          introspectionCache: { enabled: true, ttlSeconds: 60 },
        },
        rateLimit: { maxRequests: 100 },
      };
      const mockPut = vi.fn().mockResolvedValue(undefined);
      let savedSettingsStr = JSON.stringify(existingSettings);
      const mockGet = vi.fn().mockImplementation(() => Promise.resolve(savedSettingsStr));
      mockPut.mockImplementation((key, value) => {
        savedSettingsStr = value;
        return Promise.resolve(undefined);
      });

      const c = createMockContext({
        body: { ttlSeconds: 30 },
        env: {
          SETTINGS: {
            get: mockGet,
            put: mockPut,
          } as unknown as KVNamespace,
        },
      });

      await updateIntrospectionCacheConfigHandler(c);

      const putCall = mockPut.mock.calls[0];
      const savedSettings = JSON.parse(putCall[1]);

      // Should preserve other settings
      expect(savedSettings.oidc.tokenExchange).toEqual({ enabled: true });
      expect(savedSettings.rateLimit).toEqual({ maxRequests: 100 });
      // Should update only ttlSeconds
      expect(savedSettings.oidc.introspectionCache.enabled).toBe(true);
      expect(savedSettings.oidc.introspectionCache.ttlSeconds).toBe(30);
    });
  });

  describe('DELETE /api/admin/settings/introspection-cache', () => {
    it('should clear introspection cache settings', async () => {
      const existingSettings = {
        oidc: {
          tokenExchange: { enabled: true },
          introspectionCache: { enabled: false, ttlSeconds: 30 },
        },
      };
      const mockPut = vi.fn().mockResolvedValue(undefined);
      // Mock get to return cleared settings after put is called
      let savedSettingsStr = JSON.stringify(existingSettings);
      const mockGet = vi.fn().mockImplementation(() => Promise.resolve(savedSettingsStr));
      mockPut.mockImplementation((key, value) => {
        savedSettingsStr = value;
        return Promise.resolve(undefined);
      });

      const c = createMockContext({
        env: {
          SETTINGS: {
            get: mockGet,
            put: mockPut,
          } as unknown as KVNamespace,
        },
      });

      await clearIntrospectionCacheConfigHandler(c);

      const putCall = mockPut.mock.calls[0];
      const savedSettings = JSON.parse(putCall[1]);

      // Should remove introspectionCache but preserve other settings
      expect(savedSettings.oidc.introspectionCache).toBeUndefined();
      expect(savedSettings.oidc.tokenExchange).toEqual({ enabled: true });

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          sources: expect.objectContaining({
            enabled: 'default',
            ttlSeconds: 'default',
          }),
          note: expect.stringContaining('cleared'),
        })
      );
    });

    it('should handle when no existing settings exist', async () => {
      const mockPut = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        env: {
          SETTINGS: {
            get: vi.fn().mockResolvedValue(null),
            put: mockPut,
          } as unknown as KVNamespace,
        },
      });

      await clearIntrospectionCacheConfigHandler(c);

      // Should not call put when no existing settings
      expect(mockPut).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 500 when SETTINGS KV is not configured', async () => {
      const c = createMockContext({
        env: {
          SETTINGS: undefined as unknown as KVNamespace,
        },
      });

      await clearIntrospectionCacheConfigHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });
  });
});
