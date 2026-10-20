import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import {
  findMappingSetReferences,
  mappingSetReferenceBlock,
  summarizeMappingSetReferences,
  MAPPING_SET_REFERENCE_ROW_LIMIT,
  type FindMappingSetReferencesInput,
} from '../identity-mapping-set-references';
import {
  executionContextsOf,
  findMappingVersionSwapViolation,
  swapRequirementsOf,
} from '../identity-mapping-set-swap';
import {
  activationScopeApplies,
  resolveRuntimeIdentityMappingBinding,
  runtimeDestinationProfileIds,
} from '../identity-mapping-runtime-resolver';
import type { MappingSetReference } from '../identity-mapping-set-references';
import { findRenamedOutputAttributes } from '../saml-destination-policy';
import {
  addSettingsDocumentTables,
  openAdminDatabase,
  openCoreDatabase,
  seedDestinationProfile,
  seedMapping,
  sqliteAdapter,
} from './identity-mapping-sqlite-fixture';

/**
 * Who names a Mapping Set, on the real Admin schema and the real Core `oauth_clients` /
 * `identity_providers`. The documents are written in the form the settings store writes them (a
 * flat map of key to value, see settings-canonical-store.ts).
 */

const KEY = 'identity_mapping.oidc_default_set_id';

function admin(): DatabaseSync {
  const db = openAdminDatabase();
  addSettingsDocumentTables(db);
  // The sets the tests name (a credential profile version's foreign keys need them to exist).
  for (const [owner, id] of [
    ['tenant-a', 'set-a'],
    [PLATFORM_MAPPING_TENANT_ID, 'set-plat'],
  ]) {
    db.prepare(
      `INSERT INTO field_mapping_sets (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1, 1)`
    ).run(id, owner, `key-${id}`, id);
  }
  return db;
}

function saveSetting(
  db: DatabaseSync,
  scope: { tenantId: string } | 'platform',
  value: unknown,
  category = 'identity-mapping'
): void {
  const json = JSON.stringify({ [KEY]: value });
  const version = `sha256:${'0'.repeat(16)}`;
  if (scope === 'platform') {
    db.prepare(
      `INSERT INTO platform_settings_documents (category, document_json, version, revision, projection_state, updated_at, projected_at)
       VALUES (?, ?, ?, 1, 'applied', 1, 1)`
    ).run(category, json, version);
    return;
  }
  db.prepare(
    `INSERT INTO tenant_settings_documents (tenant_id, scope_type, scope_id, category, document_json, version, revision, projection_state, updated_at, projected_at)
     VALUES (?, 'tenant', ?, ?, ?, ?, 1, 'applied', 1, 1)`
  ).run(scope.tenantId, scope.tenantId, category, json, version);
}

function addClient(
  core: DatabaseSync,
  tenantId: string,
  clientId: string,
  identityMapping: unknown
): void {
  core
    .prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, tenant_id, identity_mapping, created_at, updated_at)
       VALUES (?, ?, '[]', '[]', '[]', ?, ?, 1, 1)`
    )
    .run(
      clientId,
      clientId,
      tenantId,
      typeof identityMapping === 'string' || identityMapping === null
        ? identityMapping
        : JSON.stringify(identityMapping)
    );
}

function addProvider(core: DatabaseSync, tenantId: string, id: string, config: unknown): void {
  core
    .prepare(
      `INSERT INTO identity_providers (id, name, provider_type, config_json, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'saml_sp', ?, ?, 1, 1)`
    )
    .run(id, id, JSON.stringify(config), tenantId);
}

function addCredentialVersion(
  db: DatabaseSync,
  input: {
    id: string;
    tenantId: string;
    state?: string;
    issuance: string;
    verification?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO credential_profiles (id, tenant_id, profile_key, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 'Profile', 1, 1)`
  ).run(`profile-of-${input.id}`, input.tenantId, `key-of-${input.id}`);
  db.prepare(
    `INSERT INTO credential_profile_versions (id, tenant_id, credential_profile_id, version_number, lifecycle_state,
       credential_configuration_id, issuance_flow_id, issuance_mapping_set_id, verification_mapping_set_id,
       claim_allowlist_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'cfg', 'flow', ?, ?, '[]', 1, 1)`
  ).run(
    input.id,
    input.tenantId,
    `profile-of-${input.id}`,
    input.state ?? 'published',
    input.issuance,
    input.verification ?? null
  );
}

function world() {
  const adminDb = admin();
  const cores = new Map<string, DatabaseSync>([
    ['tenant-a', openCoreDatabase()],
    ['tenant-b', openCoreDatabase()],
  ]);
  const settings = new Map<string, string>();
  const resolve = vi.fn(async (tenantId: string) => {
    const core = cores.get(tenantId);
    if (!core) throw new Error(`no database for ${tenantId}`);
    return sqliteAdapter(core);
  });
  const input = (
    overrides: Partial<FindMappingSetReferencesInput> = {}
  ): FindMappingSetReferencesInput => ({
    adminAdapter: sqliteAdapter(adminDb),
    setId: 'set-a',
    ownerTenantId: 'tenant-a',
    contextTenantId: 'tenant-a',
    contextCoreAdapter: sqliteAdapter(cores.get('tenant-a') as DatabaseSync),
    resolveCoreAdapter: resolve,
    listTenantIds: async () => ['tenant-a', 'tenant-b'],
    settingsStore: { get: async (key: string) => settings.get(key) ?? null },
    ...overrides,
  });
  return { adminDb, cores, settings, resolve, input };
}

describe('findMappingSetReferences', () => {
  it('finds nothing for a set nobody names, and says it looked everywhere', async () => {
    const w = world();
    saveSetting(w.adminDb, { tenantId: 'tenant-a' }, 'set-other');
    addClient(w.cores.get('tenant-a') as DatabaseSync, 'tenant-a', 'app', {
      fieldMappingSetId: 'set-other',
    });
    addClient(w.cores.get('tenant-a') as DatabaseSync, 'tenant-a', 'bare', null);

    const scan = await findMappingSetReferences(w.input());

    expect(scan).toEqual({ references: [], truncated: false, unscanned: [] });
    expect(mappingSetReferenceBlock(scan)).toBeNull();
  });

  it('does not count an app that opts out with { mode: "none" } as naming any set', async () => {
    const w = world();
    const coreA = w.cores.get('tenant-a') as DatabaseSync;
    addClient(coreA, 'tenant-a', 'opted-out', { mode: 'none' });
    addClient(coreA, 'tenant-a', 'names-a-set', { fieldMappingSetId: 'set-a' });

    const scan = await findMappingSetReferences(w.input());

    expect(scan.unscanned).toEqual([]);
    expect(scan.references).toEqual([
      { kind: 'client', tenantId: 'tenant-a', clientId: 'names-a-set' },
    ]);
  });

  it('finds the places that name a tenant’s set: its default, apps, SAML provider, credential profile and SCIM', async () => {
    const w = world();
    const coreA = w.cores.get('tenant-a') as DatabaseSync;
    saveSetting(w.adminDb, { tenantId: 'tenant-a' }, 'set-a');
    addClient(coreA, 'tenant-a', 'app-1', {
      fieldMappingSetId: 'set-a',
      fieldMappingVersionId: 'ver-9',
    });
    // The older spelling of the same choice.
    addClient(coreA, 'tenant-a', 'app-2', { policySetId: 'set-a' });
    // A string that is not JSON can name nothing, and must not stop the others being found.
    addClient(coreA, 'tenant-a', 'app-garbage', 'not json');
    addProvider(coreA, 'tenant-a', 'sp-1', { identityMapping: { fieldMappingSetId: 'set-a' } });
    addCredentialVersion(w.adminDb, {
      id: 'cv-1',
      tenantId: 'tenant-a',
      issuance: 'set-a',
      verification: 'set-a',
    });
    w.settings.set(
      'settings:tenant:tenant-a:scim',
      JSON.stringify({ enabled: true, mappingSetId: 'set-a' })
    );

    const scan = await findMappingSetReferences(w.input());

    expect(scan.unscanned).toEqual([]);
    expect(scan.references).toEqual(
      expect.arrayContaining([
        { kind: 'tenant_default', tenantId: 'tenant-a' },
        { kind: 'client', tenantId: 'tenant-a', clientId: 'app-1', pinnedVersionId: 'ver-9' },
        { kind: 'client', tenantId: 'tenant-a', clientId: 'app-2' },
        {
          kind: 'saml_provider',
          tenantId: 'tenant-a',
          providerId: 'sp-1',
          providerType: 'saml_sp',
        },
        expect.objectContaining({
          kind: 'credential_profile',
          role: 'issuance',
          versionId: 'cv-1',
        }),
        expect.objectContaining({ kind: 'credential_profile', role: 'verification' }),
        { kind: 'scim', tenantId: 'tenant-a' },
      ])
    );
    expect(scan.references).toHaveLength(7);
    expect(mappingSetReferenceBlock(scan)).toBe('referenced');
    // Only the owner’s Core database is read for a set a tenant owns.
    expect(w.resolve).not.toHaveBeenCalled();
  });

  it('ignores SCIM settings that are switched off, and settings that are not JSON', async () => {
    const w = world();
    w.settings.set(
      'settings:tenant:tenant-a:scim',
      JSON.stringify({ enabled: false, mappingSetId: 'set-a' })
    );
    expect((await findMappingSetReferences(w.input())).references).toEqual([]);
    w.settings.set('settings:tenant:tenant-a:scim', '{broken');
    expect(await findMappingSetReferences(w.input())).toMatchObject({
      references: [],
      unscanned: [],
    });
  });

  it('finds the platform’s default and the default of any tenant for a platform set, in every tenant’s apps', async () => {
    const w = world();
    saveSetting(w.adminDb, 'platform', 'set-plat');
    saveSetting(w.adminDb, { tenantId: 'tenant-b' }, 'set-plat');
    addClient(w.cores.get('tenant-b') as DatabaseSync, 'tenant-b', 'b-app', {
      fieldMappingSetId: 'set-plat',
    });
    addCredentialVersion(w.adminDb, { id: 'cv-b', tenantId: 'tenant-b', issuance: 'set-plat' });

    const scan = await findMappingSetReferences(
      w.input({ setId: 'set-plat', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
    );

    expect(scan.unscanned).toEqual([]);
    expect(scan.references).toEqual(
      expect.arrayContaining([
        { kind: 'platform_default' },
        { kind: 'tenant_default', tenantId: 'tenant-b' },
        { kind: 'client', tenantId: 'tenant-b', clientId: 'b-app' },
        expect.objectContaining({ kind: 'credential_profile', tenantId: 'tenant-b' }),
      ])
    );
    expect(w.resolve).toHaveBeenCalledWith('tenant-b');
    // SCIM cannot use a platform set: its settings are not read.
    expect(scan.references.some((reference) => reference.kind === 'scim')).toBe(false);
  });

  it('does not take a tenant default from another category or a platform document of another category', async () => {
    const w = world();
    saveSetting(w.adminDb, { tenantId: 'tenant-a' }, 'set-a', 'oauth');
    saveSetting(w.adminDb, 'platform', 'set-a', 'oauth');
    expect((await findMappingSetReferences(w.input())).references).toEqual([]);
  });

  describe('what it could not look at is reported, and blocks', () => {
    it('a tenant whose Core database cannot be had', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          listTenantIds: async () => ['tenant-a', 'tenant-b', 'tenant-gone'],
        })
      );

      expect(scan.references).toEqual([]);
      expect(scan.unscanned).toEqual([
        { area: 'tenant_clients', tenantId: 'tenant-gone', reason: 'core_database_unavailable' },
        { area: 'tenant_saml', tenantId: 'tenant-gone', reason: 'core_database_unavailable' },
      ]);
      expect(mappingSetReferenceBlock(scan)).toBe('scan_incomplete');
    });

    it('no way to reach other tenants’ Core databases', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          resolveCoreAdapter: undefined,
        })
      );
      expect(scan.unscanned.map((entry) => entry.tenantId)).toEqual(['tenant-b', 'tenant-b']);
    });

    it('no list of tenants for a platform set', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          listTenantIds: undefined,
        })
      );
      expect(scan.unscanned).toEqual([
        { area: 'tenant_directory', reason: 'tenant_directory_unavailable' },
      ]);
    });

    it('the context tenant’s Core database missing', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({ contextCoreAdapter: null, resolveCoreAdapter: undefined })
      );
      expect(scan.unscanned.map((entry) => entry.area)).toEqual(['tenant_clients', 'tenant_saml']);
    });

    it('more tenants than the limit, with the context tenant always looked at', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          contextTenantId: 'tenant-b',
          contextCoreAdapter: sqliteAdapter(w.cores.get('tenant-b') as DatabaseSync),
          listTenantIds: async () => ['tenant-a', 'tenant-b', 'tenant-c'],
          maxTenants: 2,
        })
      );
      expect(scan.unscanned).toContainEqual({
        area: 'tenant_limit',
        reason: 'tenant_limit_exceeded',
      });
      expect(w.resolve).toHaveBeenCalledWith('tenant-a');
      expect(w.resolve).not.toHaveBeenCalledWith('tenant-c');
    });

    it('a query that fails, without keeping the error', async () => {
      const w = world();
      (w.cores.get('tenant-a') as DatabaseSync).exec('DROP TABLE oauth_clients');
      const scan = await findMappingSetReferences(w.input());
      expect(scan.unscanned).toEqual([
        { area: 'tenant_clients', tenantId: 'tenant-a', reason: 'no_such_table' },
      ]);
    });

    it('settings documents that cannot be read', async () => {
      const w = world();
      w.adminDb.exec('DROP TABLE tenant_settings_documents');
      w.adminDb.exec('DROP TABLE platform_settings_documents');
      const scan = await findMappingSetReferences(w.input());
      expect(scan.unscanned.map((entry) => entry.area)).toEqual([
        'platform_settings',
        'tenant_settings',
      ]);
    });

    it('no settings store for a tenant’s SCIM settings', async () => {
      const w = world();
      const scan = await findMappingSetReferences(w.input({ settingsStore: null }));
      expect(scan.unscanned).toEqual([
        { area: 'scim_settings', tenantId: 'tenant-a', reason: 'settings_store_unavailable' },
      ]);
    });

    it('a settings store that fails', async () => {
      const w = world();
      const scan = await findMappingSetReferences(
        w.input({
          settingsStore: {
            get: async () => {
              throw new Error('kv down');
            },
          },
        })
      );
      expect(scan.unscanned).toEqual([
        expect.objectContaining({ area: 'scim_settings', tenantId: 'tenant-a' }),
      ]);
    });
  });

  it('stops reading at the row limit and says the count is a lower bound', async () => {
    const w = world();
    const core = w.cores.get('tenant-a') as DatabaseSync;
    for (let index = 0; index < MAPPING_SET_REFERENCE_ROW_LIMIT + 5; index += 1) {
      addClient(core, 'tenant-a', `app-${String(index).padStart(4, '0')}`, {
        fieldMappingSetId: 'set-a',
      });
    }
    const scan = await findMappingSetReferences(w.input());
    expect(scan.references).toHaveLength(MAPPING_SET_REFERENCE_ROW_LIMIT);
    expect(scan.truncated).toBe(true);
    expect(
      summarizeMappingSetReferences(scan, {
        viewerTenantId: 'tenant-a',
        includeOtherTenants: false,
      })
    ).toMatchObject({
      count: MAPPING_SET_REFERENCE_ROW_LIMIT,
      countIsLowerBound: true,
    });
  });

  describe('purpose: switching off leaves out credential versions that cannot be used', () => {
    it.each([
      ['draft', 'change', 0],
      ['retired', 'change', 0],
      ['published', 'change', 1],
      ['draft', 'delete', 1],
      ['retired', 'delete', 1],
    ] as const)('a %s version, asked for %s: %i reference(s)', async (state, purpose, count) => {
      const w = world();
      addCredentialVersion(w.adminDb, { id: 'cv', tenantId: 'tenant-a', state, issuance: 'set-a' });
      const scan = await findMappingSetReferences(w.input({ purpose }));
      expect(scan.references).toHaveLength(count);
    });
  });

  describe('credential profile versions, cut off by the row limit', () => {
    it('finds a published version behind more drafts and retired ones than the limit', async () => {
      const w = world();
      const insert = w.adminDb.prepare(
        `INSERT INTO credential_profile_versions (id, tenant_id, credential_profile_id, version_number, lifecycle_state,
           credential_configuration_id, issuance_flow_id, issuance_mapping_set_id, claim_allowlist_json, created_at, updated_at)
         VALUES (?, 'tenant-a', 'cp', ?, ?, 'cfg', 'flow', 'set-a', '[]', 1, 1)`
      );
      w.adminDb
        .prepare(
          `INSERT INTO credential_profiles (id, tenant_id, profile_key, display_name, created_at, updated_at)
           VALUES ('cp', 'tenant-a', 'cp', 'P', 1, 1)`
        )
        .run();
      for (let index = 0; index < MAPPING_SET_REFERENCE_ROW_LIMIT + 5; index += 1) {
        insert.run(`a-old-${String(index).padStart(4, '0')}`, index + 1, 'retired');
      }
      insert.run('z-live', MAPPING_SET_REFERENCE_ROW_LIMIT + 100, 'published');

      const change = await findMappingSetReferences(w.input({ purpose: 'change' }));
      expect(change.references).toEqual([
        expect.objectContaining({ kind: 'credential_profile', versionId: 'z-live' }),
      ]);
      // Removing the set is stopped by every version, so there the list is cut off.
      const remove = await findMappingSetReferences(w.input({ purpose: 'delete' }));
      expect(remove.truncated).toBe(true);
    });
  });

  describe('federation trust sources', () => {
    function addSource(db: DatabaseSync, id: string, tenantId: string, payload: unknown) {
      db.prepare(
        `INSERT INTO federation_trust_sources (id, tenant_id, source_type, source_key, display_name, lifecycle_state, protocol_payload_json, created_at, updated_at)
         VALUES (?, ?, 'saml_aggregate', ?, 'n', 'active', ?, 1, 1)`
      ).run(id, tenantId, id, typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    it('finds the set named for identity providers or for service providers', async () => {
      const w = world();
      addSource(w.adminDb, 'fts-idp', 'tenant-a', {
        runtimeResolution: {
          mode: 'automatic',
          roles: ['saml_idp'],
          idpFieldMappingSetId: 'set-a',
        },
      });
      addSource(w.adminDb, 'fts-sp', 'tenant-a', {
        runtimeResolution: { mode: 'automatic', roles: ['saml_sp'], spFieldMappingSetId: 'set-a' },
      });
      addSource(w.adminDb, 'fts-other', 'tenant-a', {
        runtimeResolution: { mode: 'automatic', roles: ['saml_sp'], spFieldMappingSetId: 'set-x' },
      });
      addSource(w.adminDb, 'fts-broken', 'tenant-a', 'not json');
      addSource(w.adminDb, 'fts-none', 'tenant-a', { other: true });

      const scan = await findMappingSetReferences(w.input());

      expect(scan.unscanned).toEqual([]);
      expect(scan.references).toEqual([
        {
          kind: 'federation_trust_source',
          tenantId: 'tenant-a',
          trustSourceId: 'fts-idp',
          federationRole: 'saml_idp',
        },
        {
          kind: 'federation_trust_source',
          tenantId: 'tenant-a',
          trustSourceId: 'fts-sp',
          federationRole: 'saml_sp',
        },
      ]);
    });

    it('keeps to the owner’s tenant for a tenant’s set, and reads every tenant’s for a platform set', async () => {
      const w = world();
      addSource(w.adminDb, 'fts-b', 'tenant-b', {
        runtimeResolution: { spFieldMappingSetId: 'set-a' },
      });
      expect((await findMappingSetReferences(w.input())).references).toEqual([]);
      addSource(w.adminDb, 'fts-p', 'tenant-b', {
        runtimeResolution: { spFieldMappingSetId: 'set-plat' },
      });
      const platform = await findMappingSetReferences(
        w.input({ setId: 'set-plat', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
      );
      expect(platform.references).toEqual([
        expect.objectContaining({ kind: 'federation_trust_source', tenantId: 'tenant-b' }),
      ]);
    });

    it('is reported as not looked at when the table cannot be read', async () => {
      const w = world();
      w.adminDb.exec('DROP TABLE federation_trust_sources');
      const scan = await findMappingSetReferences(w.input());
      expect(scan.unscanned).toEqual([
        { area: 'federation_trust_sources', reason: 'no_such_table' },
      ]);
    });
  });

  describe('looking at other tenants', () => {
    it('can be left to the callers that may do it: the rest is reported, and no database is read', async () => {
      const w = world();
      saveSetting(w.adminDb, { tenantId: 'tenant-b' }, 'set-plat');
      const scan = await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          scanOtherTenants: false,
          listTenantIds: vi.fn(async () => ['tenant-a', 'tenant-b']),
        })
      );
      expect(w.resolve).not.toHaveBeenCalled();
      expect(scan.unscanned).toEqual([{ area: 'other_tenants', reason: 'not_scanned' }]);
      // What the Admin database holds is still found.
      expect(scan.references).toEqual([{ kind: 'tenant_default', tenantId: 'tenant-b' }]);
      expect(mappingSetReferenceBlock(scan)).toBe('referenced');
      const summary = summarizeMappingSetReferences(scan, {
        viewerTenantId: 'tenant-a',
        includeOtherTenants: false,
      });
      expect(summary.otherTenants).toEqual({ referenceCount: 1, tenantCount: 1, scanned: false });
    });

    it('asks the list of tenants for one more than it will look at', async () => {
      const w = world();
      const list = vi.fn(async () => ['tenant-a']);
      await findMappingSetReferences(
        w.input({
          setId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
          listTenantIds: list,
          maxTenants: 7,
        })
      );
      expect(list).toHaveBeenCalledWith(8);
    });
  });
});

describe('summarizeMappingSetReferences', () => {
  const scan = {
    references: [
      { kind: 'platform_default' as const },
      { kind: 'tenant_default' as const, tenantId: 'tenant-a' },
      { kind: 'client' as const, tenantId: 'tenant-a', clientId: 'a-1' },
      { kind: 'client' as const, tenantId: 'tenant-b', clientId: 'b-1' },
      { kind: 'client' as const, tenantId: 'tenant-b', clientId: 'b-2' },
      { kind: 'tenant_default' as const, tenantId: 'tenant-c' },
    ],
    truncated: false,
    unscanned: [
      {
        area: 'tenant_clients' as const,
        tenantId: 'tenant-d',
        reason: 'core_database_unavailable',
      },
      { area: 'tenant_saml' as const, tenantId: 'tenant-d', reason: 'core_database_unavailable' },
      { area: 'tenant_clients' as const, tenantId: 'tenant-a', reason: 'no_such_table' },
    ],
  };

  it('gives a caller without global authority only its own tenant’s references and counts of the rest', () => {
    const summary = summarizeMappingSetReferences(scan, {
      viewerTenantId: 'tenant-a',
      includeOtherTenants: false,
    });

    expect(summary.count).toBe(6);
    expect(summary.items).toEqual([
      { kind: 'platform_default' },
      { kind: 'tenant_default', tenantId: 'tenant-a' },
      { kind: 'client', tenantId: 'tenant-a', clientId: 'a-1' },
    ]);
    expect(summary.otherTenants).toEqual({ referenceCount: 3, tenantCount: 2, scanned: true });
    expect(summary.scanComplete).toBe(false);
    expect(summary.unscanned.count).toBe(3);
    // Another tenant’s ID is not given away by being unreachable either.
    expect(JSON.stringify(summary)).not.toMatch(/tenant-b|tenant-c|tenant-d|b-1|b-2/);
    expect(summary.unscanned.items).toEqual([
      { area: 'tenant_clients', tenantId: 'tenant-a', reason: 'no_such_table' },
      { area: 'tenant_clients', reason: 'core_database_unavailable' },
      { area: 'tenant_saml', reason: 'core_database_unavailable' },
    ]);
  });

  it('gives global authority everything', () => {
    const summary = summarizeMappingSetReferences(scan, {
      viewerTenantId: 'tenant-a',
      includeOtherTenants: true,
    });
    expect(summary.items).toHaveLength(6);
    expect(summary.otherTenants).toBeUndefined();
    expect(summary.unscanned.items).toContainEqual({
      area: 'tenant_clients',
      tenantId: 'tenant-d',
      reason: 'core_database_unavailable',
    });
  });

  it('cuts the list at the limit', () => {
    const summary = summarizeMappingSetReferences(scan, {
      viewerTenantId: 'tenant-a',
      includeOtherTenants: true,
      itemLimit: 2,
    });
    expect(summary.items).toHaveLength(2);
    expect(summary.itemsTruncated).toBe(true);
    expect(summary.count).toBe(6);
  });
});

describe('findMappingVersionSwapViolation', () => {
  const snapshot = {
    catalogVersionId: 'catalog-a',
    willBeActive: true,
    snapshotHash: 'snapshot-a',
  };
  const client: MappingSetReference = { kind: 'client', tenantId: 'tenant-a', clientId: 'app-1' };

  function seeded(owner = 'tenant-a', id = 'a') {
    const db = openAdminDatabase();
    seedMapping(db, { owner, id });
    seedDestinationProfile(db, { owner, id: `profile-${id}` });
    return db;
  }
  const check = (
    db: DatabaseSync,
    overrides: Partial<Parameters<typeof findMappingVersionSwapViolation>[0]> = {}
  ) =>
    findMappingVersionSwapViolation({
      adapter: sqliteAdapter(db),
      ownerTenantId: 'tenant-a',
      contextTenantId: 'tenant-a',
      versionId: 'ver-a',
      snapshot,
      references: [client],
      ...overrides,
    });

  it('accepts a version that still releases into one active OIDC profile', async () => {
    expect(await check(seeded())).toBeNull();
  });

  it('refuses a version with no active compiled snapshot', async () => {
    expect(await check(seeded(), { snapshot: { ...snapshot, willBeActive: false } })).toMatchObject(
      { code: 'snapshot_inactive' }
    );
    expect(
      await check(seeded(), { snapshot: { ...snapshot, catalogVersionId: null } })
    ).toMatchObject({ code: 'snapshot_inactive' });
  });

  it('refuses a version that releases into two profiles, or none, to an app', async () => {
    const two = seeded();
    two.exec(
      'INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at) VALUES (\'e2\', \'tenant-a\', \'rule-a\', \'{"side":"source","namespace":"authrim.profile","path":"email"}\', \'{"side":"destination","profileId":"profile-two","namespace":"oidc.claim","path":"email"}\', \'direct\', 1, 1, 1)'
    );
    expect(await check(two)).toMatchObject({ code: 'destination_profile_invalid' });
    const none = seeded();
    none.exec('DELETE FROM mapping_rule_edges');
    expect(await check(none)).toMatchObject({ code: 'destination_profile_invalid' });
  });

  it('asks nothing of the profile for what only reads what comes in or writes canonical attributes', async () => {
    const none = seeded();
    none.exec('DELETE FROM mapping_rule_edges');
    for (const reference of [
      { kind: 'scim', tenantId: 'tenant-a' },
      { kind: 'credential_profile', tenantId: 'tenant-a', role: 'issuance' },
      { kind: 'saml_provider', tenantId: 'tenant-a', providerType: 'saml_idp' },
      { kind: 'federation_trust_source', tenantId: 'tenant-a', federationRole: 'saml_idp' },
    ] as const) {
      expect(await check(none, { references: [reference] }), reference.kind).toBeNull();
    }
    // The same version is refused to what releases to a SAML service provider.
    for (const reference of [
      { kind: 'saml_provider', tenantId: 'tenant-a', providerType: 'saml_sp' },
      { kind: 'federation_trust_source', tenantId: 'tenant-a', federationRole: 'saml_sp' },
    ] as const) {
      expect(await check(none, { references: [reference] }), reference.kind).toMatchObject({
        code: 'destination_profile_invalid',
      });
    }
  });

  it('refuses a version whose profile is not active, or not of the kind in use', async () => {
    const inactive = seeded();
    inactive.exec("UPDATE destination_profiles SET lifecycle_state = 'retired'");
    expect(await check(inactive)).toMatchObject({ code: 'destination_profile_invalid' });
    const saml = seeded();
    saml.exec("UPDATE destination_profiles SET destination_type = 'saml'");
    expect(await check(saml)).toMatchObject({ code: 'destination_profile_invalid' });
    expect(
      await check(saml, { references: [{ kind: 'saml_provider', providerType: 'saml_sp' }] })
    ).toBeNull();
  });

  it('holds a platform set to what a platform set may hold, and a tenant’s set not', async () => {
    const platform = seeded(PLATFORM_MAPPING_TENANT_ID, 'plat');
    const asPlatform = {
      ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
      versionId: 'ver-plat',
      snapshot: { ...snapshot, catalogVersionId: 'catalog-plat' },
    };
    expect(await check(platform, asPlatform)).toBeNull();
    platform.exec("UPDATE mapping_transform_steps SET operation = 'oidc_pairwise_sub'");
    expect(await check(platform, asPlatform)).toMatchObject({ code: 'platform_set_unsafe' });
    const tenant = seeded();
    tenant.exec("UPDATE mapping_transform_steps SET operation = 'oidc_pairwise_sub'");
    expect(await check(tenant)).toBeNull();
  });

  describe('what a reference pins', () => {
    it.each([
      [
        'a version other than this one',
        { ...client, pinnedVersionId: 'ver-other' },
        'pinned_version_replaced',
      ],
      ['this version', { ...client, pinnedVersionId: 'ver-a' }, null],
      [
        'a snapshot other than this version’s',
        { kind: 'credential_profile', pinnedSnapshotHash: 'old' },
        'pinned_version_replaced',
      ],
      [
        'this version’s snapshot',
        { kind: 'credential_profile', pinnedSnapshotHash: 'snapshot-a' },
        null,
      ],
    ] as const)('%s', async (_name, reference, code) => {
      const result = await check(seeded(), { references: [reference] });
      if (code) expect(result).toMatchObject({ code });
      else expect(result).toBeNull();
    });
  });

  describe('the scope of the activation', () => {
    it.each([
      ['empty', {}, null],
      ['the tenant', { kind: 'tenant', id: 'tenant-a' }, null],
      ['another tenant', { kind: 'tenant', id: 'tenant-b' }, 'activation_scope_mismatch'],
      ['this protocol and role', { protocol: 'oidc', role: 'op' }, null],
      ['another protocol', { protocol: 'saml' }, 'activation_scope_mismatch'],
      ['this app', { clientId: 'app-1' }, null],
      ['another app', { clientId: 'app-2' }, 'activation_scope_mismatch'],
    ] as const)('an app against a scope for %s', async (_name, scope, code) => {
      const result = await check(seeded(), { activationScope: scope });
      if (code) expect(result).toMatchObject({ code });
      else expect(result).toBeNull();
    });

    it('is not judged when no scope is given (the platform’s sets)', async () => {
      expect(await check(seeded())).toBeNull();
    });

    it('is judged for the default, which applies to every app, as every app', async () => {
      const db = seeded();
      const def: MappingSetReference = { kind: 'tenant_default', tenantId: 'tenant-a' };
      expect(
        await check(db, { references: [def], activationScope: { clientId: 'app-1' } })
      ).toMatchObject({
        code: 'activation_scope_mismatch',
      });
      expect(
        await check(db, { references: [def], activationScope: { protocol: 'oidc' } })
      ).toBeNull();
    });

    it('is judged against Authrim’s own entity ID, which a reference does not know', async () => {
      const db = seeded();
      const sp: MappingSetReference = {
        kind: 'saml_provider',
        tenantId: 'tenant-a',
        providerType: 'saml_sp',
        entityId: 'https://sp.example.test',
      };
      db.exec("UPDATE destination_profiles SET destination_type = 'saml'");
      expect(
        await check(db, {
          references: [sp],
          activationScope: { partnerEntityId: 'https://sp.example.test' },
        })
      ).toBeNull();
      expect(
        await check(db, {
          references: [sp],
          activationScope: { localEntityId: 'https://idp.example.test' },
        })
      ).toMatchObject({ code: 'activation_scope_mismatch' });
    });
  });
});

describe('swapRequirementsOf', () => {
  it('says what each kind of reference needs of the profile', () => {
    const needs = (references: MappingSetReference[]) => {
      const result = swapRequirementsOf(references);
      return [result.exactlyOneProfile, [...result.profileTypes]];
    };
    expect(needs([{ kind: 'client' }, { kind: 'scim' }])).toEqual([true, ['oidc']]);
    expect(needs([{ kind: 'saml_provider', providerType: 'saml_sp' }])).toEqual([true, ['saml']]);
    expect(needs([{ kind: 'saml_provider', providerType: 'saml_idp' }])).toEqual([false, []]);
    expect(needs([{ kind: 'federation_trust_source', federationRole: 'saml_idp' }])).toEqual([
      false,
      [],
    ]);
    expect(needs([{ kind: 'credential_profile' }, { kind: 'scim' }])).toEqual([false, []]);
  });
});

describe('the scope rule is the one the runtime ranks activations by', () => {
  const scopes = [
    {},
    { kind: 'tenant', id: 'tenant-a' },
    { kind: 'tenant', id: 'tenant-b' },
    { tenantId: 'tenant-a', protocol: 'oidc', role: 'op' },
    { protocol: 'saml' },
    { role: 'rp' },
    { clientId: 'app-1' },
    { client_id: 'app-2' },
    { partnerEntityId: 'app-1' },
    { rpClientId: 'app-1' },
    { localEntityId: 'https://idp.example.test' },
    { providerId: 'p-1' },
  ];
  const contexts = [
    { tenantId: 'tenant-a', protocol: 'oidc', role: 'op' },
    {
      tenantId: 'tenant-a',
      protocol: 'oidc',
      role: 'op',
      clientId: 'app-1',
      partnerEntityId: 'app-1',
    },
    { tenantId: 'tenant-a', protocol: 'saml', role: 'idp', partnerEntityId: 'app-1' },
  ];

  it.each(scopes.flatMap((scope) => contexts.map((context) => [scope, context] as const)))(
    'scope %j in context %j',
    async (scope, context) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'a', scope });
      const resolved = await resolveRuntimeIdentityMappingBinding(sqliteAdapter(db), {
        ...context,
        fieldMappingSetId: 'set-a',
      });
      expect(activationScopeApplies(scope, context)).toBe(resolved !== null);
    }
  );

  it('gives a reference the contexts it runs in', () => {
    expect(executionContextsOf({ kind: 'client', clientId: 'app-1', tenantId: 't' }, 'x')).toEqual([
      { tenantId: 't', protocol: 'oidc', role: 'op', clientId: 'app-1', partnerEntityId: 'app-1' },
    ]);
    expect(executionContextsOf({ kind: 'platform_default' }, 'ctx')).toEqual([
      { tenantId: 'ctx', protocol: 'oidc', role: 'op' },
    ]);
  });
});

describe('the Destination Profiles the runtime counts', () => {
  const edgeRefs = [
    { side: 'destination', profileId: 'profile-a', namespace: 'oidc.claim', path: 'email' },
  ];

  it.each([
    [{}],
    [{ destinationProfileId: 'profile-a' }],
    [{ destinationProfileId: 'profile-b' }],
    [{ destinationProfileId: 'destination-profile-profile-a' }],
    [{ destinationProfileId: '' }],
  ])('is what the resolver binds, for the scope %j', async (scope) => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'a', scope });
    const binding = await resolveRuntimeIdentityMappingBinding(sqliteAdapter(db), {
      tenantId: 'tenant-a',
      protocol: 'oidc',
      role: 'op',
      fieldMappingSetId: 'set-a',
    });
    expect(runtimeDestinationProfileIds(edgeRefs, scope)).toEqual(binding?.destinationProfileIds);
  });

  it('refuses a version whose scope names a profile besides the edges’', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'a' });
    seedDestinationProfile(db, { owner: 'tenant-a', id: 'profile-a' });
    const check = (activationScope: unknown) =>
      findMappingVersionSwapViolation({
        adapter: sqliteAdapter(db),
        ownerTenantId: 'tenant-a',
        contextTenantId: 'tenant-a',
        versionId: 'ver-a',
        snapshot: { catalogVersionId: 'catalog-a', willBeActive: true, snapshotHash: 'snapshot-a' },
        activationScope,
        references: [{ kind: 'client', tenantId: 'tenant-a', clientId: 'app-1' }],
      });
    expect(await check({ destinationProfileId: 'profile-b' })).toMatchObject({
      code: 'destination_profile_invalid',
    });
    expect(await check({ destinationProfileId: 'profile-a' })).toBeNull();
  });
});

describe('a list cut off at the row limit', () => {
  it('is not called complete', () => {
    const summary = summarizeMappingSetReferences(
      { references: [{ kind: 'platform_default' }], truncated: true, unscanned: [] },
      { viewerTenantId: 'tenant-a', includeOtherTenants: false }
    );
    expect(summary).toMatchObject({ countIsLowerBound: true, scanComplete: false });
  });

  it('does not change what refuses a removal: any reference does', () => {
    const cut = { references: [{ kind: 'client' as const }], truncated: true, unscanned: [] };
    const whole = { ...cut, truncated: false };
    expect(mappingSetReferenceBlock(cut)).toBe(mappingSetReferenceBlock(whole));
  });
});

describe('what a provider saved is not shown', () => {
  it('leaves the saved policy out of the references that are shown', () => {
    const summary = summarizeMappingSetReferences(
      {
        references: [
          {
            kind: 'saml_provider',
            tenantId: 'tenant-a',
            swapInputs: { policyKeys: ['mail'], attributeDescriptors: { mail: { name: 'x' } } },
          },
        ],
        truncated: false,
        unscanned: [],
      },
      { viewerTenantId: 'tenant-a', includeOtherTenants: false }
    );
    expect(summary.items).toEqual([{ kind: 'saml_provider', tenantId: 'tenant-a' }]);
  });

  it('is read from the provider’s configuration', async () => {
    const w = world();
    addProvider(w.cores.get('tenant-a') as DatabaseSync, 'tenant-a', 'sp-1', {
      entityId: 'https://sp.example.test',
      identityMapping: {
        fieldMappingSetId: 'set-a',
        destinationFieldPolicies: { mail: 'required', uid: 'optional' },
        attributeDescriptors: { mail: { name: 'urn:mail' } },
        destinationNamespace: 'saml.attribute',
      },
    });
    const scan = await findMappingSetReferences(w.input());
    expect(scan.references).toEqual([
      expect.objectContaining({
        kind: 'saml_provider',
        entityId: 'https://sp.example.test',
        swapInputs: {
          policyKeys: ['mail', 'uid'],
          attributeDescriptors: { mail: { name: 'urn:mail' } },
          destinationNamespace: 'saml.attribute',
        },
      }),
    ]);
  });
});

describe('attribute names a SAML provider saved, in every spelling of a reference', () => {
  /**
   * A version that releases one attribute to the SAML destination, the reference to it spelled as
   * given, judged two ways: as the check that puts the version in use judges it, and as the check
   * that saves the provider's configuration does once the version is the one in use.
   */
  async function judged(
    target: Record<string, unknown>,
    descriptors: Record<string, { name?: string }>
  ) {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'a' });
    seedDestinationProfile(db, {
      owner: 'tenant-a',
      id: 'profile-a',
      destinationType: 'saml',
      attributes: ['mail', 'uid'],
    });
    db.exec('DELETE FROM mapping_rule_edges');
    db.prepare(
      `INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at)
       VALUES ('e1', 'tenant-a', 'rule-a', ?, ?, 'direct', 0, 1, 1)`
    ).run(
      JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'email' }),
      JSON.stringify({
        side: 'destination',
        profileId: 'profile-a',
        namespace: 'saml.attribute',
        ...target,
      })
    );
    const adapter = sqliteAdapter(db);
    const provider: MappingSetReference = {
      kind: 'saml_provider',
      tenantId: 'tenant-a',
      providerType: 'saml_sp',
      swapInputs: { policyKeys: ['mail', 'uid'], attributeDescriptors: descriptors },
    };
    const swap = await findMappingVersionSwapViolation({
      adapter,
      ownerTenantId: 'tenant-a',
      contextTenantId: 'tenant-a',
      versionId: 'ver-a',
      snapshot: { catalogVersionId: 'catalog-a', willBeActive: true, snapshotHash: 'snapshot-a' },
      activationScope: {},
      references: [provider],
    });
    const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId: 'tenant-a',
      protocol: 'saml',
      role: 'idp',
      fieldMappingSetId: 'set-a',
    });
    const saved = findRenamedOutputAttributes(
      { edges: binding?.edges ?? [], transforms: binding?.transforms ?? [] },
      'saml.attribute',
      descriptors
    );
    return { swap: swap?.code ?? null, saved: saved.length > 0 };
  }

  const RENAMED = 'saml_attribute_descriptor_renames_field';
  it.each([
    ['path', { path: 'mail' }, { mail: { name: 'urn:mail' } }, RENAMED],
    ['fieldKey', { fieldKey: 'mail' }, { mail: { name: 'urn:mail' } }, RENAMED],
    ['nodeId', { nodeId: 'mail' }, { mail: { name: 'urn:mail' } }, RENAMED],
    ['path of another attribute', { path: 'uid' }, { mail: { name: 'urn:mail' } }, null],
    ['fieldKey of another attribute', { fieldKey: 'uid' }, { mail: { name: 'urn:mail' } }, null],
    ['path, name the field’s', { path: 'mail' }, { mail: { name: 'mail' } }, null],
    [
      'catalogEntryId, name the field’s',
      { catalogEntryId: 'e1', fieldKey: 'mail' },
      { e1: { name: 'mail' } },
      null,
    ],
    [
      'catalog_entry_id, name the field’s',
      { catalog_entry_id: 'e1', nodeId: 'mail' },
      { e1: { name: 'mail' } },
      null,
    ],
    [
      'catalogEntryId, renamed',
      { catalogEntryId: 'e1', fieldKey: 'mail' },
      { e1: { name: 'urn:mail' } },
      RENAMED,
    ],
    [
      'catalog_entry_id, renamed',
      { catalog_entry_id: 'e1', path: 'mail' },
      { e1: { name: 'urn:mail' } },
      RENAMED,
    ],
    [
      'path before fieldKey',
      { path: 'uid', fieldKey: 'mail' },
      { mail: { name: 'urn:mail' } },
      null,
    ],
  ])('%s', async (_name, target, descriptors, expected) => {
    const result = await judged(target, descriptors);
    expect(result.swap).toBe(expected);
    // The two checks agree.
    expect(result.saved).toBe(expected !== null);
  });
});
