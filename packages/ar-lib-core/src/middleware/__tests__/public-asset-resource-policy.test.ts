import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { describe, expect, it } from 'vitest';
import {
  isLoginUiPresetAssetPath,
  parseLoginUiPresetName,
  publicLoginUiAssetResourcePolicy,
} from '../public-asset-resource-policy';

function app() {
  const hono = new Hono();
  hono.use('*', publicLoginUiAssetResourcePolicy());
  hono.use('*', secureHeaders());
  hono.get('/api/assets/:tenant/login-ui/:kind/:file', (c) =>
    c.req.param('file') === 'missing.png' ? c.notFound() : c.body('image')
  );
  hono.get('/api/assets/:tenant/other/:file', (c) => c.body('other'));
  hono.get('/api/assets/presets/login-ui/backgrounds/:category/:file', (c) => c.body('preset'));
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

describe('Login UI background presets', () => {
  it('opens a shared preset to other origins', async () => {
    expect(await corp('/api/assets/presets/login-ui/backgrounds/nature/forest.webp')).toBe(
      'cross-origin'
    );
  });

  it('knows a preset path only in its exact form', () => {
    expect(
      isLoginUiPresetAssetPath('/api/assets/presets/login-ui/backgrounds/nature/a-b.webp')
    ).toBe(true);
    for (const path of [
      '/api/assets/presets/login-ui/backgrounds/nature/A.webp',
      '/api/assets/presets/login-ui/backgrounds/../a.webp',
      '/api/assets/presets/login-ui/backgrounds/nature/a.svg',
      '/api/assets/presets/login-ui/backgrounds/a.webp',
      '/api/assets/presets/login-ui/backgrounds/nature/sub/a.webp',
    ]) {
      expect(isLoginUiPresetAssetPath(path), path).toBe(false);
    }
  });

  it('reads the category, the name and the extension', () => {
    expect(parseLoginUiPresetName('paper/indigo-washi.webp')).toEqual({
      category: 'paper',
      name: 'indigo-washi',
      extension: 'webp',
    });
    expect(parseLoginUiPresetName('paper/indigo washi.webp')).toBeNull();
  });
});
