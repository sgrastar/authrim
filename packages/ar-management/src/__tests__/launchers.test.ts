import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationLauncher } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => {
  const createAdapter = () => ({
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn(),
  });
  const adapter = createAdapter();
  const accountAdapter = createAdapter();
  return {
    adapter,
    accountAdapter,
    audit: vi.fn(),
    accountOperation: vi.fn(),
    runtimeUserFindById: vi.fn(),
    customClaimsResolve: vi.fn(),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: adapter })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: accountAdapter })),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      findById = mocked.runtimeUserFindById;
    },
    createAccountAuthContextFromHono: mocked.createAccountAuthContextFromHono,
    createAuthContextFromHono: mocked.createAuthContextFromHono,
    createAuditLogFromContext: mocked.audit,
    createCustomClaimSchemaResolverFromSources: vi.fn(() => ({
      resolveFieldValues: mocked.customClaimsResolve,
    })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocked.accountAdapter })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getLogger: vi.fn(() => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    })),
    resolveCustomClaimRuntimeSourcesFromHono: vi.fn(async () => ({})),
  };
});

vi.mock('../account-page', () => ({
  requireAccountSession: vi.fn(async () => ({ userId: 'user-1' })),
}));

vi.mock('../account-operation-log', () => ({
  recordAccountOperation: mocked.accountOperation,
}));

vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
}));

import {
  accountLauncher,
  adminLauncherCreateHandler,
  adminLauncherDeleteHandler,
  adminLauncherOrderHandler,
  adminLauncherUpdateHandler,
  buildLaunchTarget,
  getAccountLaunchersHandler,
  launchAccountLauncherHandler,
  launcherVisibleToAccount,
  setAccountLauncherFavoriteHandler,
} from '../launchers';

function launcher(
  visibility: ApplicationLauncher['visibility'],
  overrides: Partial<ApplicationLauncher> = {}
): ApplicationLauncher {
  return {
    id: 'launcher-1',
    application_type: 'standalone',
    application_id: null,
    name: 'Documentation',
    description: null,
    category: 'Knowledge',
    launch_type: 'bookmark',
    launch_url: 'https://docs.example.com/',
    deep_link_url: null,
    open_in_new_tab: true,
    icon_type: 'phosphor',
    icon_value: 'book-open',
    icon_color: '#ffffff',
    background_color: '#2563eb',
    grid_width: 2,
    sort_order: 10,
    enabled: true,
    allow_favorite: true,
    visibility,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

const baseVisibility: ApplicationLauncher['visibility'] = {
  mode: 'everyone',
  attribute_match: 'all',
  user_ids: [],
  group_ids: [],
  attribute_rules: [],
};

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_type: 'standalone',
    application_id: null,
    name: 'Documentation',
    description: null,
    category: 'Knowledge',
    launch_type: 'bookmark',
    launch_url: 'https://docs.example.com/',
    deep_link_url: null,
    open_in_new_tab: true,
    icon_type: 'phosphor',
    icon_value: 'book-open',
    icon_color: '#ffffff',
    background_color: '#2563eb',
    grid_width: 2,
    sort_order: 10,
    enabled: true,
    allow_favorite: true,
    visibility: baseVisibility,
    ...overrides,
  };
}

function adminApp(): Hono {
  const app = new Hono();
  app.post('/launchers', adminLauncherCreateHandler);
  app.put('/launchers/order', adminLauncherOrderHandler);
  app.put('/launchers/:id', adminLauncherUpdateHandler);
  app.delete('/launchers/:id', adminLauncherDeleteHandler);
  return app;
}

function accountApp(): Hono {
  const app = new Hono();
  app.get('/launchers', getAccountLaunchersHandler);
  app.get('/launchers/:id/launch', launchAccountLauncherHandler);
  app.put('/launchers/:id/favorite', setAccountLauncherFavoriteHandler);
  return app;
}

function launcherRow(value: ApplicationLauncher) {
  return {
    id: value.id,
    config_json: JSON.stringify(value),
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.adapter.query.mockResolvedValue([]);
  mocked.adapter.queryOne.mockResolvedValue(null);
  mocked.adapter.execute.mockResolvedValue({ changes: 1 });
  mocked.adapter.batch.mockResolvedValue([]);
  mocked.accountAdapter.query.mockResolvedValue([]);
  mocked.accountAdapter.queryOne.mockResolvedValue(null);
  mocked.accountAdapter.execute.mockResolvedValue({ changes: 1 });
  mocked.accountAdapter.batch.mockResolvedValue([]);
  mocked.runtimeUserFindById.mockResolvedValue(null);
  mocked.customClaimsResolve.mockResolvedValue({ claims: {}, warnings: [] });
});

describe('launcher visibility', () => {
  it('matches explicit users and tenant-resolved groups', () => {
    const audience = {
      groupIds: new Set(['group-engineering']),
      attributes: new Map<string, string[]>(),
    };
    expect(
      launcherVisibleToAccount(
        launcher({ ...baseVisibility, mode: 'users', user_ids: ['user-1'] }),
        'user-1',
        audience
      )
    ).toBe(true);
    expect(
      launcherVisibleToAccount(
        launcher({ ...baseVisibility, mode: 'groups', group_ids: ['group-other'] }),
        'user-1',
        audience
      )
    ).toBe(false);
  });

  it('supports all and any attribute rule matching', () => {
    const rules = [
      {
        id: 'department',
        attribute_key: 'department',
        operator: 'equals' as const,
        attribute_value: 'engineering',
      },
      {
        id: 'region',
        attribute_key: 'region',
        operator: 'starts_with' as const,
        attribute_value: 'jp-',
      },
    ];
    const audience = {
      groupIds: new Set<string>(),
      attributes: new Map([
        ['department', ['engineering']],
        ['region', ['us-west']],
      ]),
    };
    expect(
      launcherVisibleToAccount(
        launcher({ ...baseVisibility, mode: 'attributes', attribute_rules: rules }),
        'user-1',
        audience
      )
    ).toBe(false);
    expect(
      launcherVisibleToAccount(
        launcher({
          ...baseVisibility,
          mode: 'attributes',
          attribute_match: 'any',
          attribute_rules: rules,
        }),
        'user-1',
        audience
      )
    ).toBe(true);
  });

  it('fails closed for an empty attribute rule set', () => {
    expect(
      launcherVisibleToAccount(launcher({ ...baseVisibility, mode: 'attributes' }), 'user-1', {
        groupIds: new Set(),
        attributes: new Map(),
      })
    ).toBe(false);
  });

  it('fails closed when not_equals references a missing attribute', () => {
    expect(
      launcherVisibleToAccount(
        launcher({
          ...baseVisibility,
          mode: 'attributes',
          attribute_rules: [
            {
              id: 'department',
              attribute_key: 'department',
              operator: 'not_equals',
              attribute_value: 'engineering',
            },
          ],
        }),
        'user-1',
        { groupIds: new Set(), attributes: new Map() }
      )
    ).toBe(false);
  });
});

describe('account launcher representation', () => {
  it('omits target, application, and audience configuration', () => {
    const result = accountLauncher(
      launcher({ ...baseVisibility, mode: 'users', user_ids: ['user-1'] }),
      true
    );
    expect(result).toMatchObject({
      id: 'launcher-1',
      favorite: true,
      launch_href: '/api/account/launchers/launcher-1/launch',
    });
    expect(result).not.toHaveProperty('launch_url');
    expect(result).not.toHaveProperty('deep_link_url');
    expect(result).not.toHaveProperty('application_id');
    expect(result).not.toHaveProperty('application_type');
    expect(result).not.toHaveProperty('visibility');
  });
});

describe('admin launcher persistence', () => {
  it('rejects malformed JSON without writing', async () => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Request body must be valid JSON',
    });
    expect(mocked.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid layout values instead of silently coercing them', async () => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ grid_width: 9 })),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: expect.stringContaining('grid_width'),
    });
    expect(mocked.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects an application reference on a standalone launcher', async () => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ application_id: 'stale-client' })),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Standalone launchers must not reference an application',
    });
    expect(mocked.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['raw value', `https://sp.example.test/${'a'.repeat(80)}`],
    ['URL-normalized value', `https://sp.example.test/${'あ'.repeat(7)}`],
  ])('rejects an IdP-initiated %s that exceeds the SAML RelayState limit', async (_case, url) => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        createBody({
          application_type: 'saml_sp',
          application_id: 'saml-sp-1',
          launch_type: 'saml_idp_initiated',
          launch_url: null,
          deep_link_url: url,
        })
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: expect.stringContaining('80 UTF-8 bytes'),
    });
    expect(mocked.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects a separate deep-link URL for SP-initiated SAML', async () => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        createBody({
          application_type: 'saml_sp',
          application_id: 'saml-sp-1',
          launch_type: 'saml_sp_initiated',
          launch_url: 'https://sp.example.test/sso/start',
          deep_link_url: 'https://sp.example.test/projects/1',
        })
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: expect.stringContaining('include any application deep link in launch_url'),
    });
    expect(mocked.adapter.execute).not.toHaveBeenCalled();
  });

  it('stores launcher definitions in the tenant metadata database', async () => {
    const response = await adminApp().request('/launchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });

    expect(response.status).toBe(201);
    expect(mocked.createAuthContextFromHono).toHaveBeenCalled();
    expect(mocked.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO application_launchers'),
      expect.arrayContaining(['tenant-a'])
    );
  });

  it('reorders the complete collection in one database batch', async () => {
    const first = launcher(baseVisibility, { id: 'first', sort_order: 0 });
    const second = launcher(baseVisibility, { id: 'second', sort_order: 10 });
    mocked.adapter.query.mockResolvedValue([
      {
        id: first.id,
        config_json: JSON.stringify(first),
        created_at: first.created_at,
        updated_at: first.updated_at,
      },
      {
        id: second.id,
        config_json: JSON.stringify(second),
        created_at: second.created_at,
        updated_at: second.updated_at,
      },
    ]);

    const response = await adminApp().request('/launchers/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launcher_ids: ['second', 'first'] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      launchers: [
        { id: 'second', sort_order: 0 },
        { id: 'first', sort_order: 10 },
      ],
    });
    expect(mocked.adapter.batch).toHaveBeenCalledTimes(1);
    const statements = mocked.adapter.batch.mock.calls[0]?.[0];
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('UPDATE application_launchers');
  });

  it('rejects stale reorder requests without a partial write', async () => {
    const first = launcher(baseVisibility, { id: 'first', sort_order: 0 });
    mocked.adapter.query.mockResolvedValue([
      {
        id: first.id,
        config_json: JSON.stringify(first),
        created_at: first.created_at,
        updated_at: first.updated_at,
      },
    ]);

    const response = await adminApp().request('/launchers/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launcher_ids: [] }),
    });

    expect(response.status).toBe(409);
    expect(mocked.adapter.batch).not.toHaveBeenCalled();
  });

  it('updates an existing launcher and preserves its identity timestamps', async () => {
    const existing = launcher(baseVisibility);
    mocked.adapter.queryOne.mockResolvedValue(launcherRow(existing));

    const response = await adminApp().request(`/launchers/${existing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated documentation' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      launcher: {
        id: existing.id,
        name: 'Updated documentation',
        created_at: existing.created_at,
      },
    });
    expect(mocked.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE application_launchers'),
      expect.arrayContaining(['tenant-a', existing.id])
    );
  });

  it('clears the application reference when a linked launcher becomes standalone', async () => {
    const existing = launcher(baseVisibility, {
      application_type: 'oidc_client',
      application_id: 'client-1',
    });
    mocked.adapter.queryOne.mockResolvedValue(launcherRow(existing));

    const response = await adminApp().request(`/launchers/${existing.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        application_type: 'standalone',
        launch_type: 'bookmark',
        launch_url: 'https://docs.example.test/',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      launcher: {
        application_type: 'standalone',
        application_id: null,
      },
    });
  });

  it('deletes an existing launcher definition', async () => {
    const existing = launcher(baseVisibility);
    mocked.adapter.queryOne.mockResolvedValue(launcherRow(existing));

    const response = await adminApp().request(`/launchers/${existing.id}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    expect(mocked.adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM application_launchers WHERE tenant_id = ? AND id = ?',
      ['tenant-a', existing.id]
    );
  });
});

describe('launcher targets', () => {
  it('forwards an IdP-initiated deep link as RelayState', async () => {
    mocked.adapter.queryOne.mockResolvedValue({
      config_json: JSON.stringify({ entityId: 'https://sp.example.test' }),
    });
    const app = new Hono();
    app.get('/target', async (c) => {
      const target = await buildLaunchTarget(
        c as never,
        launcher(baseVisibility, {
          application_type: 'saml_sp',
          application_id: 'saml-sp-1',
          launch_type: 'saml_idp_initiated',
          launch_url: null,
          deep_link_url: 'https://sp.example.test/home',
        })
      );
      return c.json({ target });
    });

    const response = await app.request('/target');
    await expect(response.json()).resolves.toEqual({
      target:
        'https://tenant.example.test/saml/idp/init?sp=https%3A%2F%2Fsp.example.test&relay_state=https%3A%2F%2Fsp.example.test%2Fhome',
    });
  });

  it('always starts SP-initiated SAML at the configured SP URL', async () => {
    mocked.adapter.queryOne.mockResolvedValue({
      config_json: JSON.stringify({ entityId: 'https://sp.example.test' }),
    });
    const app = new Hono();
    app.get('/target', async (c) => {
      const target = await buildLaunchTarget(
        c as never,
        launcher(baseVisibility, {
          application_type: 'saml_sp',
          application_id: 'saml-sp-1',
          launch_type: 'saml_sp_initiated',
          launch_url: 'https://sp.example.test/sso/start?destination=projects',
          deep_link_url: 'https://sp.example.test/projects/1',
        })
      );
      return c.json({ target });
    });

    const response = await app.request('/target');
    await expect(response.json()).resolves.toEqual({
      target: 'https://sp.example.test/sso/start?destination=projects',
    });
  });

  it('adds the issuer and target link to OIDC third-party initiated login', async () => {
    mocked.adapter.queryOne.mockResolvedValue({
      initiate_login_uri: 'https://client.example.test/initiate',
    });
    const app = new Hono();
    app.get('/target', async (c) => {
      const target = await buildLaunchTarget(
        c as never,
        launcher(baseVisibility, {
          application_type: 'oidc_client',
          application_id: 'client-1',
          launch_type: 'oidc_third_party_initiated',
          launch_url: 'https://client.example.test/initiate',
          deep_link_url: 'https://client.example.test/projects/1',
        })
      );
      return c.json({ target });
    });

    const response = await app.request('/target');
    await expect(response.json()).resolves.toEqual({
      target:
        'https://client.example.test/initiate?iss=https%3A%2F%2Ftenant.example.test&target_link_uri=https%3A%2F%2Fclient.example.test%2Fprojects%2F1',
    });
  });
});

describe('account launcher handlers', () => {
  it('hides unavailable linked applications and removes stale or disallowed favorites', async () => {
    const available = launcher(baseVisibility, { id: 'available' });
    const favoriteDisabled = launcher(baseVisibility, {
      id: 'favorite-disabled',
      allow_favorite: false,
    });
    const unavailable = launcher(baseVisibility, {
      id: 'unavailable',
      application_type: 'oidc_client',
      application_id: 'deleted-client',
    });
    mocked.adapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM application_launchers')) {
        return [available, favoriteDisabled, unavailable].map(launcherRow);
      }
      if (sql.includes('FROM oauth_clients')) return [];
      return [];
    });
    mocked.accountAdapter.query.mockResolvedValue([
      { launcher_id: available.id },
      { launcher_id: favoriteDisabled.id },
      { launcher_id: 'deleted-launcher' },
    ]);

    const response = await accountApp().request('/launchers');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      launchers: [
        expect.objectContaining({ id: available.id, favorite: true }),
        expect.objectContaining({ id: favoriteDisabled.id, favorite: false }),
      ],
    });
    expect(mocked.accountAdapter.batch).toHaveBeenCalledTimes(1);
    const cleanup = mocked.accountAdapter.batch.mock.calls[0]?.[0];
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].sql).toContain('DELETE FROM launcher_favorites');
    expect(cleanup[0].params).toEqual(
      expect.arrayContaining([favoriteDisabled.id, 'deleted-launcher'])
    );
  });

  it('returns multiple launchers that reference the same OIDC application', async () => {
    const first = launcher(baseVisibility, {
      id: 'client-home',
      application_type: 'oidc_client',
      application_id: 'client-1',
      launch_type: 'oidc_third_party_initiated',
      launch_url: 'https://client.example.test/initiate',
      deep_link_url: 'https://client.example.test/home',
    });
    const second = launcher(baseVisibility, {
      id: 'client-projects',
      application_type: 'oidc_client',
      application_id: 'client-1',
      launch_type: 'oidc_third_party_initiated',
      launch_url: 'https://client.example.test/initiate',
      deep_link_url: 'https://client.example.test/projects',
    });
    mocked.adapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM application_launchers')) return [first, second].map(launcherRow);
      if (sql.includes('FROM oauth_clients')) {
        return [
          {
            client_id: 'client-1',
            initiate_login_uri: 'https://client.example.test/initiate',
          },
        ];
      }
      return [];
    });

    const response = await accountApp().request('/launchers');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      launchers: [{ id: first.id }, { id: second.id }],
    });
    const clientLookup = mocked.adapter.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM oauth_clients')
    );
    expect(clientLookup?.[1]).toEqual(['tenant-a', 'client-1']);
  });

  it('resolves standard, custom, and verified attributes before listing launchers', async () => {
    const visible = launcher({
      ...baseVisibility,
      mode: 'attributes',
      attribute_match: 'all',
      attribute_rules: [
        {
          id: 'email',
          attribute_key: 'email',
          operator: 'equals',
          attribute_value: 'user@example.test',
        },
        {
          id: 'department',
          attribute_key: 'department',
          operator: 'equals',
          attribute_value: 'engineering',
        },
        {
          id: 'verified-country',
          attribute_key: 'verified.country',
          operator: 'equals',
          attribute_value: 'JP',
        },
      ],
    });
    mocked.adapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM application_launchers') ? [launcherRow(visible)] : []
    );
    mocked.accountAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('user_verified_attributes')) {
        return [{ attribute_name: 'country', attribute_value: 'JP' }];
      }
      return [];
    });
    mocked.runtimeUserFindById.mockResolvedValue({
      email: 'user@example.test',
      email_verified: 1,
      name: 'Example User',
      given_name: 'Example',
      family_name: 'User',
      locale: 'ja',
    });
    mocked.customClaimsResolve.mockResolvedValue({
      claims: { department: 'engineering' },
      warnings: [],
    });

    const response = await accountApp().request('/launchers');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      launchers: [{ id: visible.id }],
    });
    expect(mocked.customClaimsResolve).toHaveBeenCalledWith('tenant-a', 'user-1', ['department']);
  });

  it('does not allow a launcher with favorites disabled to be favorited', async () => {
    const definition = launcher(baseVisibility, { allow_favorite: false });
    mocked.adapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM application_launchers') ? [launcherRow(definition)] : []
    );

    const response = await accountApp().request(`/launchers/${definition.id}/favorite`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ favorite: true }),
    });

    expect(response.status).toBe(403);
    expect(mocked.accountAdapter.execute).not.toHaveBeenCalled();
  });

  it('launches a visible bookmark and records the account operation', async () => {
    const definition = launcher(baseVisibility);
    mocked.adapter.query.mockImplementation(async (sql: string) =>
      sql.includes('FROM application_launchers') ? [launcherRow(definition)] : []
    );

    const response = await accountApp().request(`/launchers/${definition.id}/launch`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(definition.launch_url);
    expect(mocked.accountOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        action: 'account.launcher.launched',
        resourceId: definition.id,
      })
    );
  });
});
