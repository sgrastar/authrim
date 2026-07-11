import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { adminPublicAssetUploadHandler, servePublicAssetHandler } from '../admin-public-assets';

function createMockR2Bucket(): R2Bucket {
  const objects = new Map<string, { body: ArrayBuffer; contentType: string; httpEtag: string }>();

  return {
    put: vi.fn(async (key: string, body: ArrayBuffer, options?: R2PutOptions) => {
      const metadata = options?.httpMetadata;
      const contentType =
        metadata instanceof Headers ? metadata.get('content-type') : metadata?.contentType;
      objects.set(key, {
        body,
        contentType: contentType ?? 'application/octet-stream',
        httpEtag: '"etag"',
      });
      return { key } as R2Object;
    }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.body]).stream(),
        httpEtag: object.httpEtag,
        writeHttpMetadata(headers: Headers) {
          headers.set('content-type', object.contentType);
        },
      } as unknown as R2ObjectBody;
    }),
  } as unknown as R2Bucket;
}

function createTestApp(bucket: R2Bucket | null = createMockR2Bucket()) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant_123');
    await next();
  });
  app.post('/api/admin/assets/login-ui', adminPublicAssetUploadHandler);
  app.get('/api/assets/:tenantId/login-ui/:kind/:filename', servePublicAssetHandler);

  const env = {
    PUBLIC_ASSETS: bucket ?? undefined,
  } as unknown as Env;

  return { app, env, bucket };
}

function pngFile(): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  return new File([bytes], 'logo.png', { type: 'image/png' });
}

describe('Login UI public assets', () => {
  it('uploads image assets to PUBLIC_ASSETS and serves them through the public route', async () => {
    const { app, env, bucket } = createTestApp();
    const formData = new FormData();
    formData.append('kind', 'logo');
    formData.append('file', pngFile());

    const uploadRes = await app.request(
      '/api/admin/assets/login-ui',
      {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant_123' },
        body: formData,
      },
      env
    );

    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as { url: string; contentType: string };
    expect(uploadBody.url).toMatch(/^\/api\/assets\/tenant_123\/login-ui\/logo\/[0-9a-f-]+\.png$/u);
    expect(uploadBody.contentType).toBe('image/png');
    expect(bucket?.put).toHaveBeenCalledWith(
      expect.stringMatching(/^public\/tenant_123\/login-ui\/logo\/[0-9a-f-]+\.png$/u),
      expect.any(ArrayBuffer),
      expect.objectContaining({
        httpMetadata: { contentType: 'image/png' },
      })
    );

    const publicRes = await app.request(uploadBody.url, { method: 'GET' }, env);
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get('content-type')).toBe('image/png');
    expect(publicRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(publicRes.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects invalid asset kinds and non-image uploads', async () => {
    const { app, env } = createTestApp();
    const invalidKind = new FormData();
    invalidKind.append('kind', 'script');
    invalidKind.append('file', pngFile());

    const invalidKindRes = await app.request(
      '/api/admin/assets/login-ui',
      { method: 'POST', headers: { 'X-Tenant-Id': 'tenant_123' }, body: invalidKind },
      env
    );
    expect(invalidKindRes.status).toBe(400);

    const textFile = new FormData();
    textFile.append('kind', 'logo');
    textFile.append('file', new File(['not image'], 'logo.txt', { type: 'text/plain' }));

    const textFileRes = await app.request(
      '/api/admin/assets/login-ui',
      { method: 'POST', headers: { 'X-Tenant-Id': 'tenant_123' }, body: textFile },
      env
    );
    expect(textFileRes.status).toBe(400);
  });

  it('accepts independent login panel background assets', async () => {
    const { app, env, bucket } = createTestApp();
    const formData = new FormData();
    formData.append('kind', 'panel-background');
    formData.append('file', pngFile());

    const response = await app.request(
      '/api/admin/assets/login-ui',
      { method: 'POST', headers: { 'X-Tenant-Id': 'tenant_123' }, body: formData },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toMatch(
      /^\/api\/assets\/tenant_123\/login-ui\/panel-background\/[0-9a-f-]+\.png$/u
    );
    expect(bucket?.put).toHaveBeenCalledWith(
      expect.stringMatching(/^public\/tenant_123\/login-ui\/panel-background\/[0-9a-f-]+\.png$/u),
      expect.any(ArrayBuffer),
      expect.any(Object)
    );
  });
});
