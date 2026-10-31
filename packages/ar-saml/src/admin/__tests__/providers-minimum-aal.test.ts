/**
 * An SP's minimum AAL (`minimumAal`) and AuthnContextClassRef mode (`authnContextClassRefMode`) as the Admin API takes it: AAL1 to AAL3 sets it, null removes
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

describe('an SP minimum AAL in the SAML provider Admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
  });

  describe('create', () => {
    it.each(['AAL1', 'AAL2', 'AAL3'])('stores and returns %s', async (level) => {
      const response = await handleCreateProvider(
        context({ body: createBody({ minimumAal: level }) })
      );
      expect(response.status).toBe(201);
      expect(stored().minimumAal).toBe(level);
      const body: { config: { minimumAal?: string } } = await response.json();
      expect(body.config.minimumAal).toBe(level);
    });

    it('stores nothing when no minimum is given, and drops a null', async () => {
      await handleCreateProvider(context({ body: createBody() }));
      expect(stored()).not.toHaveProperty('minimumAal');
      mocks.adapter!.execute.mockClear();
      await handleCreateProvider(context({ body: createBody({ minimumAal: null }) }));
      expect(stored()).not.toHaveProperty('minimumAal');
    });

    it.each([
      ['AAL4'],
      ['aal2'],
      [''],
      [' AAL2'],
      ['AAL0'],
      ['IAL2'],
      [2],
      [true],
      [['AAL2']],
      [{}],
    ])('refuses %j and writes nothing', async (value) => {
      const response = await handleCreateProvider(
        context({ body: createBody({ minimumAal: value }) })
      );
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

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
              minimumAal: 'AAL2',
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
      const response = await update({ minimumAal: 'AAL2' });
      expect(response.status).toBe(200);
      expect(stored().minimumAal).toBe('AAL2');
    });

    it('changes a minimum', async () => {
      await update({ minimumAal: 'AAL3' }, { minimumAal: 'AAL2' });
      expect(stored().minimumAal).toBe('AAL3');
    });

    it('keeps the minimum when the update does not mention it', async () => {
      const response = await update(
        { acsUrl: 'https://sp.example.test/new-acs' },
        { minimumAal: 'AAL2' }
      );
      expect(response.status).toBe(200);
      expect(stored().minimumAal).toBe('AAL2');
    });

    it('removes it only with null', async () => {
      const response = await update({ minimumAal: null }, { minimumAal: 'AAL2' });
      expect(response.status).toBe(200);
      expect(stored()).not.toHaveProperty('minimumAal');
    });

    it('refuses an empty string, which would remove the minimum by accident', async () => {
      const response = await update({ minimumAal: '' }, { minimumAal: 'AAL2' });
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('refuses an unknown level without touching the stored one', async () => {
      const response = await update({ minimumAal: 'AAL9' }, { minimumAal: 'AAL2' });
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('does not let a stored value that is not a level through as "no minimum"', async () => {
      // A hand-edited row: an update of something else must not launder it into no minimum.
      const response = await update(
        { acsUrl: 'https://sp.example.test/new-acs' },
        { minimumAal: 'bogus' }
      );
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });
  });

  it('audits a change of the minimum with the old and new level, and only a change', async () => {
    await update({ minimumAal: 'AAL3' }, { minimumAal: 'AAL2' });
    const metadata = (action: string) =>
      JSON.parse(
        mocks.audit.mock.calls.find(([, entry]) => entry.action === action)?.[1].metadata ?? '{}'
      ) as Record<string, unknown>;
    expect(metadata('saml.provider.updated')).toMatchObject({
      minimum_aal_changed: true,
      previous_minimum_aal: 'AAL2',
      next_minimum_aal: 'AAL3',
    });

    mocks.audit.mockClear();
    await update({ acsUrl: 'https://sp.example.test/new-acs' }, { minimumAal: 'AAL2' });
    expect(metadata('saml.provider.updated')).not.toHaveProperty('minimum_aal_changed');

    mocks.audit.mockClear();
    await handleCreateProvider(context({ body: createBody({ minimumAal: 'AAL2' }) }));
    expect(metadata('saml.provider.created')).toMatchObject({ minimum_aal: 'AAL2' });
  });

  it('hands the stored minimum to the SSO flows with the SP config', async () => {
    mocks.adapter!.query.mockResolvedValue([
      {
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          signResponses: true,
          signAssertions: false,
          minimumAal: 'AAL2',
        }),
        enabled: 1,
      },
    ]);
    const config = await getSPConfig({} as never, 'tenant-a', 'https://sp.example.test');
    expect(config?.minimumAal).toBe('AAL2');
  });
});

describe('an SP AuthnContextClassRef mode in the SAML provider Admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
  });

  it.each(['legacy_static', 'session', 'assurance'])('stores %s on create', async (mode) => {
    const response = await handleCreateProvider(
      context({ body: createBody({ authnContextClassRefMode: mode }) })
    );
    expect(response.status).toBe(201);
    expect(stored().authnContextClassRefMode).toBe(mode);
  });

  it.each([['assurence'], [''], ['SESSION'], [1], [true]])(
    'refuses %j rather than taking it for the static mode',
    async (value) => {
      const response = await handleCreateProvider(
        context({ body: createBody({ authnContextClassRefMode: value }) })
      );
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    }
  );

  it('changes the mode on update, audits the change, and keeps it when not mentioned', async () => {
    await update(
      { authnContextClassRefMode: 'assurance' },
      { authnContextClassRefMode: 'session' }
    );
    expect(stored().authnContextClassRefMode).toBe('assurance');
    const entry = mocks.audit.mock.calls.find(([, e]) => e.action === 'saml.provider.updated')?.[1];
    expect(JSON.parse(entry?.metadata ?? '{}')).toMatchObject({
      authn_context_class_ref_mode_changed: true,
      previous_authn_context_class_ref_mode: 'session',
      next_authn_context_class_ref_mode: 'assurance',
    });
    await update(
      { acsUrl: 'https://sp.example.test/new-acs' },
      { authnContextClassRefMode: 'assurance' }
    );
    expect(stored().authnContextClassRefMode).toBe('assurance');
  });

  it('refuses an unknown mode on update without touching the stored one', async () => {
    const response = await update(
      { authnContextClassRefMode: 'nope' },
      { authnContextClassRefMode: 'session' }
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });
});
