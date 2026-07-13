import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), execute: vi.fn() },
  generate: vi.fn(),
  oidcAudience: vi.fn(),
  samlAudience: vi.fn(),
  secret: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
}));

vi.mock('@authrim/ar-lib-core/services/persistent-identifiers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/services/persistent-identifiers')>()),
  generatePersistentIdentifier: mocks.generate,
  resolveOIDCPairwiseAudience: mocks.oidcAudience,
  resolveSAMLPersistentIdentifierAudience: mocks.samlAudience,
}));

import {
  adminPersistentIdentifierPreviewHandler,
  adminPersistentIdentifierProfileCreateHandler,
  adminPersistentIdentifierProfileDeleteHandler,
  adminPersistentIdentifierProfileGetHandler,
  adminPersistentIdentifierProfilesListHandler,
  adminPersistentIdentifierProfileUpdateHandler,
} from '../persistent-identifier-profiles';

function context(
  options: { profileId?: string; body?: unknown; bodyError?: boolean } = {}
) {
  const stub = { getOrCreateSecretRpc: mocks.secret };
  return {
    req: {
      param: vi.fn(() => options.profileId),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      KEY_MANAGER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => stub),
      },
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1', tenant_id: 'tenant-a', profile_key: 'pairwise', display_name: 'Pairwise',
    description: null, mode: 'computed', algorithm: 'authrim_sha256_base64url',
    protocol_scope: 'oidc', usage_json: '["oidc","oidc",1]', source_ref_json: '{}',
    secret_ref: 'tenant:tenant-a:oidc:pairwise-sub', issuer_entity_id: null,
    audience_mode: 'runtime', format_json: '{}', lifecycle_state: 'active',
    created_at: 100, updated_at: 200, ...overrides,
  };
}

describe('persistent identifier profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.generate.mockResolvedValue('opaque-subject');
    mocks.oidcAudience.mockReturnValue('oidc-audience');
    mocks.samlAudience.mockReturnValue('saml-audience');
    mocks.secret.mockResolvedValue({ active: { value: 'secret-material' } });
  });

  it('lists profiles with safe JSON normalization', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      profile(),
      profile({
        id: 'profile-2', usage_json: '{', source_ref_json: '[]', format_json: '{',
      }),
    ]);
    const body = (await (await adminPersistentIdentifierProfilesListHandler(context())).json()) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(body.profiles).toEqual([
      expect.objectContaining({ usage: ['oidc'], sourceRef: {}, format: {} }),
      expect.objectContaining({ usage: [], sourceRef: null, format: {} }),
    ]);
  });

  it.each([undefined, 'missing', 'profile-1'])('gets profile id=%s', async (profileId) => {
    if (profileId === 'profile-1') mocks.adapter.query.mockResolvedValueOnce([profile()]);
    const response = await adminPersistentIdentifierProfileGetHandler(context({ profileId }));
    expect(response.status).toBe(profileId === 'profile-1' ? 200 : 404);
  });

  it.each([
    [[], 'Request body must be an object'],
    [{}, 'displayName is required'],
    [{ displayName: 'Profile', profileKey: ' invalid key ' }, 'profileKey is invalid'],
  ])('validates profile create %#', async (body, message) => {
    const response = await adminPersistentIdentifierProfileCreateHandler(context({ body }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
  });

  it('rejects malformed JSON request', async () => {
    expect((await adminPersistentIdentifierProfileCreateHandler(context({ bodyError: true }))).status).toBe(400);
  });

  it.each([
    [{ displayName: 'Default Pairwise' }, 'default_pairwise', 'authrim_sha256_base64url', 'any'],
    [
      {
        displayName: 'SAML Pairwise', profileKey: 'saml:pairwise', description: 'Description',
        mode: 'computed', algorithm: 'shibboleth_sha1_base64', protocolScope: 'saml',
        usage: ['saml', 'saml', 1], sourceRef: { source: 'subject' }, secretRef: 'custom-secret',
        issuerEntityId: 'https://idp.example', audienceMode: 'saml_sp_entity_id',
        format: { separator: '!' }, lifecycleState: 'draft',
      },
      'saml:pairwise',
      'shibboleth_sha1_base64',
      'saml',
    ],
    [
      { displayName: 'Fallbacks', mode: 'bad', algorithm: 'bad', protocolScope: 'bad', audienceMode: 'bad' },
      'fallbacks',
      'authrim_sha256_base64url',
      'any',
    ],
  ])('creates normalized profile %#', async (body, profileKey, algorithm, protocolScope) => {
    const response = await adminPersistentIdentifierProfileCreateHandler(context({ body }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      result: { profileKey, algorithm, protocolScope },
    });
    expect(mocks.secret).toHaveBeenCalled();
  });

  it.each([
    [new Error('UNIQUE constraint failed'), 409],
    [new Error('D1 unavailable'), 500],
    ['failure', 500],
  ])('maps create write error %#', async (error, status) => {
    mocks.adapter.execute.mockRejectedValueOnce(error);
    expect(
      (await adminPersistentIdentifierProfileCreateHandler(context({ body: { displayName: 'Profile' } }))).status
    ).toBe(status);
  });

  it('requires profile ID for update and validates update body', async () => {
    expect((await adminPersistentIdentifierProfileUpdateHandler(context({ body: { displayName: 'P' } }))).status).toBe(400);
    expect(
      (await adminPersistentIdentifierProfileUpdateHandler(context({ profileId: 'profile-1', body: {} }))).status
    ).toBe(400);
  });

  it.each([false, true])('updates profile and handles missing result=%s', async (exists) => {
    if (exists) mocks.adapter.query.mockResolvedValueOnce([profile({ display_name: 'Updated' })]);
    const response = await adminPersistentIdentifierProfileUpdateHandler(
      context({ profileId: 'profile-1', body: { displayName: 'Updated', protocolScope: 'oidc' } })
    );
    expect(response.status).toBe(exists ? 200 : 404);
    expect(mocks.adapter.execute).toHaveBeenCalled();
  });

  it('maps update write failures', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('duplicate key'));
    expect(
      (
        await adminPersistentIdentifierProfileUpdateHandler(
          context({ profileId: 'profile-1', body: { displayName: 'Updated' } })
        )
      ).status
    ).toBe(409);
  });

  it('blocks deletion while active mapping versions reference the exact profile', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      {
        field_mapping_set_id: 'set-1', version_id: 'version-1', lifecycle_state: 'active',
        transform_id: 'transform-1', parameters_json: '{"persistentIdentifierProfileId":"profile-1"}',
      },
      {
        field_mapping_set_id: 'set-2', version_id: 'version-2', lifecycle_state: 'active',
        transform_id: 'transform-2', parameters_json: '{"persistentIdentifierProfileId":"other"}',
      },
      { parameters_json: '{' },
    ]);
    const response = await adminPersistentIdentifierProfileDeleteHandler(context({ profileId: 'profile-1' }));
    expect(response.status).toBe(409);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, 'profile-1'])('deletes unreferenced profile id=%s', async (profileId) => {
    const response = await adminPersistentIdentifierProfileDeleteHandler(context({ profileId }));
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.any(String), ['tenant-a', profileId]);
  });

  it.each([
    [null, 400],
    [{}, 400],
    [{ profileId: 'profile-1' }, 400],
    [{ profileId: 'profile-1', subject: 'user-1', audience: 'client-1' }, 404],
  ])('validates preview input %#', async (body, status) => {
    expect((await adminPersistentIdentifierPreviewHandler(context({ body }))).status).toBe(status);
  });

  it.each([
    [profile({ mode: 'stored', algorithm: 'stored' })],
    [profile({ mode: 'computed', algorithm: 'imported' })],
  ])('does not preview non-computed profile %#', async (row) => {
    mocks.adapter.query.mockResolvedValueOnce([row]);
    expect(
      (
        await adminPersistentIdentifierPreviewHandler(
          context({ body: { profileId: 'profile-1', subject: 'user-1', audience: 'client-1' } })
        )
      ).status
    ).toBe(400);
  });

  it.each([
    [profile({ secret_ref: null }), 'secretRef is not configured'],
    [profile(), 'secretRef is not available'],
  ])('reports preview secret problem %#', async (row, message) => {
    mocks.adapter.query.mockResolvedValueOnce([row]);
    if (row.secret_ref) mocks.secret.mockResolvedValueOnce({ active: { value: '' } });
    const response = await adminPersistentIdentifierPreviewHandler(
      context({ body: { profileId: 'profile-1', subject: 'user-1', audience: 'client-1' } })
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
  });

  it.each([
    [profile(), false],
    [profile({ protocol_scope: 'saml', issuer_entity_id: 'https://idp.example' }), true],
    [profile({ algorithm: 'shibboleth_sha1_base64' }), true],
    [profile({ audience_mode: 'saml_sp_entity_id' }), true],
  ])('previews profile with SAML audience=%s', async (row, saml) => {
    mocks.adapter.query.mockResolvedValueOnce([row]);
    const response = await adminPersistentIdentifierPreviewHandler(
      context({
        body: {
          profileId: 'profile-1', subject: ' user-1 ', audience: ' client-1 ',
          issuerEntityId: 'https://override-idp.example',
        },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      result: {
        opaque: 'opaque-subject',
        secretMaterialIncluded: false,
        samlAttributeValue: expect.any(String),
      },
    });
    expect(saml ? mocks.samlAudience : mocks.oidcAudience).toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ secret: 'secret-material' }));
  });

  it('returns null SAML attribute without issuer and maps generator failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([profile()]);
    const first = await adminPersistentIdentifierPreviewHandler(
      context({ body: { profileId: 'profile-1', subject: 'u', audience: 'c' } })
    );
    await expect(first.json()).resolves.toMatchObject({ result: { samlAttributeValue: null } });

    mocks.adapter.query.mockResolvedValueOnce([profile()]);
    mocks.generate.mockRejectedValueOnce('failure');
    const second = await adminPersistentIdentifierPreviewHandler(
      context({ body: { profileId: 'profile-1', subject: 'u', audience: 'c' } })
    );
    expect(second.status).toBe(400);
    expect(JSON.stringify(await second.json())).toContain('Request failed');
  });
});
