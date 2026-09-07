import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  createTenantPlacementWriteFenceResponse,
  isTenantPlacementWriteFenceError,
} from '../tenant-placement-write-fence';

describe('tenant placement write fence error', () => {
  it('detects raw and wrapped D1 trigger errors without matching unrelated failures', () => {
    expect(
      isTenantPlacementWriteFenceError(
        new Error('D1_ERROR: tenant_placement_migration_write_fenced at offset 7')
      )
    ).toBe(true);
    expect(
      isTenantPlacementWriteFenceError(
        new Error('adapter failed', {
          cause: new Error('tenant_placement_migration_write_fenced'),
        })
      )
    ).toBe(true);
    expect(isTenantPlacementWriteFenceError(new Error('D1_ERROR: database unavailable'))).toBe(
      false
    );
  });

  it('returns a redacted retryable 503 contract', async () => {
    const app = new Hono();
    app.get('/test', (c) =>
      createTenantPlacementWriteFenceResponse(
        c,
        new Error('D1_ERROR: tenant_placement_migration_write_fenced secret-value')
      )
    );
    const response = await app.request('/test');

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    const body = await response.json();
    expect(body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Tenant data is temporarily unavailable. Retry shortly.',
      extensions: {
        reason: 'tenant_placement_write_fence',
        retryable: true,
        retry_after_ms: 500,
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });
});
