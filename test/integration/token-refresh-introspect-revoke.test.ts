import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateSecureRandomString, hashClientSecret } from '@authrim/ar-lib-core/utils/crypto';
import { tokenHandler } from '../../packages/ar-token/src/token';
import { introspectHandler } from '../../packages/ar-management/src/introspect';
import { revokeHandler } from '../../packages/ar-management/src/revoke';
import { createMockEnv } from './fixtures';

const CLIENT_ID = 'lifecycle-client';
const CLIENT_SECRET = 'lifecycle-secret';
const REDIRECT_URI = 'https://client.example/callback';
const RESOURCE = 'https://api.example.com';
const USER_ID = 'lifecycle-user';

interface TokenResponseBody {
  access_token: string;
  refresh_token: string;
  scope: string;
}

describe('refresh, introspection, and revocation lifecycle', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(async () => {
    env = await createMockEnv();
    env.DB_PII = env.DB;
    env.DB_ADMIN = env.DB;
    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'default' as never);
      c.set('tenantMetadataContext' as never, { tenantId: 'default', coreDb: c.env.DB } as never);
      c.set(
        'accountDataContext' as never,
        {
          tenantId: 'default',
          accountId: `account:${USER_ID}`,
          coreDb: c.env.DB,
          piiDb: c.env.DB,
        } as never
      );
      await next();
    });
    app.post('/token', tokenHandler);
    app.post('/introspect', introspectHandler);
    app.post('/revoke', revokeHandler);

    await env.DB.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method, tenant_id, default_resource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        CLIENT_ID,
        await hashClientSecret(CLIENT_SECRET),
        JSON.stringify([REDIRECT_URI]),
        JSON.stringify(['authorization_code', 'refresh_token']),
        JSON.stringify(['code']),
        'openid api.read api.write',
        'client_secret_post',
        'default',
        RESOURCE
      )
      .run();
  });

  async function storeAuthorizationCode(): Promise<string> {
    const code = generateSecureRandomString(48);
    const stub = env.AUTH_CODE_STORE.get(
      env.AUTH_CODE_STORE.idFromName('tenant:default:auth-code')
    );
    const response = await stub.fetch(
      new Request('http://internal/code/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          tenantId: 'default',
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          userId: USER_ID,
          scope: 'openid api.read api.write',
          resource: RESOURCE,
          authorizationServer: 'default',
          subjectType: 'end_user',
          ttlMs: 120_000,
        }),
      })
    );
    expect(response.ok).toBe(true);
    return code;
  }

  async function post(path: string, body: URLSearchParams): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(`https://id.example.com${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
      env,
      {
        waitUntil: (promise) => pending.push(promise),
        passThroughOnException: () => undefined,
        props: {},
      } as ExecutionContext
    );
    await Promise.allSettled(pending);
    return response;
  }

  async function issueTokens(): Promise<TokenResponseBody> {
    const code = await storeAuthorizationCode();
    const response = await post(
      '/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      })
    );
    const body = (await response.json()) as TokenResponseBody & {
      error?: string;
      error_description?: string;
    };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.refresh_token).toEqual(expect.any(String));
    return body;
  }

  function clientAuthenticatedBody(values: Record<string, string>): URLSearchParams {
    return new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...values,
    });
  }

  it('rotates a refresh token and rejects reuse of the previous version', async () => {
    const initial = await issueTokens();
    const refreshed = await post(
      '/token',
      clientAuthenticatedBody({
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
      })
    );
    const refreshedBody = (await refreshed.json()) as TokenResponseBody;

    expect(refreshed.status).toBe(200);
    expect(refreshedBody.refresh_token).not.toBe(initial.refresh_token);

    const replay = await post(
      '/token',
      clientAuthenticatedBody({
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
      })
    );
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('allows scope reduction and rejects scope expansion during refresh', async () => {
    const initial = await issueTokens();
    const reduced = await post(
      '/token',
      clientAuthenticatedBody({
        grant_type: 'refresh_token',
        refresh_token: initial.refresh_token,
        scope: 'openid api.read',
      })
    );
    const reducedBody = (await reduced.json()) as TokenResponseBody;
    expect(reduced.status).toBe(200);
    expect(reducedBody.scope).toBe('openid api.read');

    const second = await issueTokens();
    const expanded = await post(
      '/token',
      clientAuthenticatedBody({
        grant_type: 'refresh_token',
        refresh_token: second.refresh_token,
        scope: 'openid api.read api.write admin',
      })
    );
    expect(expanded.status).toBe(400);
    await expect(expanded.json()).resolves.toMatchObject({ error: 'invalid_scope' });
  });

  it('reports an issued access token as active with its stable claims', async () => {
    const issued = await issueTokens();
    const response = await post(
      '/introspect',
      clientAuthenticatedBody({ token: issued.access_token, token_type_hint: 'access_token' })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      active: true,
      client_id: CLIENT_ID,
      sub: USER_ID,
      scope: 'openid api.read api.write',
    });
  });

  it('returns inactive for malformed tokens without disclosing validation details', async () => {
    const response = await post('/introspect', clientAuthenticatedBody({ token: 'not-a-token' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ active: false });
  });

  it('revokes an access token and makes subsequent introspection inactive', async () => {
    const issued = await issueTokens();
    const revoked = await post(
      '/revoke',
      clientAuthenticatedBody({ token: issued.access_token, token_type_hint: 'access_token' })
    );
    expect(revoked.status).toBe(200);

    const introspected = await post(
      '/introspect',
      clientAuthenticatedBody({ token: issued.access_token })
    );
    expect(introspected.status).toBe(200);
    await expect(introspected.json()).resolves.toEqual({ active: false });
  });

  it('keeps revocation responses indistinguishable for unknown tokens', async () => {
    const response = await post('/revoke', clientAuthenticatedBody({ token: 'unknown-token' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});
