import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { adminLoginUiPresetsListHandler, servePresetAssetHandler } from '../admin-public-assets';

/** A bucket holding these keys; `list` pages two at a time so the cursor is followed. */
function bucketWith(keys: string[]): R2Bucket {
  return {
    list: vi.fn(async (options?: R2ListOptions) => {
      const matching = keys.filter((key) => key.startsWith(options?.prefix ?? ''));
      const start = Number(options?.cursor ?? 0);
      const page = matching.slice(start, start + 2);
      const truncated = start + 2 < matching.length;
      return {
        objects: page.map((key) => ({ key, size: 100 })),
        truncated,
        cursor: truncated ? String(start + 2) : undefined,
        delimitedPrefixes: [],
      } as unknown as R2Objects;
    }),
    get: vi.fn(async (key: string) =>
      keys.includes(key)
        ? ({
            body: new Blob(['image']).stream(),
            httpEtag: '"etag"',
            writeHttpMetadata() {},
          } as unknown as R2ObjectBody)
        : null
    ),
  } as unknown as R2Bucket;
}

function app(bucket: R2Bucket | undefined) {
  const hono = new Hono<{ Bindings: Env }>();
  hono.get('/api/admin/assets/login-ui/presets', adminLoginUiPresetsListHandler);
  hono.get('/api/assets/presets/login-ui/backgrounds/:category/:filename', servePresetAssetHandler);
  return { hono, env: { PUBLIC_ASSETS: bucket } as unknown as Env };
}

const KEYS = [
  'presets/login-ui/backgrounds/paper/indigo-washi.webp',
  'presets/login-ui/backgrounds/nature/hatenohama-day.webp',
  'presets/login-ui/backgrounds/nature/Bad Name.webp',
  'public/tenant_1/login-ui/background/uuid.webp',
];

describe('Login UI background presets', () => {
  it('lists the presets with the path a theme stores, following the cursor', async () => {
    const { hono, env } = app(bucketWith(KEYS));
    const response = await hono.request('/api/admin/assets/login-ui/presets', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json<{ presets: { id: string; url: string }[] }>();
    expect(body.presets.map((p) => p.id)).toEqual(['nature/hatenohama-day', 'paper/indigo-washi']);
    expect(body.presets[0].url).toBe(
      '/api/assets/presets/login-ui/backgrounds/nature/hatenohama-day.webp'
    );
  });

  it('lists none when the bucket is not configured', async () => {
    const { hono, env } = app(undefined);
    const response = await hono.request('/api/admin/assets/login-ui/presets', {}, env);
    expect(await response.json()).toEqual({ presets: [] });
  });

  it('serves a preset with a day of caching', async () => {
    const { hono, env } = app(bucketWith(KEYS));
    const response = await hono.request(
      '/api/assets/presets/login-ui/backgrounds/paper/indigo-washi.webp',
      {},
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers not found for a missing preset or a name outside the pattern', async () => {
    const { hono, env } = app(bucketWith(KEYS));
    for (const path of [
      '/api/assets/presets/login-ui/backgrounds/paper/missing.webp',
      '/api/assets/presets/login-ui/backgrounds/paper/indigo-washi.svg',
      '/api/assets/presets/login-ui/backgrounds/Paper/indigo-washi.webp',
    ]) {
      expect((await hono.request(path, {}, env)).status, path).toBe(404);
    }
  });
});
