import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addFail,
  addPass,
  addWarn,
  createTemporaryInitialAccessToken,
  deleteTemporarySmokeClient,
  ensureTemporaryDcrEnabled,
  fetchJsonWithTimeout,
  finalizeCheck,
  getTenantDcrSettings,
  isRecord,
  isSmokeSuccessful,
  makeSmokeCheck,
  patchTenantDcrSettings,
  readGeneratedAdminApiSecret,
  registerTemporarySmokeClient,
  restoreTemporaryDcrEnabled,
  revokeTemporaryInitialAccessToken,
  resolveSmokeClientRegistrationDefaults,
  withTenantHeader,
} from '../core/generated-smoke-common.js';

function response(status: number, payload: unknown, contentType = 'application/json') {
  const body =
    status === 204 ? null : typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('generated smoke common contracts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maintains smoke check severity and success semantics', () => {
    const check = makeSmokeCheck('id', 'title', 'https://example.test');
    addPass(check, 'pass');
    addWarn(check, 'warn');
    addFail(check, 'fail');
    addWarn(check, 'still failed');

    expect(check).toMatchObject({
      status: 'fail',
      details: ['pass', 'warn', 'fail', 'still failed'],
    });
    expect(finalizeCheck(makeSmokeCheck('empty', 'empty'), 'fallback').details).toEqual([
      'fallback',
    ]);
    expect(isSmokeSuccessful([makeSmokeCheck('ok', 'ok')])).toBe(true);
    expect(isSmokeSuccessful([check])).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it('normalizes client defaults and adds tenant headers only when requested', () => {
    expect(
      resolveSmokeClientRegistrationDefaults({
        oidc: { grantTypes: ['client_credentials', '', 1], responseTypes: [] },
      } as never)
    ).toEqual({
      grantTypes: ['client_credentials'],
      responseTypes: ['code'],
      supportsClientCredentials: true,
    });
    expect(withTenantHeader({ accept: 'application/json' }, 'tenant-a')).toEqual({
      accept: 'application/json',
      'X-Tenant-Id': 'tenant-a',
    });
    expect(withTenantHeader({ accept: 'application/json' })).toEqual({
      accept: 'application/json',
    });
  });

  it('captures JSON, non-JSON, malformed JSON, and transport failures', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(response(200, 'plain text', 'text/plain'))
      .mockResolvedValueOnce(response(502, '{bad json'))
      .mockRejectedValueOnce(new Error('offline'));

    expect(await fetchJsonWithTimeout('https://example.test/json', 100)).toMatchObject({
      ok: true,
      payload: { ok: true },
    });
    expect(await fetchJsonWithTimeout('https://example.test/text', 100)).toMatchObject({
      ok: true,
      bodyText: 'plain text',
      payload: undefined,
    });
    expect(await fetchJsonWithTimeout('https://example.test/bad', 100)).toMatchObject({
      ok: false,
      status: 502,
      error: expect.any(String),
    });
    expect(await fetchJsonWithTimeout('https://example.test/offline', 100)).toMatchObject({
      ok: false,
      status: 0,
      error: 'offline',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reads inline and file-backed admin secrets and rejects empty files', async () => {
    expect(
      await readGeneratedAdminApiSecret({ baseDir: '/tmp', env: 'test', adminSecret: ' token ' })
    ).toEqual({ secret: 'token', path: '(inline)' });

    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await mkdtemp('/tmp/authrim-smoke-secret-');
    const path = join(dir, 'secret.txt');
    await writeFile(path, ' file-token\n');
    await expect(
      readGeneratedAdminApiSecret({ baseDir: dir, env: 'test', adminSecretPath: path })
    ).resolves.toEqual({ secret: 'file-token', path });
    await writeFile(path, '  ');
    await expect(
      readGeneratedAdminApiSecret({ baseDir: dir, env: 'test', adminSecretPath: path })
    ).rejects.toThrow(`admin_access_token_empty:${path}`);
    await expect(readGeneratedAdminApiSecret({ baseDir: dir, env: 'test' })).rejects.toThrow(
      'validation_machine_access_requires_base_url_and_config'
    );
  });

  it('gets, patches, enables, and restores tenant DCR settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          version: 'v1',
          values: { 'dcr.enabled': false },
          sources: { 'dcr.enabled': 'kv', other: 42 },
        })
      )
      .mockResolvedValueOnce(
        response(200, { version: 'v2', applied: ['dcr.enabled'], rejected: {} })
      )
      .mockResolvedValueOnce(
        response(200, {
          version: 'v2',
          values: { 'dcr.enabled': true },
          sources: { 'dcr.enabled': 'kv' },
        })
      )
      .mockResolvedValueOnce(
        response(200, { version: 'v3', applied: ['dcr.enabled'], rejected: {} })
      );
    const options = {
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      adminSecret: 'secret',
      tenantId: 'tenant/a',
    };

    const state = await ensureTemporaryDcrEnabled(options);
    expect(state).toEqual({ changed: true, originalSource: 'kv' });
    expect(await restoreTemporaryDcrEnabled({ ...options, state })).toMatchObject({
      ok: true,
      payload: { restored: true },
    });
    const patchBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patchBodies).toEqual([
      { ifMatch: 'v1', set: { 'dcr.enabled': true } },
      { ifMatch: 'v2', set: { 'dcr.enabled': false } },
    ]);
  });

  it('handles already-enabled DCR and rejects environment-locked settings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(
      response(200, {
        version: 'v1',
        values: { 'dcr.enabled': true },
        sources: { 'dcr.enabled': 'env' },
      })
    );
    const options = {
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      adminSecret: 'secret',
      tenantId: 'tenant',
    };
    expect(await ensureTemporaryDcrEnabled(options)).toEqual({
      changed: false,
      originalSource: 'env',
    });
    expect(
      await restoreTemporaryDcrEnabled({
        ...options,
        state: { changed: false, originalSource: 'env' },
      })
    ).toMatchObject({ payload: { skipped: true } });

    fetchMock.mockResolvedValueOnce(
      response(200, {
        version: 'v2',
        values: { 'dcr.enabled': false },
        sources: { 'dcr.enabled': 'env' },
      })
    );
    await expect(ensureTemporaryDcrEnabled(options)).rejects.toThrow(
      'smoke_dcr_settings_env_locked'
    );
  });

  it('validates malformed DCR responses and rejected changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const options = {
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      adminSecret: 'secret',
      tenantId: 'tenant',
    };
    fetchMock.mockResolvedValueOnce(response(200, { version: '', values: {}, sources: {} }));
    await expect(getTenantDcrSettings(options)).rejects.toThrow(
      'smoke_dcr_settings_get_response_invalid'
    );
    fetchMock.mockResolvedValueOnce(response(500, { error: 'failed' }));
    await expect(patchTenantDcrSettings({ ...options, ifMatch: 'v1' })).rejects.toThrow(
      'smoke_dcr_settings_patch_failed'
    );
    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          version: 'v1',
          values: { 'dcr.enabled': false },
          sources: { 'dcr.enabled': 'kv' },
        })
      )
      .mockResolvedValueOnce(
        response(200, { version: 'v2', applied: [], rejected: { 'dcr.enabled': 'denied' } })
      );
    await expect(ensureTemporaryDcrEnabled(options)).rejects.toThrow(
      'smoke_dcr_settings_enable_rejected:denied'
    );
  });

  it('creates and revokes IATs and registers and deletes a temporary client', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(201, { token: 'iat-token', tokenHash: 'hash/value' }))
      .mockResolvedValueOnce(response(204, ''))
      .mockResolvedValueOnce(
        response(201, {
          client_id: 'client-id',
          client_secret: 'client-secret',
          registration_access_token: 'registration-token',
          registration_client_uri: 'https://issuer.test/register/client-id',
        })
      )
      .mockResolvedValueOnce(response(204, ''));

    const iat = await createTemporaryInitialAccessToken({
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      adminSecret: 'secret',
      tenantId: 'tenant',
      description: 'test IAT',
    });
    expect(iat).toEqual({ token: 'iat-token', tokenHash: 'hash/value' });
    await revokeTemporaryInitialAccessToken({
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      adminSecret: 'secret',
      tokenHash: iat.tokenHash,
    });
    const client = await registerTemporarySmokeClient({
      baseUrl: 'https://issuer.test',
      timeoutMs: 100,
      tenantId: 'tenant',
      initialAccessToken: iat.token,
    });
    expect(client).toMatchObject({
      clientId: 'client-id',
      redirectUri: expect.stringContaining('callback'),
    });
    await deleteTemporarySmokeClient(client, 100);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://issuer.test/api/admin/iat-tokens/hash%2Fvalue'
    );
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
      authorization: 'Bearer registration-token',
    });
  });

  it('rejects incomplete IAT and client registration responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(201, { token: 'only-token' }))
      .mockResolvedValueOnce(response(400, { error: 'invalid_client_metadata' }));
    await expect(
      createTemporaryInitialAccessToken({
        baseUrl: 'https://issuer.test',
        timeoutMs: 100,
        adminSecret: 'secret',
      })
    ).rejects.toThrow('smoke_iat_create_response_invalid');
    await expect(
      registerTemporarySmokeClient({ baseUrl: 'https://issuer.test', timeoutMs: 100 })
    ).rejects.toThrow('smoke_client_register_failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
