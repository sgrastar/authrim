import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const health = vi.hoisted(() => vi.fn());
const createAdapter = vi.hoisted(() => vi.fn(() => ({ isHealthy: health })));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createDiagnosticLogR2Adapter: createAdapter,
}));
import { testDiagnosticLogR2Connection } from '../routes/diagnostic-logging/test-connection';
function app() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/test-connection', testDiagnosticLogR2Connection);
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  health.mockResolvedValue({ healthy: true, latencyMs: 1 });
});

describe('diagnostic configured archive connection', () => {
  it('always tests the configured reader and never reflects an arbitrary requested binding or secret', async () => {
    const response = await app().request(
      '/test-connection',
      { method: 'POST', body: JSON.stringify({ r2BucketBinding: 'CLOUDFLARE_API_TOKEN' }) },
      { CLOUDFLARE_API_TOKEN: 'secret-value' } as unknown as Env
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('LOG_ARCHIVE');
    expect(body).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(body).not.toContain('secret-value');
    expect(health).toHaveBeenCalledOnce();
  });
  it('reports a failed configured reader as unavailable instead of a successful empty bucket listing', async () => {
    health.mockResolvedValue({ healthy: false, latencyMs: 2, errorMessage: 'catalog_unavailable' });
    const response = await app().request(
      '/test-connection',
      { method: 'POST', body: '{}' },
      {} as Env
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      healthy: false,
      error: 'log_archive_health_check_failed',
    });
  });
});
