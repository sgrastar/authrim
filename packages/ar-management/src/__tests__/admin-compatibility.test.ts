import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import worker from '../index';

function createMockKV(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;
}

describe('Admin API compatibility surface', () => {
  it('returns the removed admin session endpoint error before admin authentication', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/admin/sessions/me', {
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      }),
      {
        DEFAULT_TENANT_ID: 'tenant-a',
        AUTHRIM_CONFIG: createMockKV(),
      } as unknown as Env
    );
    const payload = (await response.json()) as {
      error?: string;
      error_uri?: string;
      error_details?: {
        code?: string;
        severity?: string;
        retryable?: boolean;
      };
    };

    expect(response.status).toBe(404);
    expect(payload.error).toBe('legacy_endpoint_not_supported');
    expect(payload.error_uri).toBe(
      'https://docs.authrim.com/errors/error-codes#legacy-endpoint-not-supported'
    );
    expect(payload.error_details).toMatchObject({
      code: 'legacy_endpoint_not_supported',
      severity: 'fatal',
      retryable: false,
    });
  });
});
