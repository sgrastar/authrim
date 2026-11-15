import {
  equivalentMappingSnapshotHashes,
  runtimeMappingSnapshotMatches,
} from '@authrim/ar-lib-core/services/mapping-snapshot-equivalence';
import {
  hashCredentialProfileSnapshot,
  type CredentialProfileSnapshot,
} from '@authrim/ar-lib-core/services/credential-profile-snapshot';
import { mappingGraphMigrationStatements } from '@authrim/ar-lib-core/services/mapping-graph-migration';
import { splitMigrationSql } from '@authrim/ar-lib-core/services/control-plane/migration-sql';
import { createHash } from 'node:crypto';
import { canonicalMappingGraphJson } from '@authrim/ar-lib-core/services/mapping-graph-snapshot';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mappingGraphMigrationSuffix } from '../core/mapping-graph-migration';
import { mappingGraphMaterialSql } from '@authrim/ar-lib-core/services/mapping-graph-snapshot';

const migration = readFileSync(
  new URL('../../../../migrations/admin/d1/023_mapping_rule_graph.sql', import.meta.url),
  'utf8'
);
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE field_mapping_versions (id TEXT,tenant_id TEXT,field_mapping_set_id TEXT,field_mapping_hash TEXT);
    CREATE TABLE field_catalog_versions (id TEXT,tenant_id TEXT,bundle_hash TEXT);
    CREATE TABLE mapping_rules (id TEXT PRIMARY KEY,tenant_id TEXT,field_mapping_version_id TEXT,priority INTEGER,created_at INTEGER);
    CREATE TABLE mapping_rule_edges (id TEXT PRIMARY KEY,tenant_id TEXT,rule_id TEXT,source_ref_json TEXT,target_ref_json TEXT,edge_kind TEXT,display_order INTEGER);
    CREATE TABLE mapping_transform_steps (id TEXT PRIMARY KEY,tenant_id TEXT,rule_id TEXT,edge_id TEXT,step_order INTEGER,operation TEXT,parameters_json TEXT,created_at INTEGER,updated_at INTEGER,target_ref_json TEXT);
    CREATE TABLE mapping_conflict_rules (tenant_id TEXT,field_mapping_version_id TEXT,target_ref_json TEXT);
    CREATE TABLE compiled_mapping_snapshots (id TEXT,tenant_id TEXT,field_mapping_version_id TEXT,catalog_version_id TEXT,compatibility_range TEXT,snapshot_hash TEXT,artifact_ref TEXT,metadata_json TEXT,lifecycle_state TEXT);
    CREATE TABLE dependency_graph_snapshots (id TEXT,tenant_id TEXT,field_mapping_version_id TEXT,snapshot_hash TEXT,graph_json TEXT,created_at INTEGER);
    CREATE TABLE credential_profile_versions (id TEXT,tenant_id TEXT,credential_profile_id TEXT,version_number INTEGER,
      credential_configuration_id TEXT,issuance_flow_version_id TEXT,verification_flow_version_id TEXT,
      issuance_mapping_set_id TEXT,issuance_mapping_version_id TEXT,issuance_mapping_snapshot_hash TEXT,
      verification_mapping_set_id TEXT,verification_mapping_version_id TEXT,verification_mapping_snapshot_hash TEXT,
      claim_allowlist_json TEXT,offer_ttl_seconds INTEGER,maximum_attribute_age_seconds INTEGER,
      transaction_code_required INTEGER,snapshot_hash TEXT,lifecycle_state TEXT);
    INSERT INTO field_mapping_versions VALUES ('v','tenant','set','old');
    INSERT INTO field_catalog_versions VALUES ('catalog','tenant','catalog-hash');
    INSERT INTO mapping_rules VALUES ('rule','tenant','v',0,1);
    INSERT INTO mapping_rule_edges VALUES ('edge','tenant','rule','{"side":"source","namespace":"csv","path":"email"}','{"side":"destination","namespace":"oidc.claim","path":"email"}','direct',0);
    INSERT INTO compiled_mapping_snapshots VALUES ('snapshot','tenant','v','catalog','*','old','old-artifact','{}','active');`);
  return db;
}

const profileContract: CredentialProfileSnapshot = {
  profileId: 'profile',
  versionNumber: 1,
  credentialConfigurationId: 'AgeCredential',
  issuanceFlowVersionId: 'issue-flow',
  verificationFlowVersionId: 'verify-flow',
  issuanceMappingVersionId: 'v',
  issuanceMappingSnapshotHash: 'old',
  verificationMappingVersionId: 'v',
  verificationMappingSnapshotHash: 'old',
  claimAllowlist: ['age_over_18'],
  offerTtlSeconds: 300,
  maximumAttributeAgeSeconds: 3600,
  transactionCodeRequired: false,
};
async function seedProfile(db: DatabaseSync) {
  const hash = await hashCredentialProfileSnapshot(profileContract);
  db.prepare(
    `INSERT INTO credential_profile_versions VALUES ('profile-v','tenant','profile',1,
    'AgeCredential','issue-flow','verify-flow','set','v','old','set','v','old',
    '["age_over_18"]',300,3600,0,?,'published')`
  ).run(hash);
  return hash;
}

describe('023 mapping graph migration on SQLite', () => {
  it('migrates a legacy step, recompiles and preserves activation; graph material matches future compile', async () => {
    const db = database();
    db.exec(
      "INSERT INTO mapping_transform_steps VALUES ('step','tenant','rule','edge',0,'trim','{}',1,1,NULL)"
    );
    const before = db.prepare(mappingGraphMaterialSql(true)).get();
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`BEGIN;${migration}\n${suffix}\nCOMMIT;`);
    expect(db.prepare(mappingGraphMaterialSql()).get()).toEqual(before);
    expect(db.prepare('SELECT output_edge_id,output_step_id FROM mapping_rules').get()).toEqual({
      output_edge_id: null,
      output_step_id: 'step',
    });
    expect(db.prepare('SELECT * FROM mapping_transform_step_inputs').get()).toMatchObject({
      edge_id: 'edge',
      position: 0,
      input_step_id: null,
    });
    expect(db.prepare('SELECT * FROM compiled_mapping_snapshots').get()).toMatchObject({
      lifecycle_state: 'active',
      artifact_ref: null,
    });
    expect(
      db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
    ).not.toBe('old');
    const materialRow = db.prepare(mappingGraphMaterialSql()).get();
    const material: unknown = JSON.parse(String(materialRow?.graph_json));
    const expectedHash = createHash('sha256')
      .update(
        canonicalMappingGraphJson({
          type: 'compiled_mapping_snapshot',
          dependencyGraph: {
            fieldMappingVersionId: 'v',
            fieldMappingHash: 'old',
            catalogVersionId: 'catalog',
            catalogHash: 'catalog-hash',
            trustContextSnapshotId: null,
            mappingGraph: material,
          },
          compatibilityRange: '*',
        })
      )
      .digest('hex');
    expect(
      db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
    ).toBe(expectedHash);

    expect(
      db
        .prepare('PRAGMA table_info(mapping_transform_steps)')
        .all()
        .map((row) => row.name)
    ).not.toContain('edge_id');
    db.close();
  });
  it('migrates a direct output and a generating identifier target', async () => {
    const db = database();
    db.exec(`INSERT INTO mapping_rules VALUES ('identifier','tenant','v',1,1);
      INSERT INTO mapping_transform_steps VALUES ('identifier-step','tenant','identifier',NULL,0,'persistent_identifier','{}',1,1,'{"side":"destination","namespace":"oidc.claim","path":"sub"}');`);
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`${migration}\n${suffix}`);
    expect(
      db.prepare("SELECT output_edge_id FROM mapping_rules WHERE id='rule'").get()?.output_edge_id
    ).toBe('edge');
    expect(
      db
        .prepare("SELECT output_step_id,target_ref_json FROM mapping_rules WHERE id='identifier'")
        .get()
    ).toMatchObject({
      output_step_id: 'identifier-step',
      target_ref_json: '{"side":"destination","namespace":"oidc.claim","path":"sub"}',
    });
    expect(db.prepare('SELECT * FROM mapping_transform_step_inputs').all()).toHaveLength(0);
    db.close();
  });
  it('refuses multi-target rules with the full inventory before mutation and in raw SQL', async () => {
    const db = database();
    db.exec(
      `INSERT INTO mapping_rule_edges SELECT 'other',tenant_id,rule_id,source_ref_json,'{"namespace":"oidc.claim","path":"name"}',edge_kind,1 FROM mapping_rule_edges;`
    );
    await expect(
      mappingGraphMigrationSuffix(migration, async (sql) => db.prepare(sql).all())
    ).rejects.toThrow('"tenant_id":"tenant","set_id":"set","version_id":"v","rule_id":"rule"');
    expect(() => db.exec(migration)).toThrow(/tenant.*set.*v.*rule/);
    expect(
      db
        .prepare('PRAGMA table_info(mapping_rules)')
        .all()
        .map((row) => row.name)
    ).not.toContain('output_step_id');
    db.close();
  });
  it('refuses all conflict-policy writers with both rule IDs', async () => {
    const db = database();
    db.exec(`INSERT INTO mapping_rules VALUES ('other-rule','tenant','v',1,1);
      INSERT INTO mapping_rule_edges SELECT 'other-edge',tenant_id,'other-rule',source_ref_json,target_ref_json,edge_kind,1 FROM mapping_rule_edges;
      INSERT INTO mapping_conflict_rules SELECT 'tenant','v',target_ref_json FROM mapping_rule_edges LIMIT 1;`);
    await expect(
      mappingGraphMigrationSuffix(migration, async (sql) => db.prepare(sql).all())
    ).rejects.toThrow(/rule.*other-rule/);
    db.close();
  });

  it('aborts the transaction when graph contents change after preflight', async () => {
    const db = database();
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(
      `UPDATE mapping_rule_edges SET source_ref_json='{"namespace":"csv","path":"changed"}'; BEGIN;`
    );
    expect(() => db.exec(`${migration}\n${suffix}`)).toThrow('integer overflow');
    db.exec('ROLLBACK');
    expect(
      db
        .prepare('PRAGMA table_info(mapping_rules)')
        .all()
        .map((row) => row.name)
    ).not.toContain('output_step_id');
    expect(
      db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
    ).toBe('old');
    db.close();
  });
  it('preserves Core DB evidence through atomically stored snapshot equivalence', async () => {
    const db = database();
    const core = new DatabaseSync(':memory:');
    core.exec(`CREATE TABLE attribute_verifications (tenant_id TEXT,mapping_version_id TEXT,mapping_snapshot_hash TEXT,invalidated_at INTEGER);
      INSERT INTO attribute_verifications VALUES ('tenant','v','old',NULL);`);
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`BEGIN;${migration}\n${suffix}\nCOMMIT;`);
    const snapshot = db
      .prepare('SELECT snapshot_hash,metadata_json FROM compiled_mapping_snapshots')
      .get();
    if (typeof snapshot?.snapshot_hash !== 'string' || typeof snapshot.metadata_json !== 'string')
      throw new Error('snapshot missing');
    const evidence = core.prepare('SELECT * FROM attribute_verifications').get();
    if (typeof evidence?.mapping_snapshot_hash !== 'string') throw new Error('evidence missing');
    expect(
      runtimeMappingSnapshotMatches(
        {
          mappingSnapshotHash: snapshot.snapshot_hash,
          equivalentMappingSnapshotHashes: equivalentMappingSnapshotHashes(
            snapshot.metadata_json,
            snapshot.snapshot_hash
          ),
        },
        evidence.mapping_snapshot_hash
      )
    ).toBe(true);
    expect(evidence.invalidated_at).toBeNull();
    expect(evidence.mapping_snapshot_hash).toBe('old');
    core.close();
    db.close();
  });

  it('rolls back the equivalence record with snapshots when a snapshot changes after preflight', async () => {
    const db = database();
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec("UPDATE compiled_mapping_snapshots SET snapshot_hash='concurrent'; BEGIN;");
    expect(() => db.exec(`${migration}\n${suffix}`)).toThrow('integer overflow');
    db.exec('ROLLBACK');
    expect(
      db.prepare('SELECT snapshot_hash,metadata_json FROM compiled_mapping_snapshots').get()
    ).toEqual({ snapshot_hash: 'concurrent', metadata_json: '{}' });
    db.close();
  });

  it('refuses ambiguous old-to-new hashes even without a pinned profile', async () => {
    const db = database();
    db.exec(
      "INSERT INTO compiled_mapping_snapshots SELECT 'other',tenant_id,field_mapping_version_id,catalog_version_id,'different',snapshot_hash,artifact_ref,metadata_json,lifecycle_state FROM compiled_mapping_snapshots"
    );
    await expect(
      mappingGraphMigrationSuffix(migration, async (sql) => db.prepare(sql).all())
    ).rejects.toThrow(/ambiguous snapshot equivalence.*tenant.*set.*v.*snapshot/);
    expect(
      db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
    ).toBe('old');
    db.close();
  });

  it('updates both pinned mapping hashes and the published profile contract atomically', async () => {
    const db = database();
    const oldHash = await seedProfile(db);
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`BEGIN;${migration}\n${suffix}\nCOMMIT;`);
    const hash = db
      .prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots')
      .get()?.snapshot_hash;
    expect(typeof hash).toBe('string');
    if (typeof hash !== 'string') throw new Error('snapshot missing');
    const expected = createHash('sha256')
      .update(
        canonicalMappingGraphJson({
          ...profileContract,
          issuanceMappingSnapshotHash: hash,
          verificationMappingSnapshotHash: hash,
        })
      )
      .digest('base64url');
    expect(
      db
        .prepare(
          'SELECT issuance_mapping_snapshot_hash,verification_mapping_snapshot_hash,snapshot_hash,lifecycle_state FROM credential_profile_versions'
        )
        .get()
    ).toEqual({
      issuance_mapping_snapshot_hash: hash,
      verification_mapping_snapshot_hash: hash,
      snapshot_hash: expected,
      lifecycle_state: 'published',
    });
    expect(expected).not.toBe(oldHash);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='__mapping_graph_023_payloads'").get()
    ).toBeUndefined();
    db.close();
  });

  it.each(['missing', 'ambiguous'])(
    'refuses %s profile pins with the full profile inventory before mutation',
    async (scenario) => {
      const db = database();
      await seedProfile(db);
      if (scenario === 'missing')
        db.exec(
          "UPDATE credential_profile_versions SET issuance_mapping_snapshot_hash='unavailable'"
        );
      else
        db.exec(
          "INSERT INTO compiled_mapping_snapshots SELECT 'other',tenant_id,field_mapping_version_id,catalog_version_id,'different',snapshot_hash,artifact_ref,metadata_json,lifecycle_state FROM compiled_mapping_snapshots"
        );
      await expect(
        mappingGraphMigrationSuffix(migration, async (sql) => db.prepare(sql).all())
      ).rejects.toThrow(/tenant.*profile.*profile-v.*mapping_pin_missing_or_ambiguous/);
      expect(
        db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
      ).toBe('old');
      expect(
        db
          .prepare('PRAGMA table_info(mapping_rules)')
          .all()
          .map((row) => row.name)
      ).not.toContain('output_step_id');
      db.close();
    }
  );

  it('rolls schema and snapshot changes back if a pinned profile changes after preflight', async () => {
    const db = database();
    await seedProfile(db);
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec('UPDATE credential_profile_versions SET offer_ttl_seconds=600; BEGIN;');
    expect(() => db.exec(`${migration}\n${suffix}`)).toThrow('integer overflow');
    db.exec('ROLLBACK');
    expect(
      db.prepare('SELECT snapshot_hash FROM compiled_mapping_snapshots').get()?.snapshot_hash
    ).toBe('old');
    db.close();
  });

  it.each([
    ['fieldKey', 'nodeId'],
    ['nodeId', 'path'],
    ['path', 'fieldKey'],
  ])('compares %s and %s spellings using runtime path fallback', async (left, right) => {
    const db = database();
    const ref = (key: string, value: string) =>
      JSON.stringify({ namespace: 'oidc.claim', path: '', [key]: value });
    db.prepare('UPDATE mapping_rule_edges SET target_ref_json=?').run(ref(left, 'email'));
    db.prepare(
      "INSERT INTO mapping_transform_steps VALUES ('step','tenant','rule','edge',0,'trim','{}',1,1,?)"
    ).run(ref(right, 'email'));
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`${migration}\n${suffix}`);
    expect(db.prepare('SELECT output_step_id FROM mapping_rules').get()?.output_step_id).toBe(
      'step'
    );
    db.close();
  });

  it('does not conflate different alias-only targets under a conflict policy', async () => {
    const db = database();
    db.exec(`UPDATE mapping_rule_edges SET target_ref_json='{"namespace":"oidc.claim","fieldKey":"email"}';
      INSERT INTO mapping_rules VALUES ('other-rule','tenant','v',1,1);
      INSERT INTO mapping_rule_edges SELECT 'other-edge',tenant_id,'other-rule',source_ref_json,'{"namespace":"oidc.claim","nodeId":"name"}',edge_kind,1 FROM mapping_rule_edges;
      INSERT INTO mapping_conflict_rules VALUES ('tenant','v','{"namespace":"oidc.claim","fieldKey":"email"}');`);
    const suffix = await mappingGraphMigrationSuffix(migration, async (sql) =>
      db.prepare(sql).all()
    );
    db.exec(`${migration}\n${suffix}`);
    expect(db.prepare('SELECT * FROM mapping_rules').all()).toHaveLength(2);
    db.close();
  });

  it('refuses mixed alias spellings of the same competing target in preflight and SQL', async () => {
    const db = database();
    db.exec(`UPDATE mapping_rule_edges SET target_ref_json='{"namespace":"oidc.claim","fieldKey":"email"}';
      INSERT INTO mapping_rules VALUES ('other-rule','tenant','v',1,1);
      INSERT INTO mapping_rule_edges SELECT 'other-edge',tenant_id,'other-rule',source_ref_json,'{"namespace":"oidc.claim","nodeId":"email"}',edge_kind,1 FROM mapping_rule_edges;
      INSERT INTO mapping_conflict_rules VALUES ('tenant','v','{"namespace":"oidc.claim","path":"email"}');`);
    await expect(
      mappingGraphMigrationSuffix(migration, async (sql) => db.prepare(sql).all())
    ).rejects.toThrow(/rule.*other-rule/);
    expect(() => db.exec(migration)).toThrow(/rule.*other-rule/);
    db.close();
  });

  it('keeps every statement below 100 KB for near-128 KiB Unicode and quoted graph data', async () => {
    const db = database();
    const parameters = JSON.stringify({ prefix: "'😀".repeat(24000) });
    expect(new TextEncoder().encode(parameters).byteLength).toBeGreaterThan(100000);
    expect(new TextEncoder().encode(parameters).byteLength).toBeLessThan(128 * 1024);
    db.prepare(
      "INSERT INTO mapping_transform_steps VALUES ('step','tenant','rule','edge',0,'affix_text',?,1,1,NULL)"
    ).run(parameters);
    const statements = await mappingGraphMigrationStatements(migration, async (sql) =>
      db.prepare(sql).all()
    );
    for (const statement of statements) {
      expect(new TextEncoder().encode(statement).byteLength).toBeLessThan(100000);
      expect(splitMigrationSql(statement)).toHaveLength(1);
    }
    db.exec('BEGIN');
    for (const statement of [...splitMigrationSql(migration), ...statements]) db.exec(statement);
    db.exec('COMMIT');
    expect(
      db.prepare('SELECT parameters_json FROM mapping_transform_steps').get()?.parameters_json
    ).toBe(parameters);
    const graph = db.prepare('SELECT graph_json FROM dependency_graph_snapshots').get()?.graph_json;
    expect(typeof graph).toBe('string');
    if (typeof graph !== 'string') throw new Error('dependency graph missing');
    expect(canonicalMappingGraphJson(JSON.parse(graph))).toContain('😀');
    expect(graph).toContain("'😀");
    db.close();
  });
});
