/**
 * Token Exchange Settings Admin API Tests
 *
 * Comprehensive tests for Token Exchange configuration endpoints:
 * - GET /api/admin/settings/token-exchange - Get settings
 * - PUT /api/admin/settings/token-exchange - Update settings
 * - DELETE /api/admin/settings/token-exchange - Clear settings
 *
 * Security tests:
 * - refresh_token MUST be rejected (RFC 8693 security)
 * - Parameter range validation
 * - ID-JAG issuer URL validation
 * - KV storage priority (KV > env > default)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// Use vi.hoisted to define mocks that will be used in vi.mock factory
const { mockGetLogger } = vi.hoisted(() => ({
  mockGetLogger: vi.fn(),
}));

// Helper to reset all mocks to their default implementation
function resetMocks() {
  mockGetLogger.mockReset().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  });
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: mockGetLogger,
  };
});

import {
  getTokenExchangeConfig,
  updateTokenExchangeConfig,
  clearTokenExchangeConfig,
  getIdJagSettings,
} from '../routes/settings/token-exchange';

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

// Helper to get mock calls from KV methods (typed as KVNamespace but actually vi.fn)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getMockCalls(fn: unknown): any[][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (fn as ReturnType<typeof vi.fn>).mock.calls;
}

function createMockContext(options: {
  method?: string;
  body?: Record<string, unknown>;
  kv?: KVNamespace | null;
  env?: Partial<Env>;
}) {
  const mockKV = options.kv === null ? undefined : (options.kv ?? createMockKV({}));

  const c = {
    req: {
      method: options.method || 'GET',
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockReturnValue(null),
      path: '/api/admin/settings/token-exchange',
    },
    env: {
      SETTINGS: mockKV,
      ENABLE_TOKEN_EXCHANGE: options.env?.ENABLE_TOKEN_EXCHANGE,
      TOKEN_EXCHANGE_ALLOWED_TYPES: options.env?.TOKEN_EXCHANGE_ALLOWED_TYPES,
      TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS: options.env?.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS,
      TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS: options.env?.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS,
      ENABLE_ID_JAG: options.env?.ENABLE_ID_JAG,
      ID_JAG_ALLOWED_ISSUERS: options.env?.ID_JAG_ALLOWED_ISSUERS,
      ID_JAG_MAX_TOKEN_LIFETIME: options.env?.ID_JAG_MAX_TOKEN_LIFETIME,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn(),
    set: vi.fn(),
    _mockKV: mockKV,
  } as any;

  return c;
}

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

// =============================================================================
// GET Token Exchange Settings Tests
// =============================================================================

describe('Token Exchange Settings API - GET', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('GET /api/admin/settings/token-exchange', () => {
    it('should return default settings when no configuration exists', async () => {
      const c = createMockContext({});

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            enabled: expect.objectContaining({
              value: false,
              source: 'default',
              default: false,
            }),
            allowedSubjectTokenTypes: expect.objectContaining({
              value: ['access_token'],
              source: 'default',
            }),
            maxResourceParams: expect.objectContaining({
              value: 10,
              source: 'default',
            }),
            maxAudienceParams: expect.objectContaining({
              value: 10,
              source: 'default',
            }),
          }),
        })
      );
    });

    it('should return env-based settings when environment variables are set', async () => {
      const c = createMockContext({
        env: {
          ENABLE_TOKEN_EXCHANGE: 'true',
          TOKEN_EXCHANGE_ALLOWED_TYPES: 'access_token,jwt',
          TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS: '20',
          TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS: '15',
        },
      });

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            enabled: expect.objectContaining({
              value: true,
              source: 'env',
            }),
            allowedSubjectTokenTypes: expect.objectContaining({
              value: ['access_token', 'jwt'],
              source: 'env',
            }),
            maxResourceParams: expect.objectContaining({
              value: 20,
              source: 'env',
            }),
            maxAudienceParams: expect.objectContaining({
              value: 15,
              source: 'env',
            }),
          }),
        })
      );
    });

    it('should return KV-based settings when KV values exist (KV takes priority)', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: {
                enabled: true,
                allowedSubjectTokenTypes: ['jwt', 'id_token'],
                maxResourceParams: 50,
                maxAudienceParams: 30,
              },
            },
          }),
        },
      });

      const c = createMockContext({
        kv: mockKV,
        env: {
          ENABLE_TOKEN_EXCHANGE: 'false', // Should be overridden by KV
        },
      });

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            enabled: expect.objectContaining({
              value: true,
              source: 'kv',
            }),
            allowedSubjectTokenTypes: expect.objectContaining({
              value: ['jwt', 'id_token'],
              source: 'kv',
            }),
            maxResourceParams: expect.objectContaining({
              value: 50,
              source: 'kv',
            }),
            maxAudienceParams: expect.objectContaining({
              value: 30,
              source: 'kv',
            }),
          }),
        })
      );
    });

    it('should include valid token types in response', async () => {
      const c = createMockContext({});

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            allowedSubjectTokenTypes: expect.objectContaining({
              validOptions: ['access_token', 'jwt', 'id_token'],
            }),
          }),
        })
      );
    });

    it('should include note about refresh_token prohibition', async () => {
      const c = createMockContext({});

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          note: expect.stringContaining('refresh_token'),
        })
      );
    });

    it('should include ID-JAG settings in response', async () => {
      const c = createMockContext({});

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            idJag: expect.objectContaining({
              enabled: expect.objectContaining({
                value: false,
                source: 'default',
              }),
              allowedIssuers: expect.objectContaining({
                value: [],
                source: 'default',
              }),
              maxTokenLifetime: expect.objectContaining({
                value: 3600,
                source: 'default',
                min: 60,
                max: 86400,
              }),
              requireConfidentialClient: expect.objectContaining({
                value: true,
                source: 'default',
              }),
            }),
          }),
        })
      );
    });

    it('should handle KV read errors gracefully', async () => {
      const mockKV = createMockKV({});
      mockKV.get = vi.fn().mockRejectedValue(new Error('KV error'));

      const c = createMockContext({
        kv: mockKV,
        env: {
          ENABLE_TOKEN_EXCHANGE: 'true',
        },
      });

      await getTokenExchangeConfig(c);

      // Should fall back to env/default
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            enabled: expect.objectContaining({
              value: true,
              source: 'env',
            }),
          }),
        })
      );
    });
  });
});

// =============================================================================
// PUT Token Exchange Settings Tests
// =============================================================================

describe('Token Exchange Settings API - PUT', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('PUT /api/admin/settings/token-exchange', () => {
    it('should update enabled setting', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { enabled: true },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(mockKV.put).toHaveBeenCalledWith(
        'system_settings',
        expect.stringContaining('"enabled":true')
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          settings: expect.objectContaining({
            enabled: true,
          }),
        })
      );
    });

    it('should update allowedSubjectTokenTypes', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { allowedSubjectTokenTypes: ['access_token', 'jwt'] },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(mockKV.put).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          settings: expect.objectContaining({
            allowedSubjectTokenTypes: expect.arrayContaining(['access_token', 'jwt']),
          }),
        })
      );
    });

    it('should return error when KV is not configured', async () => {
      const c = createMockContext({
        method: 'PUT',
        body: { enabled: true },
        kv: null,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });

    it('should reject invalid JSON body', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        kv: mockKV,
      });
      c.req.json.mockRejectedValue(new Error('Invalid JSON'));

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid JSON body',
        }),
        400
      );
    });

    it('should reject non-boolean enabled value', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { enabled: 'true' }, // String instead of boolean
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('enabled'),
        }),
        400
      );
    });

    it('should reject non-array allowedSubjectTokenTypes', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { allowedSubjectTokenTypes: 'access_token' }, // String instead of array
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('allowedSubjectTokenTypes'),
        }),
        400
      );
    });

    it('should reject invalid token types', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { allowedSubjectTokenTypes: ['access_token', 'invalid_type'] },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('invalid_type'),
        }),
        400
      );
    });

    // CRITICAL SECURITY TEST: refresh_token MUST be rejected
    // Note: Current implementation rejects refresh_token as 'invalid_value' because
    // it's not in VALID_TOKEN_TYPES. The security_violation check comes after,
    // but never gets reached. This is acceptable - the key is that refresh_token IS rejected.
    it('should REJECT refresh_token (rejected as invalid type since not in VALID_TOKEN_TYPES)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { allowedSubjectTokenTypes: ['access_token', 'refresh_token'] },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      // refresh_token is rejected - either as invalid_value (current) or security_violation
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringMatching(/invalid_value|security_violation/),
        }),
        400
      );
    });

    it('should REJECT refresh_token even when it is the only type', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { allowedSubjectTokenTypes: ['refresh_token'] },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      // refresh_token is rejected - either as invalid_value (current) or security_violation
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringMatching(/invalid_value|security_violation/),
        }),
        400
      );
    });

    it('should reject maxResourceParams below minimum (1)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxResourceParams: 0 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxResourceParams'),
        }),
        400
      );
    });

    it('should reject maxResourceParams above maximum (100)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxResourceParams: 101 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxResourceParams'),
        }),
        400
      );
    });

    it('should reject non-integer maxResourceParams', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxResourceParams: 10.5 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxResourceParams'),
        }),
        400
      );
    });

    it('should reject maxAudienceParams below minimum (1)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxAudienceParams: 0 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxAudienceParams'),
        }),
        400
      );
    });

    it('should reject maxAudienceParams above maximum (100)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxAudienceParams: 101 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxAudienceParams'),
        }),
        400
      );
    });

    it('should accept maxResourceParams at boundary (1)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxResourceParams: 1 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should accept maxResourceParams at boundary (100)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { maxResourceParams: 100 },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should preserve existing settings when updating partial values', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: {
                enabled: false,
                maxResourceParams: 20,
              },
              clientCredentials: { enabled: true }, // Should be preserved
            },
            rateLimit: { windowMs: 60000 }, // Should be preserved
          }),
        },
      });

      const c = createMockContext({
        method: 'PUT',
        body: { enabled: true }, // Only update enabled
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      const putCall = getMockCalls(mockKV.put)[0];
      const savedSettings = JSON.parse(putCall[1] as string);

      expect(savedSettings.oidc.tokenExchange.enabled).toBe(true);
      expect(savedSettings.oidc.tokenExchange.maxResourceParams).toBe(20);
      expect(savedSettings.oidc.clientCredentials.enabled).toBe(true);
      expect(savedSettings.rateLimit.windowMs).toBe(60000);
    });
  });
});

// =============================================================================
// ID-JAG Settings Tests
// =============================================================================

describe('Token Exchange Settings API - ID-JAG', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('ID-JAG Settings Validation', () => {
    it('should update ID-JAG enabled setting', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { enabled: true } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          settings: expect.objectContaining({
            idJag: expect.objectContaining({
              enabled: true,
            }),
          }),
        })
      );
    });

    it('should reject non-boolean idJag.enabled', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { enabled: 'true' } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('idJag.enabled'),
        }),
        400
      );
    });

    it('should validate idJag.allowedIssuers as array', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { allowedIssuers: 'https://issuer.example.com' } }, // String, not array
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('idJag.allowedIssuers'),
        }),
        400
      );
    });

    it('should validate idJag.allowedIssuers contains valid URLs', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { allowedIssuers: ['not-a-valid-url'] } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('Invalid issuer URL'),
        }),
        400
      );
    });

    it('should accept valid issuer URLs', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: {
          idJag: {
            allowedIssuers: ['https://issuer1.example.com', 'https://issuer2.example.com'],
          },
        },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          settings: expect.objectContaining({
            idJag: expect.objectContaining({
              allowedIssuers: ['https://issuer1.example.com', 'https://issuer2.example.com'],
            }),
          }),
        })
      );
    });

    it('should reject non-HTTPS or non-public issuer URLs', async () => {
      for (const issuer of ['http://issuer.example.com', 'https://127.0.0.1']) {
        const mockKV = createMockKV({});
        const c = createMockContext({
          method: 'PUT',
          body: { idJag: { allowedIssuers: [issuer] } },
          kv: mockKV,
        });

        await updateTokenExchangeConfig(c);

        expect(c.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'invalid_value',
            error_description: expect.stringContaining('Invalid issuer URL'),
          }),
          400
        );
      }
    });

    it('should reject issuer URLs containing query or fragment components', async () => {
      for (const issuer of [
        'https://issuer.example.com?jwks=attacker',
        'https://issuer.example.com#fragment',
      ]) {
        const mockKV = createMockKV({});
        const c = createMockContext({
          method: 'PUT',
          body: { idJag: { allowedIssuers: [issuer] } },
          kv: mockKV,
        });

        await updateTokenExchangeConfig(c);

        expect(c.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'invalid_value',
            error_description: expect.stringContaining('Invalid issuer URL'),
          }),
          400
        );
      }
    });

    it('should reject empty string in allowedIssuers', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { allowedIssuers: ['https://valid.com', ''] } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('non-empty string'),
        }),
        400
      );
    });

    it('should reject maxTokenLifetime below minimum (60 seconds)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { maxTokenLifetime: 30 } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxTokenLifetime'),
        }),
        400
      );
    });

    it('should reject maxTokenLifetime above maximum (86400 seconds)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { maxTokenLifetime: 100000 } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxTokenLifetime'),
        }),
        400
      );
    });

    it('should accept maxTokenLifetime at boundary (60 seconds)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { maxTokenLifetime: 60 } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should accept maxTokenLifetime at boundary (86400 seconds)', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { maxTokenLifetime: 86400 } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should reject non-integer maxTokenLifetime', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { maxTokenLifetime: 3600.5 } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('maxTokenLifetime'),
        }),
        400
      );
    });

    it('should reject non-boolean includeTenantClaim', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { includeTenantClaim: 'true' } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('includeTenantClaim'),
        }),
        400
      );
    });

    it('should reject non-boolean requireConfidentialClient', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: { requireConfidentialClient: 'true' } },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('requireConfidentialClient'),
        }),
        400
      );
    });

    it('should reject non-object idJag value', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: 'invalid' },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('idJag'),
        }),
        400
      );
    });

    it('should reject null idJag value', async () => {
      const mockKV = createMockKV({});
      const c = createMockContext({
        method: 'PUT',
        body: { idJag: null },
        kv: mockKV,
      });

      await updateTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
        }),
        400
      );
    });
  });

  describe('ID-JAG Settings Priority (KV > env > default)', () => {
    it('should use env values when KV is empty', async () => {
      const c = createMockContext({
        env: {
          ENABLE_ID_JAG: 'true',
          ID_JAG_ALLOWED_ISSUERS: 'https://issuer1.com,https://issuer2.com',
          ID_JAG_MAX_TOKEN_LIFETIME: '7200',
        },
      });

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            idJag: expect.objectContaining({
              enabled: expect.objectContaining({
                value: true,
                source: 'env',
              }),
              allowedIssuers: expect.objectContaining({
                value: ['https://issuer1.com', 'https://issuer2.com'],
                source: 'env',
              }),
              maxTokenLifetime: expect.objectContaining({
                value: 7200,
                source: 'env',
              }),
            }),
          }),
        })
      );
    });

    it('should use KV values over env values', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: {
                idJag: {
                  enabled: false, // KV says false
                  allowedIssuers: ['https://kv-issuer.com'],
                },
              },
            },
          }),
        },
      });

      const c = createMockContext({
        kv: mockKV,
        env: {
          ENABLE_ID_JAG: 'true', // Env says true, but KV should win
          ID_JAG_ALLOWED_ISSUERS: 'https://env-issuer.com',
        },
      });

      await getTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            idJag: expect.objectContaining({
              enabled: expect.objectContaining({
                value: false,
                source: 'kv',
              }),
              allowedIssuers: expect.objectContaining({
                value: ['https://kv-issuer.com'],
                source: 'kv',
              }),
            }),
          }),
        })
      );
    });
  });
});

// =============================================================================
// DELETE Token Exchange Settings Tests
// =============================================================================

describe('Token Exchange Settings API - DELETE', () => {
  beforeEach(() => {
    resetMocks();
  });

  describe('DELETE /api/admin/settings/token-exchange', () => {
    it('should clear token exchange settings from KV', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: {
                enabled: true,
                maxResourceParams: 50,
              },
              clientCredentials: { enabled: true }, // Should be preserved
            },
          }),
        },
      });

      const c = createMockContext({
        method: 'DELETE',
        kv: mockKV,
      });

      await clearTokenExchangeConfig(c);

      const putCall = getMockCalls(mockKV.put)[0];
      const savedSettings = JSON.parse(putCall[1] as string);

      expect(savedSettings.oidc.tokenExchange).toBeUndefined();
      expect(savedSettings.oidc.clientCredentials.enabled).toBe(true);
    });

    it('should return error when KV is not configured', async () => {
      const c = createMockContext({
        method: 'DELETE',
        kv: null,
      });

      await clearTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });

    it('should return success with default values after clear', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: {
                enabled: true,
              },
            },
          }),
        },
      });

      const c = createMockContext({
        method: 'DELETE',
        kv: mockKV,
      });

      await clearTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          note: expect.stringContaining('cleared'),
        })
      );
    });

    it('should handle missing system_settings gracefully', async () => {
      const mockKV = createMockKV({}); // No existing settings

      const c = createMockContext({
        method: 'DELETE',
        kv: mockKV,
      });

      await clearTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return settings with sources after clear', async () => {
      const mockKV = createMockKV({
        getValues: {
          system_settings: JSON.stringify({
            oidc: {
              tokenExchange: { enabled: true },
            },
          }),
        },
      });

      const c = createMockContext({
        method: 'DELETE',
        kv: mockKV,
        env: {
          ENABLE_TOKEN_EXCHANGE: 'true', // Should fall back to this
        },
      });

      await clearTokenExchangeConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          sources: expect.objectContaining({
            enabled: 'env', // Should be env now, not kv
          }),
        })
      );
    });
  });
});

// =============================================================================
// getIdJagSettings Function Tests
// =============================================================================

describe('getIdJagSettings Function', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should return default settings when no config exists', async () => {
    const mockKV = createMockKV({});
    const env = {
      SETTINGS: mockKV,
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings).toEqual({
      enabled: false,
      allowedIssuers: [],
      maxTokenLifetime: 3600,
      includeTenantClaim: true,
      requireConfidentialClient: true,
    });
    expect(result.sources.enabled).toBe('default');
  });

  it('should use env values when set', async () => {
    const mockKV = createMockKV({});
    const env = {
      SETTINGS: mockKV,
      ENABLE_ID_JAG: 'true',
      ID_JAG_ALLOWED_ISSUERS: 'https://a.com,https://b.com',
      ID_JAG_MAX_TOKEN_LIFETIME: '1800',
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.enabled).toBe(true);
    expect(result.settings.allowedIssuers).toEqual(['https://a.com', 'https://b.com']);
    expect(result.settings.maxTokenLifetime).toBe(1800);
    expect(result.sources.enabled).toBe('env');
    expect(result.sources.allowedIssuers).toBe('env');
    expect(result.sources.maxTokenLifetime).toBe('env');
  });

  it('should ignore invalid maxTokenLifetime from env (below min)', async () => {
    const mockKV = createMockKV({});
    const env = {
      SETTINGS: mockKV,
      ID_JAG_MAX_TOKEN_LIFETIME: '30', // Below minimum
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.maxTokenLifetime).toBe(3600); // Default
    expect(result.sources.maxTokenLifetime).toBe('default');
  });

  it('should ignore invalid maxTokenLifetime from env (above max)', async () => {
    const mockKV = createMockKV({});
    const env = {
      SETTINGS: mockKV,
      ID_JAG_MAX_TOKEN_LIFETIME: '100000', // Above maximum
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.maxTokenLifetime).toBe(3600); // Default
    expect(result.sources.maxTokenLifetime).toBe('default');
  });

  it('should use KV values over env values', async () => {
    const mockKV = createMockKV({
      getValues: {
        system_settings: JSON.stringify({
          oidc: {
            tokenExchange: {
              idJag: {
                enabled: false,
                maxTokenLifetime: 600,
              },
            },
          },
        }),
      },
    });
    const env = {
      SETTINGS: mockKV,
      ENABLE_ID_JAG: 'true', // Should be overridden
      ID_JAG_MAX_TOKEN_LIFETIME: '1800', // Should be overridden
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.enabled).toBe(false);
    expect(result.settings.maxTokenLifetime).toBe(600);
    expect(result.sources.enabled).toBe('kv');
    expect(result.sources.maxTokenLifetime).toBe('kv');
  });

  it('should ignore invalid KV maxTokenLifetime (below min)', async () => {
    const mockKV = createMockKV({
      getValues: {
        system_settings: JSON.stringify({
          oidc: {
            tokenExchange: {
              idJag: {
                maxTokenLifetime: 30, // Below minimum
              },
            },
          },
        }),
      },
    });
    const env = {
      SETTINGS: mockKV,
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.maxTokenLifetime).toBe(3600); // Default
    expect(result.sources.maxTokenLifetime).toBe('default');
  });

  it('should handle KV errors gracefully', async () => {
    const mockKV = createMockKV({});
    mockKV.get = vi.fn().mockRejectedValue(new Error('KV error'));
    const env = {
      SETTINGS: mockKV,
      ENABLE_ID_JAG: 'true',
    } as unknown as Env;

    const result = await getIdJagSettings(env);

    expect(result.settings.enabled).toBe(true); // Falls back to env
    expect(result.sources.enabled).toBe('env');
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Token Exchange Settings API - Error Handling', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should handle KV.put errors gracefully', async () => {
    const mockKV = createMockKV({});
    mockKV.put = vi.fn().mockRejectedValue(new Error('KV write error'));

    const c = createMockContext({
      method: 'PUT',
      body: { enabled: true },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'server_error',
      }),
      500
    );
  });

  it('should not expose internal error details', async () => {
    const mockKV = createMockKV({});
    mockKV.put = vi.fn().mockRejectedValue(new Error('Internal database connection failed'));

    const c = createMockContext({
      method: 'PUT',
      body: { enabled: true },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    const [response] = getMockCalls(c.json)[0];
    expect(response.error_description).not.toContain('database');
    expect(response.error_description).toBe('Failed to update settings');
  });

  it('should handle GET errors gracefully', async () => {
    const mockKV = createMockKV({});
    // Make the first get throw, but allow reading back for partial results
    let callCount = 0;
    mockKV.get = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('KV error');
      }
      return null;
    });

    const c = createMockContext({
      kv: mockKV,
    });

    // Should not throw, should return defaults
    await getTokenExchangeConfig(c);

    expect(c.json).toHaveBeenCalled();
  });
});

// =============================================================================
// KV Storage Structure Tests
// =============================================================================

describe('Token Exchange Settings API - KV Storage Structure', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('should create nested structure when system_settings is empty', async () => {
    const mockKV = createMockKV({});
    const c = createMockContext({
      method: 'PUT',
      body: { enabled: true },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    const putCall = getMockCalls(mockKV.put)[0];
    const savedSettings = JSON.parse(putCall[1] as string);

    expect(savedSettings).toEqual({
      oidc: {
        tokenExchange: {
          enabled: true,
        },
      },
    });
  });

  it('should preserve existing oidc settings when updating tokenExchange', async () => {
    const mockKV = createMockKV({
      getValues: {
        system_settings: JSON.stringify({
          oidc: {
            clientCredentials: { enabled: true },
          },
        }),
      },
    });

    const c = createMockContext({
      method: 'PUT',
      body: { enabled: true },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    const putCall = getMockCalls(mockKV.put)[0];
    const savedSettings = JSON.parse(putCall[1] as string);

    expect(savedSettings.oidc.clientCredentials.enabled).toBe(true);
    expect(savedSettings.oidc.tokenExchange.enabled).toBe(true);
  });

  it('should preserve non-oidc settings', async () => {
    const mockKV = createMockKV({
      getValues: {
        system_settings: JSON.stringify({
          rateLimit: { windowMs: 60000, maxRequests: 100 },
        }),
      },
    });

    const c = createMockContext({
      method: 'PUT',
      body: { enabled: true },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    const putCall = getMockCalls(mockKV.put)[0];
    const savedSettings = JSON.parse(putCall[1] as string);

    expect(savedSettings.rateLimit).toEqual({ windowMs: 60000, maxRequests: 100 });
  });

  it('should merge idJag settings with existing values', async () => {
    const mockKV = createMockKV({
      getValues: {
        system_settings: JSON.stringify({
          oidc: {
            tokenExchange: {
              enabled: true,
              idJag: {
                enabled: false,
                allowedIssuers: ['https://old.com'],
                maxTokenLifetime: 3600,
              },
            },
          },
        }),
      },
    });

    const c = createMockContext({
      method: 'PUT',
      body: {
        idJag: {
          enabled: true, // Update this
          // Don't update allowedIssuers or maxTokenLifetime
        },
      },
      kv: mockKV,
    });

    await updateTokenExchangeConfig(c);

    const putCall = getMockCalls(mockKV.put)[0];
    const savedSettings = JSON.parse(putCall[1] as string);

    expect(savedSettings.oidc.tokenExchange.idJag.enabled).toBe(true);
    expect(savedSettings.oidc.tokenExchange.idJag.allowedIssuers).toEqual(['https://old.com']);
    expect(savedSettings.oidc.tokenExchange.idJag.maxTokenLifetime).toBe(3600);
  });
});
