/**
 * JWT VC Issuer Metadata Route Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { jwtVcIssuerMetadataRoute } from '../jwt-vc-issuer';
import type { Env } from '../../../types';

const ACTIVE_KEY = { kid: 'ec-1', kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1', alg: 'ES256' };
const RETIRED_KEY = { kid: 'ec-0', kty: 'EC', crv: 'P-256', x: 'x0', y: 'y0', alg: 'ES256' };

function createApp(rpc: () => Promise<{ keys: unknown[] }>) {
  const idFromName = vi.fn().mockReturnValue('do-id');
  const get = vi.fn().mockReturnValue({ getVcIssuerJwksRpc: rpc });
  const env = {
    ISSUER_URL: 'https://issuer.example.com',
    KEY_MANAGER: { idFromName, get },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.get('/.well-known/jwt-vc-issuer', jwtVcIssuerMetadataRoute);
  return { app, env, idFromName };
}

describe('jwtVcIssuerMetadataRoute', () => {
  it('returns the issuer and the KeyManager JWKS with a short public cache', async () => {
    const { app, env, idFromName } = createApp(async () => ({
      keys: [ACTIVE_KEY, RETIRED_KEY],
    }));

    const res = await app.request('https://issuer.example.com/.well-known/jwt-vc-issuer', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = (await res.json()) as { issuer: string; jwks: { keys: Array<{ kid: string }> } };
    expect(body.issuer).toBe('https://issuer.example.com');
    expect(body.jwks.keys.map((k) => k.kid)).toEqual(['ec-1', 'ec-0']);
    expect(JSON.stringify(body)).not.toContain('"d"');
    expect(idFromName).toHaveBeenCalledWith(expect.stringMatching(/-v3$/));
  });

  it('does not cache a failure to reach the KeyManager', async () => {
    const { app, env } = createApp(async () => {
      throw new Error('boom');
    });

    const res = await app.request('https://issuer.example.com/.well-known/jwt-vc-issuer', {}, env);

    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ error: 'server_error' });
  });
});
