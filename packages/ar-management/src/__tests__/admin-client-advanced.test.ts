import { isPublicClientJwks } from '@authrim/ar-lib-core/utils/public-client-keys';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';
import { DatabaseSync } from './test-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  ClientRepository,
  type AdminAuthContext,
  type Env,
  type ClientMetadata,
} from '@authrim/ar-lib-core';
import {
  authenticateConfidentialOAuthClient,
  validateClientAssertion,
} from '@authrim/ar-lib-core/utils/client-authentication';
import { openCoreDatabase, insertTenant } from './helpers/core-database';
import { sqliteAdapter } from './helpers/admin-authority-fixture';
import {
  adminClientCreateHandler,
  adminClientGetHandler,
  adminClientsListHandler,
  adminClientUpdateHandler,
} from '../admin-clients';
import { requireClientManagementPermission } from '../admin-resource-permissions';
import policyRouter from '../routes/policy';
import { adminClientAdvancedSchema, clientKeySettingsProblem } from '../admin-client-advanced';

const seams = vi.hoisted(() => ({ context: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: seams.context,
  createAuditLogFromContext: seams.audit,
  getWebOriginRegistry: async () => undefined,
  invalidateClientCache: async () => undefined,
  publishEvent: async () => undefined,
  putClient: async () => undefined,
}));

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  scheduleAdminAuditLog: vi.fn(),
}));
vi.mock('../tenant-alias-directory', async (original) => ({
  ...(await original<typeof import('../tenant-alias-directory')>()),
  resolveTenantDiscoveryAliasDirectoryInput: async (_env: unknown, input: unknown) => input,
  ensureActiveTenantDiscoveryAliasDirectory: async () => undefined,
}));

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
let db: ReturnType<typeof openCoreDatabase>;
let env: Env;
let repository: ClientRepository;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
const endpoint = 'https://auth.example.test/token';

function app(permissions = ['admin:clients:read', 'admin:clients:write']) {
  const router = new Hono<{
    Bindings: Env;
    Variables: { tenantId: string; adminAuth: AdminAuthContext };
  }>();
  router.use('*', async (c, next) => {
    const tenantId = c.req.header('X-Tenant-Id') ?? 'tenant-a';
    c.set('tenantId', tenantId);
    c.set('adminAuth', {
      userId: 'synthetic-admin',
      authMethod: 'machine_access_token',
      actorType: 'machine',
      tenantId,
      roles: [],
      permissions,
      hierarchyLevel: 0,
      mfaVerified: false,
    });
    await next();
  });
  router.use('/api/admin/clients/*', requireClientManagementPermission());
  router.use('/api/admin/clients', requireClientManagementPermission());
  router.get('/api/admin/clients', adminClientsListHandler);
  router.get('/api/admin/clients/:id', adminClientGetHandler);
  router.put('/api/admin/clients/:id', adminClientUpdateHandler);
  router.post('/api/admin/clients', adminClientCreateHandler);
  return router;
}
const request = (
  router: ReturnType<typeof app>,
  method: string,
  body?: unknown,
  tenant = 'tenant-a',
  id = 'client'
) =>
  router.request(
    `/api/admin/clients/${id}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenant },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(
    readRenderedMigrationSql(
      resolve(__dirname, '../../../../migrations/core/d1'),
      '001_0_5_0_core_baseline.sql'
    )
  );
  db.exec(
    readFileSync(
      resolve(__dirname, '../../../../migrations/core/d1/010_information_release_consent.sql'),
      'utf8'
    )
  );
  insertTenant(db, 'tenant-a');
  insertTenant(db, 'tenant-b');
  const adapter = sqliteAdapter(db);
  const fixture = await vi.importActual<{ createMockEnv: () => Promise<Env> }>(
    '@authrim/ar-lib-core/test/fixtures'
  );
  env = await fixture.createMockEnv();
  repository = new ClientRepository(adapter, 'tenant-a');
  seams.context.mockImplementation((_c: Context, tenantId: string) => ({
    coreAdapter: adapter,
    repositories: { client: new ClientRepository(adapter, tenantId) },
  }));
  seams.audit.mockClear();
  keys = await generateKeyPair('ES256', { extractable: true });
  publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'fixture-a', alg: 'ES256', use: 'sig' };
  await repository.create({
    client_id: 'client',
    client_name: 'Fixture',
    tenant_id: 'tenant-a',
    application_type: 'web',
    redirect_uris: ['https://app.example.test/callback'],
    grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'client_secret_basic',
    client_secret_hash: 'synthetic-hash',
    require_pkce: true,
    identity_mapping: { fieldMappingSetId: 'untouched-mapping' },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

async function assertion(key = keys.privateKey, clientId = 'client', alg = 'ES256') {
  return new SignJWT({})
    .setProtectedHeader({ alg, kid: 'fixture-a' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(endpoint)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(crypto.randomUUID())
    .sign(key);
}
async function storedClient(): Promise<ClientMetadata> {
  const row = await repository.findByClientId('client');
  if (!row?.jwks) throw new Error('Expected stored keys');
  const jwks: unknown = JSON.parse(row.jwks);
  const parsed = object(jwks);
  if (!isPublicClientJwks(parsed)) throw new Error('Expected public JWKS');
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    redirect_uris: ['https://app.example.test/callback'],
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    token_endpoint_auth_signing_alg: row.token_endpoint_auth_signing_alg ?? undefined,
    jwks: { keys: parsed.keys },
  };
}

describe('Admin callback URL deferral', () => {
  function create(body: Record<string, unknown>) {
    return app().request(
      '/api/admin/clients',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'tenant-a' },
        body: JSON.stringify(body),
      },
      env
    );
  }

  it.each([
    { label: 'empty', input: { redirect_uris: [] } },
    { label: 'omitted', input: {} },
  ])(
    'creates with $label redirects, lists and reopens it, then adds and clears callbacks',
    async ({ input }) => {
      const response = await create({ client_name: 'Callback later', ...input });
      expect(response.status).toBe(201);
      const created = object(object(await response.json()).client);
      expect(created.redirect_uris).toEqual([]);
      const id = String(created.client_id);
      expect((await repository.findByClientId(id))?.redirect_uris).toBe('[]');
      const reopened = await request(app(), 'GET', undefined, 'tenant-a', id);
      expect(reopened.status).toBe(200);
      expect(object(object(await reopened.json()).client).redirect_uris).toEqual([]);
      const listed = await app().request(
        '/api/admin/clients?search=Callback%20later',
        {
          headers: { 'X-Tenant-Id': 'tenant-a' },
        },
        env
      );
      expect(listed.status).toBe(200);
      expect(object(await listed.json()).clients).toEqual([
        expect.objectContaining({ client_id: id, redirect_uris: [] }),
      ]);
      expect(
        (
          await request(
            app(),
            'PUT',
            { redirect_uris: ['https://app.example.test/later'] },
            'tenant-a',
            id
          )
        ).status
      ).toBe(200);
      expect((await repository.findByClientId(id))?.redirect_uris).toBe(
        '["https://app.example.test/later"]'
      );
      expect((await request(app(), 'PUT', { redirect_uris: [] }, 'tenant-a', id)).status).toBe(200);
      expect((await repository.findByClientId(id))?.redirect_uris).toBe('[]');
      expect(
        (await request(app(), 'PUT', { client_name: 'Still waiting' }, 'tenant-a', id)).status
      ).toBe(200);
      expect((await repository.findByClientId(id))?.redirect_uris).toBe('[]');
    }
  );

  it.each([
    null,
    'https://app.example.test/callback',
    [12],
    ['not a URL'],
    ['https://app.example.test/callback#fragment'],
    ['http://app.example.test/callback'],
  ])('still rejects malformed redirect lists %j on create and update', async (redirect_uris) => {
    expect((await create({ client_name: 'Invalid callback', redirect_uris })).status).toBe(400);
    expect((await request(app(), 'PUT', { redirect_uris })).status).toBe(400);
    expect((await repository.findByClientId('client'))?.redirect_uris).toBe(
      '["https://app.example.test/callback"]'
    );
  });

  it('retains the pairwise sector requirement when creating or clearing callbacks', async () => {
    const rejected = await create({
      client_name: 'Pairwise later',
      subject_type: 'pairwise',
      redirect_uris: [],
    });
    expect(rejected.status).toBe(400);
    expect(object(await rejected.json()).error_description).toContain('sector_identifier_uri');
    expect((await request(app(), 'PUT', { subject_type: 'pairwise' })).status).toBe(200);
    const cleared = await request(app(), 'PUT', { redirect_uris: [] });
    expect(cleared.status).toBe(400);
    expect(object(await cleared.json()).error_description).toContain('sector_identifier_uri');
    expect((await repository.findByClientId('client'))?.redirect_uris).toBe(
      '["https://app.example.test/callback"]'
    );
  });
});

describe('Admin RP public keys and stored advanced settings', () => {
  it.each(['RS256', 'PS256'])(
    'requires a compatible configured algorithm for RSA keys without alg and authenticates %s',
    async (alg) => {
      const rsa = await generateKeyPair(alg, { extractable: true });
      const { alg: _exportedAlg, ...jwk } = await exportJWK(rsa.publicKey);
      const jwks = { keys: [{ ...jwk, kid: 'fixture-a', use: 'sig' }] };
      const router = app();
      const update = {
        token_endpoint_auth_method: 'private_key_jwt',
        jwks,
        jwks_uri: null,
      };
      expect(
        (await request(router, 'PUT', { ...update, token_endpoint_auth_signing_alg: 'ES256' }))
          .status
      ).toBe(400);
      expect((await repository.findByClientId('client'))?.token_endpoint_auth_method).toBe(
        'client_secret_basic'
      );
      expect(
        (await request(router, 'PUT', { ...update, token_endpoint_auth_signing_alg: alg })).status
      ).toBe(200);
      const reopened = object(object(await (await request(router, 'GET')).json()).client);
      expect(reopened.token_endpoint_auth_signing_alg).toBe(alg);
      expect(reopened.jwks).toEqual(jwks);
      const metadata = await storedClient();
      expect(
        await validateClientAssertion(
          await assertion(rsa.privateKey, 'client', alg),
          endpoint,
          metadata
        )
      ).toMatchObject({ valid: true });
      expect(await validateClientAssertion(await assertion(), endpoint, metadata)).toMatchObject({
        valid: false,
        error: 'invalid_client',
        error_description: 'Client assertion signing algorithm does not match client metadata',
      });
      expect(
        (await request(router, 'PUT', { token_endpoint_auth_signing_alg: 'ES256' })).status
      ).toBe(400);
      expect((await storedClient()).token_endpoint_auth_signing_alg).toBe(alg);
    }
  );
  it('atomically switches an existing client to public JWKS and authenticates its real signed assertion', async () => {
    const before = await repository.findByClientId('client');
    const router = app();
    const result = await request(router, 'PUT', {
      expected_updated_at: before?.updated_at,
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [publicKey] },
      jwks_uri: null,
      post_logout_redirect_uris: ['https://app.example.test/logout'],
      backchannel_logout_session_required: true,
    });
    expect(result.status).toBe(200);
    const saved = object(object(await result.json()).client);
    expect(saved.jwks).toEqual({ keys: [publicKey] });
    expect(saved).not.toHaveProperty('client_secret_hash');
    expect(
      await validateClientAssertion(await assertion(), endpoint, await storedClient())
    ).toMatchObject({ valid: true });
    expect(
      await authenticateConfidentialOAuthClient(await storedClient(), endpoint, {
        clientId: 'client',
        clientAssertion: await assertion(),
        clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        presentation: {
          basic: false,
          clientSecretPost: false,
          clientAssertion: true,
          clientAssertionType: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        },
      })
    ).toMatchObject({ ok: true, method: 'client_assertion' });
    expect(
      await validateClientAssertion(
        await assertion(keys.privateKey, 'other-client'),
        endpoint,
        await storedClient()
      )
    ).toMatchObject({ valid: false });
    const wrong = await generateKeyPair('ES256');
    expect(
      await validateClientAssertion(
        await assertion(wrong.privateKey),
        endpoint,
        await storedClient()
      )
    ).toMatchObject({ valid: false });
    const version = saved.updated_at;
    expect(
      (
        await request(router, 'PUT', {
          expected_updated_at: version,
          description: 'Nondefault note',
        })
      ).status
    ).toBe(200);
    const reopened = object(object(await (await request(router, 'GET')).json()).client);
    expect(reopened).toMatchObject({
      description: 'Nondefault note',
      jwks: { keys: [publicKey] },
      backchannel_logout_session_required: true,
      post_logout_redirect_uris: ['https://app.example.test/logout'],
      identity_mapping: { fieldMappingSetId: 'untouched-mapping' },
    });
    expect(
      (await request(router, 'PUT', { expected_updated_at: version, description: 'Stale' })).status
    ).toBe(409);
    expect(seams.audit).toHaveBeenCalled();
    expect(JSON.stringify(seams.audit.mock.calls)).not.toContain(publicKey.x);
  });

  it('conditionally saves key/auth changes even when an older API caller omits the version', async () => {
    const adapter = sqliteAdapter(db, {
      beforeExecute: {
        match: /UPDATE oauth_clients/,
        run: async () => {
          db.prepare(
            "UPDATE oauth_clients SET description = 'Intervening edit', updated_at = updated_at + 1 WHERE tenant_id = ? AND client_id = ?"
          ).run('tenant-a', 'client');
        },
      },
    });
    seams.context.mockImplementation((_c: Context, tenantId: string) => ({
      coreAdapter: adapter,
      repositories: { client: new ClientRepository(adapter, tenantId) },
    }));
    const response = await request(app(), 'PUT', {
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [publicKey] },
      jwks_uri: null,
    });
    expect(response.status).toBe(409);
    const row = await repository.findByClientId('client');
    expect(row?.description).toBe('Intervening edit');
    expect(row?.jwks).toBeNull();
    expect(row?.token_endpoint_auth_method).toBe('client_secret_basic');
  });

  it('validates a URI transport locally and clears the old key source in the same write', async () => {
    await repository.update('client', {
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [publicKey] },
    });
    const transport = vi.fn(async () => Response.json({ keys: [publicKey] }));
    vi.stubGlobal('fetch', transport);
    const router = app();
    expect(
      (await request(router, 'PUT', { jwks_uri: 'https://keys.example.test/jwks', jwks: null }))
        .status
    ).toBe(200);
    const row = await repository.findByClientId('client');
    expect(row?.jwks).toBeNull();
    expect(row?.jwks_uri).toBe('https://keys.example.test/jwks');
    expect(transport).toHaveBeenCalled();
    const metadata: ClientMetadata = {
      client_id: 'client',
      redirect_uris: ['https://app.example.test/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      created_at: 1,
      updated_at: 1,
      jwks_uri: row?.jwks_uri ?? undefined,
    };
    expect(await validateClientAssertion(await assertion(), endpoint, metadata)).toMatchObject({
      valid: true,
    });
  });

  it('rejects private/symmetric/malformed/duplicate/algorithm-mismatched keys before storage', async () => {
    const privateKey = { ...(await exportJWK(keys.privateKey)), kid: 'private' };
    const badSets = [
      { keys: [privateKey] },
      { keys: [{ kty: 'oct', kid: 'symmetric', k: 'test' }] },
      { keys: [] },
      { keys: [publicKey, publicKey] },
      { keys: [{ ...publicKey, alg: 'RS256' }] },
      { keys: [{ ...publicKey, x: 'invalid' }] },
    ];
    for (const jwks of badSets) {
      expect(
        (await request(app(), 'PUT', { token_endpoint_auth_method: 'private_key_jwt', jwks }))
          .status
      ).toBe(400);
    }
    expect((await repository.findByClientId('client'))?.token_endpoint_auth_method).toBe(
      'client_secret_basic'
    );
    expect((await repository.findByClientId('client'))?.jwks).toBeNull();
  });

  it('rejects missing keys, both key sources, SSRF URIs, invalid bounds, and unauthorised or cross-tenant writes', async () => {
    for (const body of [
      { token_endpoint_auth_method: 'private_key_jwt' },
      {
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: { keys: [publicKey] },
        jwks_uri: 'https://keys.example.test/jwks',
      },
      ...[
        'http://keys.example.test/jwks',
        'https://127.0.0.1/jwks',
        'https://169.254.169.254/latest',
        'https://keys.example.test/jwks#fragment',
        'https://user:password@keys.example.test/jwks',
      ].map((jwks_uri) => ({ jwks_uri })),
      { backchannel_logout_session_required: 'true' },
      { expected_updated_at: -1 },
    ])
      expect((await request(app(), 'PUT', body)).status).toBe(400);
    expect(
      (await request(app(['admin:clients:update']), 'PUT', { description: 'Denied' })).status
    ).toBe(403);
    expect((await request(app(), 'PUT', { description: 'Cross tenant' }, 'tenant-b')).status).toBe(
      404
    );
    expect((await request(app(), 'GET', undefined, 'tenant-b')).status).toBe(404);
  });

  it('redacts historical private material on read and never creates a secret transition from public/key auth', async () => {
    await repository.update('client', {
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: {
        keys: [
          { ...publicKey, d: 'synthetic-private' },
          { kty: 'oct', k: 'synthetic-secret' },
        ],
      },
    });
    const read = await request(app(), 'GET');
    const serialized = JSON.stringify(await read.json());
    expect(serialized).not.toMatch(/synthetic-private|synthetic-secret|synthetic-hash/);
    expect(
      (await request(app(), 'PUT', { token_endpoint_auth_method: 'client_secret_post' })).status
    ).toBe(400);
    await repository.update('client', {
      token_endpoint_auth_method: 'none',
      application_type: 'spa',
      jwks: null,
    });
    expect(
      (
        await request(app(), 'PUT', {
          token_endpoint_auth_method: 'private_key_jwt',
          jwks: { keys: [publicKey] },
        })
      ).status
    ).toBe(400);
  });

  it('creates a private_key_jwt client without generating or returning a client secret', async () => {
    const response = await app().request(
      '/api/admin/clients',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'tenant-a' },
        body: JSON.stringify({
          client_name: 'New fixture',
          application_type: 'web',
          redirect_uris: ['https://app.example.test/callback'],
          token_endpoint_auth_method: 'private_key_jwt',
          jwks: { keys: [publicKey] },
          require_pkce: true,
        }),
      },
      env
    );
    expect(response.status).toBe(201);
    const client = object(object(await response.json()).client);
    expect(client).not.toHaveProperty('client_secret');
    const row = await repository.findByClientId(String(client.client_id));
    expect(row?.client_secret_hash).toBeNull();
    expect(row?.jwks).toBe(JSON.stringify({ keys: [publicKey] }));
  });

  it('rejects private encryption JWKS in the policy profile mutation instead of stripping it', async () => {
    const router = new Hono<{
      Bindings: Env;
      Variables: { tenantId: string; adminAuth: AdminAuthContext };
    }>();
    router.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('adminAuth', {
        userId: 'synthetic-admin',
        authMethod: 'session',
        tenantId: 'tenant-a',
        roles: ['ar_tenant_admin'],
        permissions: ['*'],
        hierarchyLevel: 0,
        mfaVerified: true,
      });
      await next();
    });
    router.route('/api/admin', policyRouter);
    env.AUTHRIM_CONFIG = env.STATE_STORE;
    for (const jwks of [
      { keys: [{ ...publicKey, d: 'synthetic-private' }] },
      { keys: [{ kty: 'oct', kid: 'symmetric', k: 'synthetic-secret' }] },
    ]) {
      const result = await router.request(
        '/api/admin/clients/client/profile',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'tenant-a' },
          body: JSON.stringify({ ifMatch: '0', profile: { encryption: { jwks } } }),
        },
        env
      );
      expect(result.status).toBe(400);
    }
  });

  it('bounds registered public metadata and requires signing keys for private_key_jwt', async () => {
    expect(
      adminClientAdvancedSchema.safeParse({
        contacts: ['invalid'],
        frontchannel_logout_session_required: 1,
      }).success
    ).toBe(false);
    expect(
      await clientKeySettingsProblem(
        { jwks: { keys: [{ ...publicKey, use: 'enc', alg: 'ECDH-ES' }] } },
        'private_key_jwt',
        false
      )
    ).toContain('signing key');
  });
});
