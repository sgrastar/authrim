/**
 * An SP's minimum IAL (`minimumIal`) as the Admin API takes it: IAL1 to IAL3 sets it, null removes
 * it, absent leaves it, and anything else is refused (an empty string is refused too, so a stray
 * empty value can never remove the minimum). It is kept through metadata refresh and an update that
 * does not mention it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async (_env: unknown, _entry: { action: string; metadata?: string }) => undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      fieldMappingSetId: 'saml-sp',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => ({
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }],
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import { getSPConfig, handleCreateProvider, handleUpdateProvider } from '../providers';

function createAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
}

function context(options: { body?: unknown; id?: string } = {}) {
  return {
    env: {},
    req: {
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => (name === 'id' ? options.id : undefined)),
      header: vi.fn((name: string) =>
        options.body !== undefined && name.toLowerCase() === 'content-type'
          ? 'application/json'
          : undefined
      ),
    },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return 'tenant-a';
      if (name === 'adminAuth') return { permissions: Object.values(ADMIN_PERMISSIONS) };
      return undefined;
    }),
    json: vi.fn(
      (body: unknown, status: number = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as never;
}

const IDENTITY_MAPPING = {
  fieldMappingSetId: 'saml-sp',
  destinationFieldPolicies: { mail: 'optional' },
};

function createBody(config: Record<string, unknown> = {}, providerType = 'saml_sp') {
  return {
    name: 'Provider',
    providerType,
    config: {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      identityMapping: IDENTITY_MAPPING,
      ...config,
    },
  };
}

function providerRow(config: Record<string, unknown> = {}) {
  return {
    id: 'provider-a',
    name: 'Provider A',
    provider_type: 'saml_sp',
    config_json: JSON.stringify({
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      allowedBindings: ['post'],
      identityMapping: IDENTITY_MAPPING,
      ...config,
    }),
    enabled: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
  };
}

/** The config_json of the provider row the last write stored. */
function stored(): Record<string, unknown> {
  const calls = mocks.adapter!.execute.mock.calls;
  const call = calls[calls.length - 1];
  const sql = String(call[0]);
  const parameters = call[1] as unknown[];
  return JSON.parse(String(parameters[sql.startsWith('UPDATE') ? 1 : 4])) as Record<
    string,
    unknown
  >;
}

async function update(config: Record<string, unknown>, existing = {}) {
  mocks.adapter!.queryOne.mockResolvedValue(providerRow(existing));
  return handleUpdateProvider(
    context({
      id: 'provider-a',
      body: { expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(), config },
    })
  );
}

describe('an SP minimum IAL in the SAML provider Admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
  });

  describe('create', () => {
    it.each(['IAL1', 'IAL2', 'IAL3'])('stores and returns %s', async (level) => {
      const response = await handleCreateProvider(
        context({ body: createBody({ minimumIal: level }) })
      );
      expect(response.status).toBe(201);
      expect(stored().minimumIal).toBe(level);
      const body: { config: { minimumIal?: string } } = await response.json();
      expect(body.config.minimumIal).toBe(level);
    });

    it('stores nothing when no minimum is given, and drops a null', async () => {
      await handleCreateProvider(context({ body: createBody() }));
      expect(stored()).not.toHaveProperty('minimumIal');
      mocks.adapter!.execute.mockClear();
      await handleCreateProvider(context({ body: createBody({ minimumIal: null }) }));
      expect(stored()).not.toHaveProperty('minimumIal');
    });

    it.each([['IAL4'], ['ial2'], [''], [' IAL2'], [2], [true], [['IAL2']], [{}]])(
      'refuses %j and writes nothing',
      async (value) => {
        const response = await handleCreateProvider(
          context({ body: createBody({ minimumIal: value }) })
        );
        expect(response.status).toBe(400);
        expect(mocks.adapter!.execute).not.toHaveBeenCalled();
      }
    );

    it('refuses a minimum on an IdP, where nothing would apply it', async () => {
      const response = await handleCreateProvider(
        context({
          body: {
            name: 'IdP',
            providerType: 'saml_idp',
            config: {
              entityId: 'https://idp.example.test',
              ssoUrl: 'https://idp.example.test/sso',
              certificate: 'cert',
              identityMapping: { fieldMappingSetId: 'saml-idp' },
              minimumIal: 'IAL2',
            },
          },
        })
      );
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('sets a minimum', async () => {
      const response = await update({ minimumIal: 'IAL2' });
      expect(response.status).toBe(200);
      expect(stored().minimumIal).toBe('IAL2');
    });

    it('changes a minimum', async () => {
      await update({ minimumIal: 'IAL3' }, { minimumIal: 'IAL2' });
      expect(stored().minimumIal).toBe('IAL3');
    });

    it('keeps the minimum when the update does not mention it', async () => {
      const response = await update(
        { acsUrl: 'https://sp.example.test/new-acs' },
        { minimumIal: 'IAL2' }
      );
      expect(response.status).toBe(200);
      expect(stored().minimumIal).toBe('IAL2');
    });

    it('removes it only with null', async () => {
      const response = await update({ minimumIal: null }, { minimumIal: 'IAL2' });
      expect(response.status).toBe(200);
      expect(stored()).not.toHaveProperty('minimumIal');
    });

    it('refuses an empty string, which would remove the minimum by accident', async () => {
      const response = await update({ minimumIal: '' }, { minimumIal: 'IAL2' });
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('refuses an unknown level without touching the stored one', async () => {
      const response = await update({ minimumIal: 'IAL9' }, { minimumIal: 'IAL2' });
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('does not let a stored value that is not a level through as "no minimum"', async () => {
      // A hand-edited row: an update of something else must not launder it into no minimum.
      const response = await update(
        { acsUrl: 'https://sp.example.test/new-acs' },
        { minimumIal: 'bogus' }
      );
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });
  });

  it('audits a change of the minimum with the old and new level, and only a change', async () => {
    await update({ minimumIal: 'IAL3' }, { minimumIal: 'IAL2' });
    const metadata = (action: string) =>
      JSON.parse(
        mocks.audit.mock.calls.find(([, entry]) => entry.action === action)?.[1].metadata ?? '{}'
      ) as Record<string, unknown>;
    expect(metadata('saml.provider.updated')).toMatchObject({
      minimum_ial_changed: true,
      previous_minimum_ial: 'IAL2',
      next_minimum_ial: 'IAL3',
    });

    mocks.audit.mockClear();
    await update({ acsUrl: 'https://sp.example.test/new-acs' }, { minimumIal: 'IAL2' });
    expect(metadata('saml.provider.updated')).not.toHaveProperty('minimum_ial_changed');

    mocks.audit.mockClear();
    await handleCreateProvider(context({ body: createBody({ minimumIal: 'IAL2' }) }));
    expect(metadata('saml.provider.created')).toMatchObject({ minimum_ial: 'IAL2' });
  });

  it('hands the stored minimum to the SSO flows with the SP config', async () => {
    mocks.adapter!.query.mockResolvedValue([
      {
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          signResponses: true,
          signAssertions: false,
          minimumIal: 'IAL2',
        }),
        enabled: 1,
      },
    ]);
    const config = await getSPConfig({} as never, 'tenant-a', 'https://sp.example.test');
    expect(config?.minimumIal).toBe('IAL2');
  });
});
