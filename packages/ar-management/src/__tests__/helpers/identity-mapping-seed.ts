import type { SQLiteDatabase } from '../test-sqlite';

/**
 * Rows for one Mapping Set that is ready to be named as a default: the set, an active version,
 * an active activation, an active compiled snapshot over a one-field catalog, and one rule that
 * releases `authrim.profile.email` into `oidc.claim.email` of the Destination Profile
 * `profile-<id>` (see `seedDestinationProfile`). Written straight into the Admin schema, so a test
 * can break one part of it and see which check notices.
 */
export interface SeedMappingInput {
  /** The tenant ID that owns the set and every row under it (`platform` for the platform's). */
  owner: string;
  /** Names every row; the set's ID is `set-<id>`. */
  id: string;
  scope?: unknown;
  /** Destination Profile IDs the edges name (default: `profile-<id>`). */
  profiles?: string[];
}

export function seedMapping(db: SQLiteDatabase, input: SeedMappingInput): string {
  const { owner, id } = input;
  const catalogVersionId = `catalog-${id}`;
  const run = (sql: string, ...params: Array<string | number | null>) =>
    db.prepare(sql).run(...params);
  run(
    `INSERT INTO field_mapping_sets (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, 1)`,
    `set-${id}`,
    owner,
    `key-${id}`,
    `Set ${id}`
  );
  run(
    `INSERT INTO field_mapping_versions (id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'v1', 'active', 'hash', 1, 1)`,
    `ver-${id}`,
    owner,
    `set-${id}`
  );
  run(
    `INSERT INTO field_mapping_activations (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json, lifecycle_state, activated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 100, 100, 100)`,
    `act-${id}`,
    owner,
    `set-${id}`,
    `ver-${id}`,
    JSON.stringify(input.scope ?? {})
  );
  run(
    `INSERT INTO compiled_mapping_snapshots (id, tenant_id, field_mapping_version_id, catalog_version_id, snapshot_hash, lifecycle_state, compiled_at)
     VALUES (?, ?, ?, ?, ?, 'active', 1)`,
    `snap-${id}`,
    owner,
    `ver-${id}`,
    catalogVersionId,
    `snapshot-${id}`
  );
  run(
    `INSERT INTO field_catalogs (id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, 1)`,
    `catalog-def-${id}`,
    owner,
    `catalog-key-${id}`,
    `Catalog ${id}`
  );
  run(
    `INSERT INTO field_catalog_versions (id, tenant_id, catalog_id, version_label, bundle_hash, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, 'v1', ?, 'active', 1, 1)`,
    catalogVersionId,
    owner,
    `catalog-def-${id}`,
    `bundle-${id}`
  );
  run(
    `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, classification, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'authrim.profile', 'email', 'canonical', 'string', 'pii', 1, 1)`,
    `entry-${id}`,
    owner,
    catalogVersionId,
    `field.profile.email.${id}`
  );
  run(
    `INSERT INTO mapping_rules (id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'rule', 'direct', 'allow', 0, 1, 1)`,
    `rule-${id}`,
    owner,
    `ver-${id}`
  );
  (input.profiles ?? [`profile-${id}`]).forEach((profileId, index) => {
    run(
      `INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'direct', 0, 1, 1)`,
      `edge-${id}-${index}`,
      owner,
      `rule-${id}`,
      JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'email' }),
      JSON.stringify({ side: 'destination', profileId, namespace: 'oidc.claim', path: 'email' })
    );
  });
  return `set-${id}`;
}

export function seedDestinationProfile(
  db: SQLiteDatabase,
  input: { owner: string; id: string; destinationType?: string }
): void {
  const type = input.destinationType ?? 'oidc';
  db.prepare(
    `INSERT INTO destination_profiles (id, tenant_id, destination_type, profile_key, display_name, owner_scope_type, lifecycle_state, active_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, 1)`
  ).run(
    input.id,
    input.owner,
    type,
    `key-${input.id}`,
    `Profile ${input.id}`,
    input.owner === 'platform' ? 'platform' : 'tenant',
    `${input.id}-v1`
  );
  db.prepare(
    `INSERT INTO destination_profile_versions (id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json, validation_summary_json, warning_summary_json, release_impact_json, created_at, updated_at)
     VALUES (?, ?, ?, 'v1', 'active', 'hash', ?, '{}', '{}', '{}', 1, 1)`
  ).run(
    `${input.id}-v1`,
    input.owner,
    input.id,
    JSON.stringify({
      destinationType: type,
      claims: [
        {
          claimName: 'email',
          surfaces: ['id_token', 'userinfo'],
          requiredScopes: ['email'],
          classification: 'pii',
        },
      ],
    })
  );
}
