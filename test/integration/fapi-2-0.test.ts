import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateSecureRandomString, hashClientSecret } from '@authrim/ar-lib-core/utils/crypto';
import { authorizeHandler } from '../../packages/ar-auth/src/authorize';
import { tokenHandler } from '../../packages/ar-token/src/token';
import { discoveryHandler } from '../../packages/ar-discovery/src/discovery';
import { createMockEnv } from './fixtures';

const CONFIDENTIAL_CLIENT = 'fapi-confidential-client';
const PUBLIC_CLIENT = 'fapi-public-client';
const CLIENT_SECRET = 'fapi-client-secret';
const REDIRECT_URI = 'https://client.example/callback';

describe('FAPI 2.0 profile integration', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(async () => {
    env = await createMockEnv();
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'default' as never);
      c.set('tenantMetadataContext' as never, { tenantId: 'default', coreDb: c.env.DB } as never);
      c.set(
        'accountDataContext' as never,
        {
          tenantId: 'default',
          accountId: 'account:fapi-user',
          coreDb: c.env.DB,
          piiDb: c.env.DB,
        } as never
      );
      await next();
    });
    app.get('/authorize', authorizeHandler);
    app.post('/token', tokenHandler);
    app.get('/.well-known/openid-configuration', discoveryHandler);

    await registerClient(
      CONFIDENTIAL_CLIENT,
      'client_secret_post',
      await hashClientSecret(CLIENT_SECRET)
    );
    await registerClient(PUBLIC_CLIENT, 'none', null);
  });

  async function registerClient(
    clientId: string,
    authenticationMethod: string,
    secretHash: string | null
  ): Promise<void> {
    await env.DB.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        clientId,
        secretHash,
        JSON.stringify([REDIRECT_URI]),
        JSON.stringify(['authorization_code']),
        JSON.stringify(['code']),
        'openid',
        authenticationMethod,
        'default'
      )
      .run();
  }

  async function setSettings(settings: Record<string, unknown>): Promise<void> {
    await env.SETTINGS.put('system_settings', JSON.stringify(settings));
  }

  function authorizationUrl(clientId: string, extra: Record<string, string> = {}): string {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'fapi-state',
      ...extra,
    });
    return `/authorize?${query}`;
  }

  function redirectedError(response: Response): URL {
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toBeTruthy();
    return new URL(location!);
  }

  it('advertises PAR and private_key_jwt when the FAPI profile is enabled', async () => {
    await setSettings({ fapi: { enabled: true } });

    const response = await app.fetch(
      new Request('https://id.example.com/.well-known/openid-configuration'),
      env
    );
    const metadata = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(metadata.require_pushed_authorization_requests).toBe(true);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['private_key_jwt']);
  });

  it('requires PAR by default before an FAPI authorization can continue', async () => {
    await setSettings({ fapi: { enabled: true } });

    const response = await app.fetch(
      new Request(
        `https://id.example.com${authorizationUrl(CONFIDENTIAL_CLIENT, {
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
        })}`
      ),
      env
    );
    const redirect = redirectedError(response);

    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
    expect(redirect.searchParams.get('error_description')).toContain('PAR is required');
    expect(redirect.searchParams.get('state')).toBe('fapi-state');
  });

  it('rejects public clients when the FAPI tenant policy disallows them', async () => {
    await setSettings({
      fapi: { enabled: true, allowPublicClients: false },
      oidc: { requirePar: false },
    });

    const response = await app.fetch(
      new Request(
        `https://id.example.com${authorizationUrl(PUBLIC_CLIENT, {
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
        })}`
      ),
      env
    );
    const redirect = redirectedError(response);

    expect(redirect.searchParams.get('error')).toBe('invalid_client');
    expect(redirect.searchParams.get('error_description')).toContain('Public clients');
  });

  it('requires S256 PKCE even for a confidential FAPI client', async () => {
    await setSettings({ fapi: { enabled: true }, oidc: { requirePar: false } });

    const response = await app.fetch(
      new Request(`https://id.example.com${authorizationUrl(CONFIDENTIAL_CLIENT)}`),
      env
    );
    const redirect = redirectedError(response);

    expect(redirect.searchParams.get('error')).toBe('invalid_request');
    expect(redirect.searchParams.get('error_description')).toContain('PKCE with S256');
  });

  it('requires a DPoP proof before consuming an FAPI authorization code', async () => {
    await setSettings({ fapi: { enabled: true, requireDpop: true } });
    const code = generateSecureRandomString(48);
    const codeStore = env.AUTH_CODE_STORE.get(
      env.AUTH_CODE_STORE.idFromName('tenant:default:auth-code')
    );
    const stored = await codeStore.fetch(
      new Request('http://internal/code/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          tenantId: 'default',
          clientId: CONFIDENTIAL_CLIENT,
          redirectUri: REDIRECT_URI,
          userId: 'fapi-user',
          scope: 'openid',
          authorizationServer: 'default',
          subjectType: 'end_user',
          ttlMs: 120_000,
        }),
      })
    );
    expect(stored.ok).toBe(true);

    const response = await app.fetch(
      new Request('https://id.example.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: CONFIDENTIAL_CLIENT,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
        }),
      }),
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as ExecutionContext
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(body).toEqual({
      error: 'invalid_request',
      error_description: 'DPoP proof is required for this request',
    });
  });

  it('fails closed when the security-profile settings are malformed', async () => {
    await env.SETTINGS.put('system_settings', '{');

    const response = await app.fetch(
      new Request(`https://id.example.com${authorizationUrl(CONFIDENTIAL_CLIENT)}`),
      env
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });
});
