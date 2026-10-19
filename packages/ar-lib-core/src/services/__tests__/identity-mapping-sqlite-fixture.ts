import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

/**
 * The real Admin baseline on an in-memory SQLite, with the few rows a Mapping Set needs to be
 * resolved. Used to check which tenant ID each query of the resolver reads under: a mock that
 * ignores the SQL cannot tell.
 */
export function openAdminDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec(
    renderPortableMigrationSql(
      readFileSync(
        new URL('../../../../../migrations/admin/d1/001_0_4_0_admin_baseline.sql', import.meta.url),
        'utf8'
      ),
      'sqlite'
    )
  );
  return db;
}

export function sqliteAdapter(db: DatabaseSync): DatabaseAdapter {
  const bind = (params: unknown[] = []) => params.map((value) => value ?? null);
  return {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...bind(params)) ?? null,
  } as unknown as DatabaseAdapter;
}

export interface SeedMappingInput {
  /** The tenant ID that owns the set and every row under it. */
  owner: string;
  /** Names every row; two seeds with the same id would collide. */
  id: string;
  scope?: unknown;
  setState?: string;
  activationState?: string;
  catalogVersionId?: string;
  /** Destination Profile IDs the edges name (default: one). */
  profiles?: string[];
}

/** One set, version, activation, snapshot, catalog, rule, edge, transform and validation rule. */
export function seedMapping(db: DatabaseSync, input: SeedMappingInput): void {
  const { owner, id } = input;
  const catalogVersionId = input.catalogVersionId ?? `catalog-${id}`;
  const run = (sql: string, ...params: Array<string | number | null>) =>
    db.prepare(sql).run(...params);
  run(
    `INSERT INTO field_mapping_sets (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
    `set-${id}`,
    owner,
    `key-${id}`,
    `Set ${id}`,
    input.setState ?? 'active'
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
     VALUES (?, ?, ?, ?, ?, ?, 100, 100, 100)`,
    `act-${id}`,
    owner,
    `set-${id}`,
    `ver-${id}`,
    JSON.stringify(input.scope ?? { kind: 'tenant' }),
    input.activationState ?? 'active'
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
  addCatalogEntry(db, owner, catalogVersionId, `entry-${id}`, `field.profile.email.${id}`);
  run(
    `INSERT INTO mapping_rules (id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'rule', 'direct', 'allow', 0, 1, 1)`,
    `rule-${id}`,
    owner,
    `ver-${id}`
  );
  (input.profiles ?? [`profile-${id}`]).forEach((profileId, index) => {
    addEdge(db, owner, `rule-${id}`, `edge-${id}-${index}`, profileId);
  });
  run(
    `INSERT INTO mapping_transform_steps (id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'trim', '{}', 1, 1)`,
    `transform-${id}`,
    owner,
    `rule-${id}`,
    `edge-${id}-0`
  );
  run(
    `INSERT INTO mapping_validation_rules (id, tenant_id, rule_id, target_ref_json, validation_kind, severity, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'required', 'error', 1, 1)`,
    `validation-${id}`,
    owner,
    `rule-${id}`,
    JSON.stringify({ side: 'destination', namespace: 'oidc.claim', path: 'email' })
  );
}

export function addCatalogEntry(
  db: DatabaseSync,
  owner: string,
  catalogVersionId: string,
  entryId: string,
  stableFieldId: string
): void {
  db.prepare(
    `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, classification, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'authrim.profile', 'email', 'canonical', 'string', 'pii', 1, 1)`
  ).run(entryId, owner, catalogVersionId, stableFieldId);
}

export function addEdge(
  db: DatabaseSync,
  owner: string,
  ruleId: string,
  edgeId: string,
  profileId: string
): void {
  db.prepare(
    `INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'direct', 0, 1, 1)`
  ).run(
    edgeId,
    owner,
    ruleId,
    JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'email' }),
    JSON.stringify({
      side: 'destination',
      profileId,
      namespace: 'oidc.claim',
      path: 'email',
    })
  );
}
