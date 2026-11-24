/**
 * Admin API for external providers: permissions, list/get, delete and dynamic registration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV, mocks, send } from './helpers/admin-providers-mocks';
import { argRec, callArg, rec } from './helpers/mock-args';
import type { Env } from '@authrim/ar-lib-core';

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: 'prov-1',
  tenantId: 'tenant-a',
  name: 'Corp',
  clientId: 'client-1',
  clientSecretEncrypted: 'enc-secret',
  privateKeyJwkEncrypted: 'enc-jwk',
  providerQuirks: {},
  updatedAt: 1000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAll.mockResolvedValue([]);
  mocks.getProvider.mockResolvedValue(stored());
  mocks.createProvider.mockImplementation(async (_env: unknown, input: Record<string, unknown>) =>
    stored({ ...input, id: 'prov-new' })
  );
  mocks.updateProvider.mockResolvedValue(stored());
  mocks.deleteProvider.mockResolvedValue(true);
  mocks.createDiag.mockResolvedValue(null);
  mocks.logAuthDecision.mockResolvedValue(undefined);
  mocks.cleanup.mockResolvedValue(undefined);
});

const BASE_CREATE = { name: 'Corp', client_id: 'cid', client_secret: 'csecret' };

describe('permissions', () => {
  const calls: Array<[string, string, string, unknown?]> = [
    ['list', 'GET', '/providers', undefined],
    ['create', 'POST', '/providers', BASE_CREATE],
    ['get', 'GET', '/providers/prov-1', undefined],
    ['update', 'PUT', '/providers/prov-1', {}],
    ['delete', 'DELETE', '/providers/prov-1', undefined],
    ['register', 'POST', '/providers/prov-1/register', undefined],
  ];

  it.each(calls)('%s requires an authenticated admin', async (_name, method, path, body) => {
    const response = await send(method, path, body, null);
    expect(response.status).toBe(401);
  });

  it.each([
    ['list', 'GET', '/providers', undefined, 'admin:external_providers:read'],
    ['create', 'POST', '/providers', BASE_CREATE, 'admin:external_providers:write'],
    ['get', 'GET', '/providers/prov-1', undefined, 'admin:external_providers:read'],
    ['update', 'PUT', '/providers/prov-1', {}, 'admin:external_providers:write'],
    ['delete', 'DELETE', '/providers/prov-1', undefined, 'admin:external_providers:delete'],
    ['register', 'POST', '/providers/prov-1/register', undefined, 'admin:external_providers:write'],
  ])('%s needs exactly its own permission', async (_name, method, path, body, needed) => {
    const wrong = [
      'admin:external_providers:read',
      'admin:external_providers:write',
      'admin:external_providers:delete',
    ].filter((permission) => permission !== needed);
    expect((await send(method, path, body, wrong)).status).toBe(403);
    expect((await send(method, path, body, [needed])).status).not.toBe(403);
    expect((await send(method, path, body, [])).status).toBe(403);
  });
});

describe('list and get', () => {
  it('never returns secrets and reports which exist', async () => {
    mocks.listAll.mockResolvedValue([
      stored({
        providerQuirks: {
          privateKeyEncrypted: 'enc-key',
          inboundIdentityMapping: { graph: 1 },
          keep: true,
          dynamicClientRegistration: { enabled: true, initialAccessTokenEncrypted: 'enc-iat' },
          fapi2: {
            enabled: true,
            clientAssertionPrivateJwkEncrypted: 'enc-a',
            dpopPrivateJwkEncrypted: 'enc-d',
            clientAssertionPrivateJwk: { d: 'leak' },
            dpopPrivateJwk: { d: 'leak' },
          },
        },
      }),
      stored({ id: 'prov-2', clientSecretEncrypted: undefined, privateKeyJwkEncrypted: undefined }),
    ]);
    const response = await send('GET', '/providers');
    expect(response.status).toBe(200);
    const body = rec(await response.json());
    const [first, second] = body.providers as Array<Record<string, unknown>>;
    expect(first).toEqual({
      id: 'prov-1',
      tenantId: 'tenant-a',
      name: 'Corp',
      clientId: 'client-1',
      updatedAt: 1000,
      providerQuirks: {
        keep: true,
        dynamicClientRegistration: { enabled: true, hasInitialAccessToken: true },
        fapi2: { enabled: true, hasClientAssertionKey: true, hasDpopKey: true },
      },
      hasSecret: true,
      hasPrivateKey: true,
      hasPrivateKeyJwk: true,
    });
    expect(second).toMatchObject({
      id: 'prov-2',
      providerQuirks: {},
      hasSecret: false,
      hasPrivateKey: false,
      hasPrivateKeyJwk: false,
    });
    expect(mocks.listAll).toHaveBeenCalledWith(ENV, 'tenant-a');
  });

  it('reports absent optional secrets as absent', async () => {
    mocks.getProvider.mockResolvedValue(
      stored({
        providerQuirks: {
          dynamicClientRegistration: { enabled: true },
          fapi2: { enabled: true },
        },
      })
    );
    const body = rec(await (await send('GET', '/providers/prov-1')).json());
    expect(body.providerQuirks).toEqual({
      dynamicClientRegistration: { enabled: true, hasInitialAccessToken: false },
      fapi2: { enabled: true, hasClientAssertionKey: false, hasDpopKey: false },
    });
    mocks.getProvider.mockResolvedValue(stored({ providerQuirks: undefined }));
    expect(rec(await (await send('GET', '/providers/prov-1')).json()).providerQuirks).toEqual({});
    mocks.getProvider.mockResolvedValue(stored({ providerQuirks: 'text' }));
    expect(rec(await (await send('GET', '/providers/prov-1')).json()).providerQuirks).toEqual({});
  });

  it('returns a provider by id within the tenant, 404 when it is not there', async () => {
    expect((await send('GET', '/providers/prov-1')).status).toBe(200);
    expect(mocks.getProvider).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1');
    mocks.getProvider.mockResolvedValue(null);
    expect((await send('GET', '/providers/nope')).status).toBe(404);
  });

  it('answers 500 and logs when the store fails', async () => {
    mocks.listAll.mockRejectedValue(new Error('db'));
    expect((await send('GET', '/providers')).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith('Failed to list providers', {}, expect.any(Error));
    mocks.getProvider.mockRejectedValue(new Error('db'));
    expect((await send('GET', '/providers/prov-1')).status).toBe(500);
    expect(mocks.error).toHaveBeenLastCalledWith('Failed to get provider', {}, expect.any(Error));
  });
});

describe('delete', () => {
  it('deletes within the tenant, 404 when nothing was deleted', async () => {
    const response = await send('DELETE', '/providers/prov-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.deleteProvider).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov-1');
    mocks.deleteProvider.mockResolvedValue(false);
    expect((await send('DELETE', '/providers/prov-1')).status).toBe(404);
    mocks.deleteProvider.mockRejectedValue(new Error('db'));
    expect((await send('DELETE', '/providers/prov-1')).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith('Failed to delete provider', {}, expect.any(Error));
  });
});

describe('dynamic registration', () => {
  const diagnostics = () => ({ logAuthDecision: mocks.logAuthDecision, cleanup: mocks.cleanup });
  const register = (env: Env = ENV) =>
    send('POST', '/providers/prov-1/register', undefined, ['*'], env);

  beforeEach(() => {
    mocks.getProvider.mockResolvedValue(stored({ slug: 'corp', issuer: 'https://op.example' }));
    mocks.ensureRegistration.mockResolvedValue({
      registered: true,
      provider: stored({ clientId: 'registered-client' }),
    });
  });

  it('forces a registration at the callback URL and returns the sanitized provider', async () => {
    const response = await register();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registered: true,
      provider: { id: 'prov-1', clientId: 'registered-client', hasSecret: true },
    });
    const input = argRec(mocks.ensureRegistration);
    expect(input).toMatchObject({
      env: ENV,
      tenantId: 'tenant-a',
      callbackUri: 'https://tenant-a.example.com/auth/external/corp/callback',
      force: true,
    });
    expect(rec(input.provider).id).toBe('prov-1');
  });

  it('uses the provider id in the callback URL when it has no slug', async () => {
    mocks.getProvider.mockResolvedValue(stored());
    await register();
    expect(argRec(mocks.ensureRegistration).callbackUri).toBe(
      'https://tenant-a.example.com/auth/external/prov-1/callback'
    );
  });

  it('answers 404 for an unknown provider', async () => {
    mocks.getProvider.mockResolvedValue(null);
    expect((await register()).status).toBe(404);
    expect(mocks.ensureRegistration).not.toHaveBeenCalled();
  });

  it('records the registration in the diagnostics and cleans up', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    await register();
    expect(callArg(mocks.createDiag, 0, 1)).toEqual({ tenantId: 'tenant-a', clientId: 'client-1' });
    expect(mocks.logAuthDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      decision: 'allow',
      reason: 'dynamic_client_registration',
      flow: 'external_idp',
      context: {
        provider: 'corp',
        issuer: 'https://op.example',
        registered_client_id: 'registered-client',
      },
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('answers 502 without the failure detail, recording a denial', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    mocks.ensureRegistration.mockRejectedValue(new TypeError('connect to 10.0.0.1 refused'));
    const response = await register();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'dynamic_registration_failed',
      error_description: 'Dynamic client registration failed',
    });
    expect(mocks.logAuthDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      decision: 'deny',
      reason: 'dynamic_client_registration_failed',
      flow: 'external_idp',
      context: { error_name: 'TypeError' },
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to dynamically register provider',
      {},
      expect.any(TypeError)
    );
  });

  it('shows the failure message only in conformance mode, and names non-Error failures', async () => {
    mocks.ensureRegistration.mockRejectedValue(new Error('registration endpoint refused'));
    const conformance = { ENABLE_CONFORMANCE_MODE: 'true' } as unknown as Env;
    const response = await register(conformance);
    expect(rec(await response.json()).error_description).toBe('registration endpoint refused');
    mocks.ensureRegistration.mockRejectedValue('plain failure');
    expect(rec(await (await register(conformance)).json()).error_description).toBe('plain failure');
    mocks.createDiag.mockResolvedValue(diagnostics());
    await register();
    expect(rec(argRec(mocks.logAuthDecision).context).error_name).toBe('Error');
  });

  it('survives failing diagnostics', async () => {
    mocks.createDiag.mockResolvedValue(diagnostics());
    mocks.logAuthDecision.mockRejectedValue(new Error('diag down'));
    mocks.cleanup.mockRejectedValue(new Error('flush failed'));
    mocks.ensureRegistration.mockRejectedValue(new Error('boom'));
    expect((await register()).status).toBe(502);
  });
});
