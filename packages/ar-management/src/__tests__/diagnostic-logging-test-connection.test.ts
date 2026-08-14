import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { testDiagnosticLogR2Connection } from '../routes/diagnostic-logging/test-connection';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/test-connection', testDiagnosticLogR2Connection);
  return app;
}

describe('diagnostic logging connection test', () => {
  it('rejects arbitrary environment binding names without reflecting the candidate', async () => {
    const candidate = 'CLOUDFLARE_API_TOKEN';
    const response = await createApp().request(
      '/test-connection',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ r2BucketBinding: candidate }),
      },
      { CLOUDFLARE_API_TOKEN: 'secret-value' } as unknown as Env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_r2_binding');
    expect(JSON.stringify(body)).not.toContain(candidate);
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('continues to test the supported diagnostic log bucket', async () => {
    const bucket = {
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    } as unknown as R2Bucket;
    const response = await createApp().request(
      '/test-connection',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ r2BucketBinding: 'DIAGNOSTIC_LOGS', pathPrefix: 'probe' }),
      },
      { DIAGNOSTIC_LOGS: bucket } as Env
    );

    expect(response.status).toBe(200);
    expect(bucket.list).toHaveBeenCalled();
  });
});
