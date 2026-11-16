import { describe, expect, it, vi } from 'vitest';
import { resolveRuntimeIdentityMappingBinding, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { handleCreateProvider, handleUpdateProvider } from '@authrim/ar-saml/admin-providers';
import { TENANT } from './helpers/admin-authority-fixture';
import { setup } from './helpers/saml-facade-fixture';

const PROVIDERS = '/api/admin/resolver-saml-providers';
const VIRTUAL_CATALOG = 'system_default_canonical_catalog_schema_v1';
type Fixture = Awaited<ReturnType<typeof setup>>;

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Only request routing, receipts and audit delivery are substituted. Mapping resolution,
    // catalog reads and all provider persistence use the real implementations and SQLite.
    createAuthContextFromHono: (c: { env: { DB_CORE: DatabaseAdapter } }) => ({
      coreAdapter: c.env.DB_CORE,
    }),
    resolveAuthCorePersistenceAdapterFromEnv: async (env: { DB_CORE: DatabaseAdapter }) =>
      env.DB_CORE,
    requireAdminStepUp: vi.fn(async () => null),
    createAuditLog: vi.fn(async () => undefined),
    createAuditLogFromContext: vi.fn(async () => undefined),
  };
});

async function fixture() {
  const t = await setup();
  t.app.post(PROVIDERS, handleCreateProvider);
  t.app.put(`${PROVIDERS}/:id`, handleUpdateProvider);
  const set = await t.create();
  return { ...t, set };
}

function inputRule(
  t: Fixture,
  versionId: string,
  target: Record<string, unknown>,
  id = 'canonical-input'
) {
  t.db
    .prepare(
      `INSERT INTO mapping_rules
      (id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority,
       target_ref_json, output_edge_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'direct', 'allow', 0, ?, ?, 1, 1)`
    )
    .run(id, TENANT, versionId, id, JSON.stringify(target), `${id}-edge`);
  t.db
    .prepare(
      `INSERT INTO mapping_rule_edges
      (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'direct', 0, 1, 1)`
    )
    .run(
      `${id}-edge`,
      TENANT,
      id,
      JSON.stringify({ side: 'source', namespace: 'scim.attribute', path: 'userName' }),
      JSON.stringify(target)
    );
  t.db
    .prepare('UPDATE mapping_rules SET output_edge_id = ? WHERE tenant_id = ? AND id = ?')
    .run(`${id}-edge`, TENANT, id);
}

async function save(t: Awaited<ReturnType<typeof fixture>>, operation: string) {
  const config = t.config(t.set.id);
  if (operation === 'create') {
    return t.call('POST', PROVIDERS, { name: 'Resolver SP', providerType: 'saml_sp', config });
  }
  t.bind(t.set.id, 'resolver-existing-sp');
  return t.call('PUT', `${PROVIDERS}/resolver-existing-sp`, {
    expectedUpdatedAt: new Date(1).toISOString(),
    config,
  });
}

function resolve(t: Awaited<ReturnType<typeof fixture>>, canonical = true) {
  return resolveRuntimeIdentityMappingBinding(t.adapter, {
    tenantId: TENANT,
    protocol: 'saml',
    role: 'idp',
    fieldMappingSetId: t.set.id,
    resolveCanonicalCatalog: canonical,
    includeStoredProfileTargets: true,
  });
}

describe.each(['create', 'update'])(
  'SAML SP %s through the stored mapping resolver',
  (operation) => {
    it('loads the virtual canonical catalog and supplements the tenant custom field definitions', async () => {
      const t = await fixture();
      t.db
        .prepare(
          `INSERT INTO field_catalogs
        (id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at)
       VALUES ('system_default_canonical_catalog', ?, 'default-canonical', 'Canonical', 'active', 1, 1)`
        )
        .run(TENANT);
      t.db
        .prepare(
          `INSERT INTO field_catalog_versions
        (id, tenant_id, catalog_id, version_label, bundle_hash, lifecycle_state, created_at, updated_at)
       VALUES ('stored-canonical-v1', ?, 'system_default_canonical_catalog', 'v1', 'hash', 'active', 1, 1)`
        )
        .run(TENANT);
      t.db
        .prepare(
          `INSERT INTO field_catalog_entries
        (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
         value_type, classification, created_at, updated_at)
       VALUES ('stored-username', ?, 'stored-canonical-v1', 'field.canonical.preferred_username',
         'authrim.canonical', 'preferred_username', 'canonical', 'string', 'internal', 1, 1)`
        )
        .run(TENANT);
      t.core
        .prepare(
          `INSERT INTO custom_claim_schemas
        (id, tenant_id, field_key, active_field_key, display_label, field_type, is_pii,
         is_active, operation_status, created_at, updated_at)
       VALUES ('employee-schema', ?, 'employee_code', 'employee_code', 'Employee code',
         'string', 0, 1, 'active', 1, 1)`
        )
        .run(TENANT);
      t.db
        .prepare(
          'UPDATE compiled_mapping_snapshots SET catalog_version_id = ? WHERE field_mapping_version_id = ?'
        )
        .run(VIRTUAL_CATALOG, t.set.version_id);
      inputRule(t, t.set.version_id, {
        side: 'destination',
        namespace: 'authrim.profile',
        path: 'preferred_username',
        catalogEntryId: 'field.canonical.preferred_username',
      });
      inputRule(
        t,
        t.set.version_id,
        {
          side: 'destination',
          namespace: 'authrim.canonical',
          path: 'employee_code',
          catalogEntryId: 'field.canonical.employee_code',
        },
        'custom-input'
      );
      expect((await resolve(t, false))?.catalog.entries).toEqual([]);
      expect((await resolve(t))?.catalog.entries).toEqual([
        expect.objectContaining({ id: 'field.canonical.preferred_username' }),
      ]);
      const result = await save(t, operation);
      expect(result.status, JSON.stringify(result.json)).toBe(operation === 'create' ? 201 : 200);
    });

    it.each([
      {
        namespace: 'authrim.custom_fields',
        path: 'employee_code',
        catalogEntryId: 'custom.employee_code',
      },
      { namespace: 'custom_fields', path: 'employeeCode' },
      {
        namespace: 'custom_fields',
        fieldKey: 'employeeCode',
        catalog_entry_id: 'custom.employee_code',
      },
    ])('accepts a stored custom canonical target $namespace with its ID or alias', async (ref) => {
      const t = await fixture();
      const binding = await resolve(t);
      if (!binding) throw new Error('Expected active fixture binding');
      t.db
        .prepare(
          `INSERT INTO field_catalog_entries
        (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
         value_type, classification, aliases_json, created_at, updated_at)
       VALUES ('custom-entry', ?, ?, 'custom.employee_code', 'authrim.custom_fields',
         'employee_code', 'canonical', 'string', 'internal', ?, 1, 1)`
        )
        .run(
          TENANT,
          binding.catalog.identity.id,
          JSON.stringify([{ namespace: 'custom_fields', path: 'employeeCode' }])
        );
      inputRule(t, t.set.version_id, { side: 'destination', ...ref });
      const result = await save(t, operation);
      expect(result.status, JSON.stringify(result.json)).toBe(operation === 'create' ? 201 : 200);
    });

    it.each(['oidc.claim', 'unknown.output'])(
      'rejects a stored %s output even when it borrows a canonical catalog ID',
      async (namespace) => {
        const t = await fixture();
        inputRule(t, t.set.version_id, {
          side: 'destination',
          namespace,
          path: 'email',
          catalogEntryId: 'field.email',
        });
        expect((await resolve(t))?.destinationProfileIds).toEqual(['saml-profile']);
        const result = await save(t, operation);
        expect(result.status, JSON.stringify(result.json)).toBe(400);
      }
    );

    describe.each(['profileId', 'profile_id'])('a stored %s reference', (spelling) => {
      it.each(['rule', 'edge'])(
        'rejects a canonical target tagged as a Destination Profile in the %s',
        async (location) => {
          const t = await fixture();
          const target = { side: 'destination', namespace: 'authrim.profile', path: 'email' };
          inputRule(t, t.set.version_id, target);
          const tagged = JSON.stringify({ ...target, [spelling]: 'saml-profile' });
          if (location === 'rule') {
            t.db
              .prepare('UPDATE mapping_rules SET target_ref_json = ? WHERE id = ?')
              .run(tagged, 'canonical-input');
          } else {
            t.db
              .prepare('UPDATE mapping_rule_edges SET target_ref_json = ? WHERE id = ?')
              .run(tagged, 'canonical-input-edge');
          }
          const binding = await resolve(t);
          expect(binding?.destinationProfileIds).toEqual(['saml-profile']);
          // Executable FieldRefs stay unchanged. The independent stored-target view must retain
          // what normalization would otherwise erase, whether the profile is on a rule or an edge.
          const input = binding?.graphRules?.find((rule) => rule.id === 'canonical-input');
          expect(input?.targetRef).not.toHaveProperty('profileId');
          expect(input?.targetRef).not.toHaveProperty('profile_id');
          expect(binding?.storedProfileTargets).toContainEqual(
            expect.objectContaining({
              namespace: 'authrim.profile',
              path: 'email',
              profileId: 'saml-profile',
            })
          );
          const result = await save(t, operation);
          expect(result.status, JSON.stringify(result.json)).toBe(400);
          expect(
            await t.adapter.queryOne(
              'SELECT id FROM field_mapping_sets WHERE tenant_id = ? AND id = ?',
              [TENANT, t.set.id]
            )
          ).not.toBeNull();
          const saved = t.core
            .prepare('SELECT config_json FROM identity_providers WHERE tenant_id = ?')
            .all(TENANT);
          expect(saved).toHaveLength(operation === 'create' ? 0 : 1);
        }
      );
    });
  }
);
