import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { describe, expect, it } from 'vitest';
import { publicLoginUiAssetResourcePolicy } from '../public-asset-resource-policy';

function app() {
  const hono = new Hono();
  hono.use('*', publicLoginUiAssetResourcePolicy());
  hono.use('*', secureHeaders());
  hono.get('/api/assets/:tenant/login-ui/:kind/:file', (c) =>
    c.req.param('file') === 'missing.png' ? c.notFound() : c.body('image')
  );
  hono.get('/api/assets/:tenant/other/:file', (c) => c.body('other'));
  hono.get('/api/admin/screens', (c) => c.json({}));
  return hono;
}

const corp = async (path: string, method = 'GET') =>
  (await app().request(path, { method })).headers.get('cross-origin-resource-policy');

describe('publicLoginUiAssetResourcePolicy', () => {
  it('opens a public Login UI image to other origins', async () => {
    expect(await corp('/api/assets/default/login-ui/background/a.png')).toBe('cross-origin');
    expect(await corp('/api/assets/default/login-ui/background/a.png', 'HEAD')).toBe(
      'cross-origin'
    );
  });

  it('keeps every other response same-origin', async () => {
    expect(await corp('/api/admin/screens')).toBe('same-origin');
    expect(await corp('/api/assets/default/other/a.png')).toBe('same-origin');
  });

  it('keeps a failed lookup same-origin', async () => {
    expect(await corp('/api/assets/default/login-ui/background/missing.png')).toBe('same-origin');
  });
});
