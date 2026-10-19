import { describe, expect, it } from 'vitest';
import {
  isReservedPlatformTenantId,
  PLATFORM_MAPPING_TENANT_ID,
  RuntimeIdentityMappingOwnerError,
} from '../identity-mapping-owner';
import {
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingResolutionContext,
} from '../identity-mapping-runtime-resolver';
import {
  addCatalogEntry,
  addEdge,
  openAdminDatabase,
  seedMapping,
  sqliteAdapter,
} from './identity-mapping-sqlite-fixture';

function context(
  overrides: Partial<RuntimeIdentityMappingResolutionContext> = {}
): RuntimeIdentityMappingResolutionContext {
  return {
    tenantId: 'tenant-a',
    protocol: 'oidc',
    role: 'op',
    clientId: 'client-1',
    partnerEntityId: 'client-1',
    ...overrides,
  };
}

describe('resolveRuntimeIdentityMappingBinding owner', () => {
  it('reads a platform-owned set for another tenant when the set is named', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });

    const binding = await resolveRuntimeIdentityMappingBinding(
      sqliteAdapter(db),
      context({ fieldMappingSetId: 'set-plat', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
    );

    expect(binding).toMatchObject({
      id: 'act-plat',
      tenantId: PLATFORM_MAPPING_TENANT_ID,
      fieldMappingSetId: 'set-plat',
      fieldMappingVersionId: 'ver-plat',
      mappingSnapshotHash: 'snapshot-plat',
      destinationProfileId: 'profile-plat',
    });
    expect(binding?.catalog.entries.map((entry) => entry.id)).toEqual(['field.profile.email.plat']);
    expect(binding?.edges.map((edge) => edge.id)).toEqual(['edge-plat-0']);
    expect(binding?.transforms.map((step) => step.id)).toEqual(['transform-plat']);
    expect(binding?.validationRules.map((rule) => rule.id)).toEqual(['validation-plat']);
    expect(binding?.fieldMappingSet.rules.map((rule) => rule.id)).toEqual(['rule-plat']);
  });

  it('reads every table under the owner, not under rows the calling tenant holds for the same version', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
    // Rows of the calling tenant that name the platform's version, catalog and rule. They are not
    // the platform set's, and must not be read for it.
    addCatalogEntry(db, 'tenant-a', 'catalog-plat', 'decoy-entry', 'field.decoy');
    db.prepare(
      `INSERT INTO mapping_rules (id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority, created_at, updated_at)
       VALUES ('decoy-rule', 'tenant-a', 'ver-plat', 'decoy', 'direct', 'deny', 0, 1, 1)`
    ).run();
    addEdge(db, 'tenant-a', 'decoy-rule', 'decoy-edge', 'profile-decoy');
    db.prepare(
      `INSERT INTO mapping_transform_steps (id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, created_at, updated_at)
       VALUES ('decoy-transform', 'tenant-a', 'decoy-rule', 'decoy-edge', 0, 'trim', '{}', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO mapping_validation_rules (id, tenant_id, rule_id, target_ref_json, validation_kind, severity, created_at, updated_at)
       VALUES ('decoy-validation', 'tenant-a', 'decoy-rule', '{"side":"destination","namespace":"oidc.claim","path":"x"}', 'required', 'error', 1, 1)`
    ).run();

    const binding = await resolveRuntimeIdentityMappingBinding(
      sqliteAdapter(db),
      context({ fieldMappingSetId: 'set-plat', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
    );

    expect(binding?.catalog.entries.map((entry) => entry.id)).toEqual(['field.profile.email.plat']);
    expect(binding?.edges.map((edge) => edge.id)).toEqual(['edge-plat-0']);
    expect(binding?.transforms.map((step) => step.id)).toEqual(['transform-plat']);
    expect(binding?.validationRules.map((rule) => rule.id)).toEqual(['validation-plat']);
    expect(binding?.fieldMappingSet.rules.map((rule) => rule.id)).toEqual(['rule-plat']);
  });

  it('finds the stored default canonical catalog of the owner for a virtual catalog version', async () => {
    const db = openAdminDatabase();
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'plat',
      catalogVersionId: 'system_default_canonical_catalog_schema_v1',
    });
    // Nothing is stored under the virtual version itself; the stored default catalog is the
    // platform's, and the calling tenant's own default catalog is not the one to use.
    db.prepare(`DELETE FROM field_catalog_entries`).run();
    db.prepare(
      `INSERT INTO field_catalogs (id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at)
       VALUES ('system_default_canonical_catalog', 'platform', 'canonical', 'Canonical', 'active', 1, 1),
              ('system_default_canonical_catalog_a', 'tenant-a', 'canonical', 'Canonical', 'active', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO field_catalog_versions (id, tenant_id, catalog_id, version_label, bundle_hash, lifecycle_state, created_at, updated_at)
       VALUES ('stored-platform', 'platform', 'system_default_canonical_catalog', 'v2', 'h', 'active', 1, 1),
              ('stored-tenant', 'tenant-a', 'system_default_canonical_catalog', 'v2', 'h', 'active', 2, 2)`
    ).run();
    addCatalogEntry(db, 'platform', 'stored-platform', 'e-platform', 'field.platform');
    addCatalogEntry(db, 'tenant-a', 'stored-tenant', 'e-tenant', 'field.tenant');

    const binding = await resolveRuntimeIdentityMappingBinding(
      sqliteAdapter(db),
      context({
        fieldMappingSetId: 'set-plat',
        ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
        resolveCanonicalCatalog: true,
      })
    );

    expect(binding?.catalog.entries.map((entry) => entry.id)).toEqual(['field.platform']);
  });

  it('matches the activation scope against the calling tenant, not the owner', async () => {
    const db = openAdminDatabase();
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'plat',
      scope: { kind: 'tenant', tenantId: 'tenant-b' },
    });
    const adapter = sqliteAdapter(db);

    await expect(
      resolveRuntimeIdentityMappingBinding(
        adapter,
        context({ fieldMappingSetId: 'set-plat', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
      )
    ).resolves.toBeNull();
    await expect(
      resolveRuntimeIdentityMappingBinding(
        adapter,
        context({
          tenantId: 'tenant-b',
          fieldMappingSetId: 'set-plat',
          ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
        })
      )
    ).resolves.toMatchObject({ id: 'act-plat' });
  });

  it('never reads a set another tenant owns, whatever owner is given', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-b', id: 'other' });
    const adapter = sqliteAdapter(db);

    await expect(
      resolveRuntimeIdentityMappingBinding(
        adapter,
        context({ fieldMappingSetId: 'set-other', ownerTenantId: 'tenant-b' })
      )
    ).rejects.toBeInstanceOf(RuntimeIdentityMappingOwnerError);
    // Naming the platform does not reach tenant-b's rows either: they are not under that owner.
    await expect(
      resolveRuntimeIdentityMappingBinding(
        adapter,
        context({ fieldMappingSetId: 'set-other', ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
      )
    ).resolves.toBeNull();
    // Without an owner the calling tenant's own rows are all there is.
    await expect(
      resolveRuntimeIdentityMappingBinding(adapter, context({ fieldMappingSetId: 'set-other' }))
    ).resolves.toBeNull();
  });

  it.each(['', 'Platform', ' platform', 'platform ', 'default'])(
    'refuses the owner %j',
    async (ownerTenantId) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });

      await expect(
        resolveRuntimeIdentityMappingBinding(
          sqliteAdapter(db),
          context({ fieldMappingSetId: 'set-plat', ownerTenantId })
        )
      ).rejects.toBeInstanceOf(RuntimeIdentityMappingOwnerError);
    }
  );

  it('takes the calling tenant as the owner when it names itself', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'own' });

    await expect(
      resolveRuntimeIdentityMappingBinding(
        sqliteAdapter(db),
        context({ fieldMappingSetId: 'set-own', ownerTenantId: 'tenant-a' })
      )
    ).resolves.toMatchObject({ id: 'act-own', tenantId: 'tenant-a' });
  });

  it('refuses an owner without a Mapping Set ID, so the platform is never searched', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
    const adapter = sqliteAdapter(db);

    await expect(
      resolveRuntimeIdentityMappingBinding(
        adapter,
        context({ ownerTenantId: PLATFORM_MAPPING_TENANT_ID })
      )
    ).rejects.toBeInstanceOf(RuntimeIdentityMappingOwnerError);
    await expect(
      resolveRuntimeIdentityMappingBinding(adapter, context({ ownerTenantId: 'tenant-a' }))
    ).rejects.toBeInstanceOf(RuntimeIdentityMappingOwnerError);
  });

  it('does not offer a platform tenant-wide activation to a call that names no set', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat', scope: { kind: 'tenant' } });
    seedMapping(db, { owner: 'tenant-a', id: 'own', scope: { kind: 'tenant' } });
    const adapter = sqliteAdapter(db);

    // The tenant's own activation is the only candidate, as before.
    await expect(resolveRuntimeIdentityMappingBinding(adapter, context())).resolves.toMatchObject({
      id: 'act-own',
      tenantId: 'tenant-a',
    });
    // A tenant with no activation of its own gets none, rather than the platform's.
    await expect(
      resolveRuntimeIdentityMappingBinding(adapter, context({ tenantId: 'tenant-c' }))
    ).resolves.toBeNull();
  });

  it('is unchanged for a call without an owner', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'own' });
    seedMapping(db, { owner: 'tenant-b', id: 'theirs' });
    const adapter = sqliteAdapter(db);

    const binding = await resolveRuntimeIdentityMappingBinding(adapter, context());

    expect(binding).toMatchObject({
      id: 'act-own',
      tenantId: 'tenant-a',
      fieldMappingSetId: 'set-own',
    });
    expect(binding?.edges.map((edge) => edge.id)).toEqual(['edge-own-0']);
    await expect(
      resolveRuntimeIdentityMappingBinding(adapter, context({ fieldMappingSetId: 'set-theirs' }))
    ).resolves.toBeNull();
  });
});

describe('isReservedPlatformTenantId', () => {
  it.each(['platform', 'Platform', 'PLATFORM', ' platform', 'platform ', '\tplatform\n'])(
    'reserves %j',
    (value) => {
      expect(isReservedPlatformTenantId(value)).toBe(true);
    }
  );

  it.each(['platform-eu', 'my-platform', 'platform2', 'default', ''])('allows %j', (value) => {
    expect(isReservedPlatformTenantId(value)).toBe(false);
  });
});
