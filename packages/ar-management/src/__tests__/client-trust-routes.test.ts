import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK } from 'jose';
import { ClientRepository, type Env, type AdminAuthContext } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
const seams = vi.hoisted(() => ({
  context: vi.fn(),
  gate: vi.fn<typeof import('../admin-step-up-gate').requireAdminStepUp>(),
  audit: vi.fn(),
  fetchKeys: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: seams.context,
  createAuditLogFromContext: seams.audit,
  safeFetchJson: seams.fetchKeys,
  invalidateClientCache: vi.fn(),
  invalidateClientCacheOnDelete: vi.fn(),
  invalidateWebOriginRegistryCache: vi.fn(),
  publishEvent: vi.fn(async () => undefined),
  putClient: vi.fn(),
}));
vi.mock('../redirect-uri-policy', () => ({
  redirectUriRefusedByPolicy: async () => null,
  REDIRECT_URI_POLICY_DESCRIPTION: '',
}));
vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: seams.gate }));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  scheduleAdminAuditLog: vi.fn(),
}));
vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async () => ({})),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(),
  disableTenantDiscoveryAliasDirectoryIfPublished: vi.fn(),
}));
import {
  adminClientCreateHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
  adminClientsBulkDeleteHandler,
  adminClientRegenerateSecretHandler,
} from '../admin-clients';
import { adminClientTrustPolicyUpsertHandler } from '../admin-consent-policies';
let store: ReturnType<typeof openCoreStore>;
let repository: ClientRepository;
let app: Hono<{ Bindings: Env; Variables: { tenantId: string; adminAuth: AdminAuthContext } }>;
const env = {
  CLIENTS_CACHE: { delete: async () => undefined },
  SETTINGS: { get: async () => null },
} as unknown as Env;
beforeEach(async () => {
  vi.clearAllMocks();
  seams.fetchKeys.mockReset().mockRejectedValue(new Error('JWKS fetch refused'));
  store = openCoreStore();
  repository = new ClientRepository(store.adapter, 'tenant-a');
  seams.context.mockReturnValue({
    coreAdapter: store.adapter,
    repositories: { client: repository },
  });
  seams.gate.mockResolvedValue(null);
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/clients', adminClientCreateHandler);
  app.put('/clients/:id', adminClientUpdateHandler);
  app.delete('/clients/:id', adminClientDeleteHandler);
  app.post('/bulk', adminClientsBulkDeleteHandler);
  app.post('/clients/:id/rotate', adminClientRegenerateSecretHandler);
  app.put('/policies', adminClientTrustPolicyUpsertHandler);
  await repository.create({
    client_id: 'app',
    client_name: 'App',
    enabled: false,
    redirect_uris: ['https://app.example/cb'],
    client_secret_hash: 'synthetic',
    require_pkce: true,
  });
});
afterEach(() => store.db.close());
const request = (path: string, method: string, body?: object) =>
  app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'same-operation' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env
  );

describe('client trust route decisions', () => {
  it('refuses CIBA activation without confidential authentication', async () => {
    await repository.update('app', {
      grant_types: ['urn:openid:params:grant-type:ciba'],
      response_types: [],
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    });
    const response = await request('/clients/app', 'PUT', { enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'client_configuration_required_to_enable',
      missing: ['token_endpoint_auth_method'],
    });
    expect((await repository.findByClientId('app'))?.enabled).toBe(false);
  });
  it.each([
    [false, { scope: 'email' }, undefined],
    [false, { enabled: true }, 'client.trust.activate'],
    [true, { scope: 'email' }, 'client.trust.activate'],
    [true, { client_name: 'Renamed' }, undefined],
    [true, { enabled: false }, 'client.trust.disable'],
    [true, { enabled: false, scope: 'email' }, 'client.trust.activate'],
    [false, { backchannel_logout_uri: 'https://app.example/logout' }, 'client.trust.activate'],
    [false, { backchannel_logout_session_required: true }, 'client.trust.activate'],
  ])('enabled=%s, patch=%j uses %s', async (enabled, patch, operation) => {
    await repository.update('app', { enabled });
    const response = await request('/clients/app', 'PUT', patch);
    expect(response.status, await response.clone().text()).toBe(200);
    if (!operation) expect(seams.gate).not.toHaveBeenCalled();
    else {
      expect(seams.gate).toHaveBeenCalledOnce();
      const descriptor = seams.gate.mock.calls[0][1];
      expect(descriptor.operation).toBe(operation);
      expect(typeof descriptor.resourceVersion).toBe('string');
    }
  });
  it('does not write a refused activation or changed logout target', async () => {
    const original = await repository.findByClientId('app');
    seams.gate.mockResolvedValue(Response.json({ error: 'step_up_required' }, { status: 403 }));
    expect((await request('/clients/app', 'PUT', { enabled: true })).status).toBe(403);
    expect(await repository.findByClientId('app')).toEqual(original);
    expect(
      (
        await request('/clients/app', 'PUT', {
          post_logout_redirect_uris: ['https://app.example/logout'],
        })
      ).status
    ).toBe(403);
    expect(await repository.findByClientId('app')).toEqual(original);
  });
  it('reports incomplete activation before spending evidence and permits disabling incomplete legacy clients', async () => {
    await repository.update('app', { redirect_uris: [] });
    const refusal = await request('/clients/app', 'PUT', { enabled: true });
    expect(refusal.status).toBe(400);
    expect(await refusal.json()).toMatchObject({
      error: 'client_configuration_required_to_enable',
      missing: ['redirect_uris'],
    });
    expect(seams.gate).not.toHaveBeenCalled();
    await repository.update('app', { enabled: true });
    expect((await request('/clients/app', 'PUT', { enabled: false })).status).toBe(200);
  });
  it('validates stored keys on an active update but still permits disabling an invalid legacy client', async () => {
    await repository.update('app', {
      enabled: true,
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [] },
    });
    expect((await request('/clients/app', 'PUT', { client_name: 'Renamed' })).status).toBe(200);
    expect(seams.gate).not.toHaveBeenCalled();
    expect((await request('/clients/app', 'PUT', { scope: 'email' })).status).toBe(400);
    expect(seams.gate).not.toHaveBeenCalled();
    expect((await request('/clients/app', 'PUT', { enabled: false })).status).toBe(200);
  });
  it('permits replacing malformed stored keys while still checking supplied draft keys', async () => {
    store.db.prepare("UPDATE oauth_clients SET jwks='malformed' WHERE client_id='app'").run();
    expect((await request('/clients/app', 'PUT', { client_name: 'Renamed' })).status).toBe(200);
    expect((await request('/clients/app', 'PUT', { jwks: { keys: [] } })).status).toBe(400);
    expect((await request('/clients/app', 'PUT', { jwks: null })).status).toBe(200);
  });
  it('keeps incomplete legacy clients editable until their effective trust changes', async () => {
    await repository.update('app', {
      enabled: true,
      redirect_uris: [],
      client_secret_hash: null,
      scope: 'openid',
    });
    expect(
      (await request('/clients/app', 'PUT', { client_name: 'Renamed', enabled: true })).status
    ).toBe(200);
    expect((await request('/clients/app', 'PUT', { scope: 'openid' })).status).toBe(200);
    expect(seams.gate).not.toHaveBeenCalled();
    const changed = await request('/clients/app', 'PUT', { scope: 'email' });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({
      error: 'client_configuration_required_to_enable',
      missing: ['redirect_uris', 'client_secret'],
    });
    expect((await request('/clients/app', 'PUT', { enabled: false, scope: 'email' })).status).toBe(
      200
    );
    expect((await request('/clients/app', 'PUT', { enabled: true })).status).toBe(400);
  });
  it.each([false, true])(
    'validates secret rotation completeness only when enabled=%s',
    async (enabled) => {
      await repository.update('app', { enabled, redirect_uris: [] });
      const response = await request('/clients/app/rotate', 'POST', {});
      expect(response.status).toBe(enabled ? 400 : 200);
      if (enabled) expect(seams.gate).not.toHaveBeenCalled();
    }
  );
  it('checks incomplete clients on trust policy changes but permits policy display edits and no-ops', async () => {
    const policy = { target_type: 'oidc_client', target_id: 'app', first_party: true };
    await repository.update('app', { redirect_uris: [] });
    expect((await request('/policies', 'PUT', policy)).status).toBe(200);
    await repository.update('app', { enabled: true });
    expect((await request('/policies', 'PUT', { ...policy, display_name: 'Renamed' })).status).toBe(
      200
    );
    expect((await request('/policies', 'PUT', policy)).status).toBe(200);
    seams.gate.mockClear();
    expect((await request('/policies', 'PUT', { ...policy, trusted: true })).status).toBe(400);
    expect(seams.gate).not.toHaveBeenCalled();
    expect(await store.adapter.queryOne('SELECT trusted FROM client_trust_policies')).toMatchObject(
      { trusted: 0 }
    );
  });
  it.each([false, true])(
    'creation enabled=%s has stable approval inputs and never hashes generated credentials',
    async (enabled) => {
      const body = {
        client_name: 'New',
        enabled,
        redirect_uris: ['https://new.example/cb'],
        require_pkce: true,
      };
      seams.gate.mockResolvedValue(Response.json({ error: 'step_up_required' }, { status: 403 }));
      const first = await request('/clients', 'POST', body);
      if (!enabled) {
        expect(first.status).toBe(201);
        expect(seams.gate).not.toHaveBeenCalled();
        return;
      }
      expect(first.status).toBe(403);
      const descriptor = seams.gate.mock.calls[0][1];
      expect(descriptor.targetIds).toBeUndefined();
      expect((await request('/clients', 'POST', body)).status).toBe(403);
      expect(seams.gate.mock.calls[1][1]).toEqual(descriptor);
      expect((await repository.listByTenant('tenant-a')).items).toHaveLength(1);
    }
  );
  it('gates deletion once and leaves data untouched when refused', async () => {
    seams.gate.mockResolvedValue(
      Response.json({ error: 'admin_fresh_auth_required' }, { status: 403 })
    );
    expect((await request('/clients/missing', 'DELETE')).status).toBe(404);
    expect(seams.gate).not.toHaveBeenCalled();
    expect((await request('/clients/app', 'DELETE')).status).toBe(403);
    expect((await request('/bulk', 'POST', { client_ids: ['app'] })).status).toBe(403);
    expect(seams.gate.mock.calls.every(([, d]) => d.operation === 'client.trust.disable')).toBe(
      true
    );
    expect(await repository.findByClientId('app')).not.toBeNull();
  });
  it.each([false, true])(
    'rotation enabled=%s covers activation only for active clients',
    async (enabled) => {
      await repository.update('app', { enabled });
      const before = await repository.findByClientId('app');
      expect((await request('/clients/app/rotate', 'POST', {})).status).toBe(200);
      const descriptor = seams.gate.mock.calls[0][1];
      expect(descriptor.alsoCovers).toEqual(enabled ? ['client.trust.activate'] : undefined);
      expect((await repository.findByClientId('app'))!.updated_at).toBeGreaterThan(
        before!.updated_at
      );
    }
  );
  it('does not apply a draft policy edit after a competing activation wins', async () => {
    const batch = store.adapter.batch.bind(store.adapter);
    store.adapter.batch = async (statements) => {
      await repository.update('app', { enabled: true });
      return batch(statements);
    };
    const response = await request('/policies', 'PUT', {
      target_type: 'oidc_client',
      target_id: 'app',
      first_party: true,
    });
    expect(response.status).toBe(409);
    expect(await store.adapter.query('SELECT * FROM client_trust_policies')).toEqual([]);
    expect((await repository.findByClientId('app'))?.enabled).toBe(true);
  });

  it('binds trust policy upsert to an enabled client and CASs even a disabled policy update', async () => {
    const body = { target_type: 'oidc_client', target_id: 'app', first_party: true };
    const before = (await repository.findByClientId('app'))!;
    expect((await request('/policies', 'PUT', body)).status).toBe(200);
    expect(seams.gate).not.toHaveBeenCalled();
    expect((await repository.findByClientId('app'))!.updated_at).toBeGreaterThan(before.updated_at);
    await repository.update('app', { enabled: true });
    seams.gate.mockResolvedValue(Response.json({ error: 'step_up_required' }, { status: 403 }));
    expect((await request('/policies', 'PUT', { ...body, trusted: true })).status).toBe(403);
    expect(await store.adapter.queryOne('SELECT trusted FROM client_trust_policies')).toMatchObject(
      { trusted: 0 }
    );
  });
});

const policyBody = {
  target_type: 'oidc_client',
  target_id: 'app',
  first_party: true,
  trusted: false,
};
const keyWrites = [
  {
    name: 'trust policy upsert',
    path: '/policies',
    method: 'PUT',
    body: { ...policyBody, trusted: true },
  },
  { name: 'secret rotation', path: '/clients/app/rotate', method: 'POST', body: {} },
];
async function storedPrivateKeyClient(
  enabled: boolean,
  jwks: string | null,
  jwksUri: string | null = null
) {
  expect((await request('/policies', 'PUT', policyBody)).status).toBe(200);
  await repository.update('app', {
    enabled,
    token_endpoint_auth_method: 'private_key_jwt',
    jwks_uri: jwksUri,
  });
  store.db.prepare('UPDATE oauth_clients SET jwks = ? WHERE client_id = ?').run(jwks, 'app');
  seams.gate.mockClear();
}
async function validPublicJwks() {
  const { publicKey } = await generateKeyPair('ES256');
  return {
    keys: [{ ...(await exportJWK(publicKey)), kid: 'stored-key', alg: 'ES256', use: 'sig' }],
  };
}

describe.each(keyWrites)('$name stored-key validation', ({ path, method, body }) => {
  it.each([
    '{"keys":[]}',
    'malformed',
    'null',
    '{"keys":[{"kty":"EC","kid":"broken","alg":"ES256","crv":"P-256","x":"a","y":"a"}]}',
  ])('refuses invalid stored JWKS %s before the gate or any write', async (jwks) => {
    await storedPrivateKeyClient(true, jwks);
    const before = await repository.findByClientId('app');
    const beforePolicy = await store.adapter.query('SELECT * FROM client_trust_policies');
    const response = await request(path, method, body);
    expect(response.status).toBe(400);
    const refused = await response.json<{ error: string; error_description?: unknown }>();
    expect(refused.error).toBe('invalid_request');
    expect(typeof refused.error_description).toBe('string');
    expect(seams.gate).not.toHaveBeenCalled();
    expect(seams.fetchKeys).not.toHaveBeenCalled();
    expect(await repository.findByClientId('app')).toEqual(before);
    expect(await store.adapter.query('SELECT * FROM client_trust_policies')).toEqual(beforePolicy);
  });

  it('decodes valid stored JWKS and reaches the gate', async () => {
    await storedPrivateKeyClient(true, JSON.stringify(await validPublicJwks()));
    const before = await repository.findByClientId('app');
    const response = await request(path, method, body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(seams.gate).toHaveBeenCalledOnce();
    expect((await repository.findByClientId('app'))?.updated_at).toBeGreaterThan(
      before?.updated_at ?? 0
    );
  });

  it.each(['empty', 'null', 'valid'])(
    'validates remote JWKS contents before the gate (%s)',
    async (kind) => {
      const valid = kind === 'valid';
      await storedPrivateKeyClient(true, null, 'https://keys.example.test/jwks');
      seams.fetchKeys.mockResolvedValueOnce(
        valid ? await validPublicJwks() : kind === 'null' ? null : { keys: [] }
      );
      const before = await repository.findByClientId('app');
      const response = await request(path, method, body);
      expect(response.status, await response.clone().text()).toBe(valid ? 200 : 400);
      expect(seams.fetchKeys).toHaveBeenCalledExactlyOnceWith('https://keys.example.test/jwks', {
        requireHttps: true,
        redirect: 'error',
        timeoutMs: 5000,
        maxResponseSize: 65536,
      });
      if (valid) expect(seams.gate).toHaveBeenCalledOnce();
      else {
        expect(seams.gate).not.toHaveBeenCalled();
        expect(await repository.findByClientId('app')).toEqual(before);
        expect(
          await store.adapter.queryOne('SELECT trusted FROM client_trust_policies')
        ).toMatchObject({ trusted: 0 });
      }
    }
  );

  it.each(['{"keys":[]}', 'malformed'])(
    'keeps disabled clients exempt with stored JWKS %s',
    async (jwks) => {
      await storedPrivateKeyClient(false, jwks);
      expect((await request(path, method, body)).status).toBe(200);
      expect((await repository.findByClientId('app'))?.enabled).toBe(false);
      expect(seams.fetchKeys).not.toHaveBeenCalled();
    }
  );
});

describe('stored-key completeness exemptions', () => {
  it.each(['{"keys":[]}', 'malformed'])(
    'keeps policy display edits and no-ops exempt with %s',
    async (jwks) => {
      await storedPrivateKeyClient(true, jwks);
      expect(
        (
          await request('/policies', 'PUT', {
            ...policyBody,
            display_name: 'Renamed',
            description: 'Note',
          })
        ).status
      ).toBe(200);
      expect((await request('/policies', 'PUT', policyBody)).status).toBe(200);
      expect(seams.fetchKeys).not.toHaveBeenCalled();
      expect(
        await store.adapter.queryOne('SELECT trusted FROM client_trust_policies')
      ).toMatchObject({ trusted: 0 });
    }
  );

  it.each(['malformed', 'null'])(
    'keeps invalid legacy keys %s editable and permits disabling the client',
    async (jwks) => {
      await storedPrivateKeyClient(true, jwks);
      expect((await request('/clients/app', 'PUT', { client_name: 'Renamed' })).status).toBe(200);
      expect((await request('/clients/app', 'PUT', { scope: 'email' })).status).toBe(400);
      expect((await request('/clients/app', 'PUT', { enabled: false })).status).toBe(200);
      expect((await repository.findByClientId('app'))?.enabled).toBe(false);
    }
  );
});
