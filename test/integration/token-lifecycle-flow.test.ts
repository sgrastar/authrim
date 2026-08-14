import { beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateSecureRandomString, hashClientSecret } from '@authrim/ar-lib-core/utils/crypto';
import { tokenHandler } from '../../packages/ar-token/src/token';
import { createMockEnv } from './fixtures';

const CLIENT_ID = 'critical-flow-client';
const CLIENT_SECRET = 'critical-flow-secret';
const REDIRECT_URI = 'https://client.example.com/callback';
const RESOURCE = 'https://api.example.com';
const USER_ID = 'critical-flow-user';

describe('critical authorization-code token lifecycle', () => {
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
          accountId: `account:${USER_ID}`,
          coreDb: c.env.DB,
          piiDb: c.env.DB,
        } as never
      );
      await next();
    });
    app.post('/token', tokenHandler);

    await env.DB.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method, tenant_id, default_resource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        CLIENT_ID,
        await hashClientSecret(CLIENT_SECRET),
        JSON.stringify([REDIRECT_URI]),
        JSON.stringify(['authorization_code']),
        JSON.stringify(['code']),
        'openid',
        'client_secret_post',
        'default',
        RESOURCE
      )
      .run();
  });

  async function storeAuthorizationCode(options: { tenantId?: string } = {}): Promise<string> {
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
          tenantId: options.tenantId ?? 'default',
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          userId: USER_ID,
          scope: 'openid',
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

  async function exchange(
    code: string,
    overrides: { redirectUri?: string; resource?: string } = {}
  ): Promise<Response> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: overrides.redirectUri ?? REDIRECT_URI,
      resource: overrides.resource ?? RESOURCE,
    });
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request('http://localhost/token', {
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

  it('issues bound tokens once and rejects authorization-code replay', async () => {
    const code = await storeAuthorizationCode();

    const first = await exchange(code);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(firstBody).toMatchObject({ token_type: 'Bearer', scope: 'openid' });
    expect(firstBody.access_token).toEqual(expect.any(String));
    expect(firstBody.id_token).toEqual(expect.any(String));
    expect(firstBody.refresh_token).toEqual(expect.any(String));

    const accessClaims = decodeJwt(firstBody.access_token as string);
    expect(accessClaims).toMatchObject({ sub: USER_ID, aud: RESOURCE });

    const replay = await exchange(code);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('does not consume a code when redirect_uri binding fails', async () => {
    const code = await storeAuthorizationCode();

    const mismatch = await exchange(code, {
      redirectUri: 'https://client.example.com/different-callback',
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: 'invalid_grant' });

    const retry = await exchange(code);
    expect(retry.status).toBe(200);
  });

  it('does not consume a code when a token request attempts to retarget its resource', async () => {
    const code = await storeAuthorizationCode();

    const retarget = await exchange(code, { resource: 'https://other-api.example.com' });
    expect(retarget.status).toBe(400);
    await expect(retarget.json()).resolves.toMatchObject({ error: 'invalid_target' });

    const retry = await exchange(code);
    expect(retry.status).toBe(200);
  });

  it('rejects a cross-tenant authorization code', async () => {
    const code = await storeAuthorizationCode({ tenantId: 'other-tenant' });

    const response = await exchange(code);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });
});
