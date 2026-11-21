import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { adminBodyLimitMiddleware } from '../admin-body-limit';

function app() {
  const router = new Hono<{ Bindings: Env }>();
  router.use('/api/admin/*', adminBodyLimitMiddleware(50 * 1024 * 1024));
  router.post('/api/admin/*', async (c) =>
    c.json({ bytes: (await c.req.arrayBuffer()).byteLength })
  );
  return router;
}

const post = (path: string, bytes: number) =>
  app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });

describe('the Admin API body limit', () => {
  it('lets the image uploads carry a 5 MB picture, and keeps 100 KB elsewhere', async () => {
    for (const path of ['/api/admin/assets/login-ui', '/api/admin/platform/launchers/assets']) {
      expect((await post(path, 1024 * 1024)).status).toBe(200);
      // A 5 MB picture with its form around it passes; a body past that room does not.
      expect((await post(path, 5 * 1024 * 1024 + 1024)).status).toBe(200);
      expect((await post(path, 5 * 1024 * 1024 + 64 * 1024 + 1)).status).toBe(413);
    }
    expect((await post('/api/admin/platform/launchers', 200 * 1024)).status).toBe(413);
  });
});
