import { canonicalMappingGraphJson, mappingGraphMaterialSql } from './mapping-graph-snapshot';

import { z } from 'zod';
import {
  mappingGraphProfileUpdates,
  pinnedCredentialProfilesSql,
} from './mapping-graph-migration-profiles';

const graphRow = z.object({
  tenant_id: z.string(),
  version_id: z.string(),
  graph_json: z.string(),
});
const snapshotRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  field_mapping_version_id: z.string(),
  field_mapping_hash: z.string(),
  field_mapping_set_id: z.string(),
  snapshot_hash: z.string(),
  catalog_version_id: z.string(),
  bundle_hash: z.string(),
  compatibility_range: z.string().nullable(),
});
export type MappingGraphMigrationQuery = (sql: string) => Promise<Record<string, unknown>[]>;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const hash = async (value: unknown) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalMappingGraphJson(value))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Compute recompilation SQL before 023; append it before migration history is committed. */
export async function mappingGraphMigrationStatements(
  sourceSql: string,
  query: MappingGraphMigrationQuery
): Promise<string[]> {
  const end = sourceSql.indexOf('DROP VIEW __mapping_graph_refusals;');
  const guard = sourceSql.slice(
    sourceSql.indexOf('SELECT r.tenant_id'),
    sourceSql.indexOf('\n\nSELECT CASE')
  );
  if (end < 0 || !guard) throw new Error('mapping_graph_migration_guard_missing');
  const refused = await query(guard);
  if (refused.length)
    throw new Error(
      `Mapping graph migration refused (tenant, set, version, rule): ${JSON.stringify(refused)}`
    );
  const graphs = (await query(mappingGraphMaterialSql(true))).map((row) => graphRow.parse(row));
  const snapshots = (
    await query(`SELECT s.id,s.tenant_id,s.field_mapping_version_id,s.catalog_version_id,s.compatibility_range,
    v.field_mapping_hash,v.field_mapping_set_id,s.snapshot_hash,COALESCE(c.bundle_hash,
      (SELECT json_extract(d.graph_json,'$.catalogHash') FROM dependency_graph_snapshots d
       WHERE d.tenant_id=s.tenant_id AND d.field_mapping_version_id=s.field_mapping_version_id
       ORDER BY d.created_at DESC LIMIT 1)) AS bundle_hash FROM compiled_mapping_snapshots s
    JOIN field_mapping_versions v ON v.tenant_id=s.tenant_id AND v.id=s.field_mapping_version_id
    LEFT JOIN field_catalog_versions c ON c.tenant_id=s.tenant_id AND c.id=s.catalog_version_id`)
  ).map((row) => snapshotRow.parse(row));
  const statements: string[] = [
    'CREATE TABLE __mapping_graph_023_payloads (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    `SELECT CASE WHEN (SELECT count(*) FROM field_mapping_versions)=${graphs.length}
      AND (SELECT count(*) FROM compiled_mapping_snapshots)=${snapshots.length}
      THEN 0 ELSE abs(-9223372036854775807 - 1) END AS mapping_graph_migration_concurrent_write;`,
  ];
  let payloadId = 0;
  // Bound SQL literals by Unicode code points: escaping quotes and UTF-8 never approach 100 KB.
  const payload = (value: string): string => {
    const id = payloadId++;
    const characters = Array.from(value);
    statements.push(`INSERT INTO __mapping_graph_023_payloads VALUES (${id}, '');`);
    for (let offset = 0; offset < characters.length; offset += 4000) {
      statements.push(
        `UPDATE __mapping_graph_023_payloads SET value=value || ${quote(characters.slice(offset, offset + 4000).join(''))} WHERE id=${id};`
      );
    }
    return `(SELECT value FROM __mapping_graph_023_payloads WHERE id=${id})`;
  };
  for (const graph of graphs) {
    const expected = payload(graph.graph_json);
    statements.push(`SELECT CASE WHEN (SELECT graph_json FROM (${mappingGraphMaterialSql()})
      WHERE tenant_id=${quote(graph.tenant_id)} AND version_id=${quote(graph.version_id)})=${expected}
      THEN 0 ELSE abs(-9223372036854775807 - 1) END AS mapping_graph_migration_concurrent_write;`);
  }
  const recompiled: Array<z.infer<typeof snapshotRow> & { newHash: string }> = [];
  for (const snapshot of snapshots) {
    const graph = graphs.find(
      (row) =>
        row.tenant_id === snapshot.tenant_id && row.version_id === snapshot.field_mapping_version_id
    );
    if (!graph) throw new Error('mapping_graph_migration_snapshot_graph_missing');
    const material: unknown = JSON.parse(graph.graph_json);
    const dependencyGraph = {
      fieldMappingVersionId: snapshot.field_mapping_version_id,
      fieldMappingHash: snapshot.field_mapping_hash,
      catalogVersionId: snapshot.catalog_version_id,
      catalogHash: snapshot.bundle_hash,
      trustContextSnapshotId: null,
      mappingGraph: material,
    };
    const snapshotHash = await hash({
      type: 'compiled_mapping_snapshot',
      dependencyGraph,
      compatibilityRange: snapshot.compatibility_range,
    });
    recompiled.push({ ...snapshot, newHash: snapshotHash });
    // Existing snapshot/activation IDs remain stable. Updating their content in the migration
    // transaction recompiles all historical versions and reactivates the same selected versions.
    statements.push(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compiled_mapping_snapshots
      WHERE tenant_id=${quote(snapshot.tenant_id)} AND id=${quote(snapshot.id)} AND snapshot_hash=${quote(snapshot.snapshot_hash)})
      THEN 0 ELSE abs(-9223372036854775807 - 1) END AS mapping_graph_migration_concurrent_snapshot_write;`);
    statements.push(`UPDATE compiled_mapping_snapshots SET snapshot_hash=${quote(snapshotHash)}, artifact_ref=NULL,
      metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.graphSchemaVersion',1,
        '$.graphMigration023',json(${quote(JSON.stringify({ previousSnapshotHash: snapshot.snapshot_hash, snapshotHash }))}))
      WHERE tenant_id=${quote(snapshot.tenant_id)} AND id=${quote(snapshot.id)};`);
    const dependencyId = `graph_023_${snapshot.id}`;
    statements.push(`INSERT INTO dependency_graph_snapshots (id,tenant_id,field_mapping_version_id,snapshot_hash,graph_json,created_at)
      VALUES (${quote(dependencyId)},${quote(snapshot.tenant_id)},${quote(snapshot.field_mapping_version_id)},${quote(await hash(dependencyGraph))},${payload(canonicalMappingGraphJson(dependencyGraph))},unixepoch()*1000);`);
    statements.push(
      `UPDATE compiled_mapping_snapshots SET metadata_json=json_set(metadata_json,'$.dependencyGraphId',${quote(dependencyId)}) WHERE tenant_id=${quote(snapshot.tenant_id)} AND id=${quote(snapshot.id)};`
    );
  }
  const profiles = await query(pinnedCredentialProfilesSql);
  statements.push(...(await mappingGraphProfileUpdates(profiles, recompiled)));
  const ambiguous = recompiled.filter((snapshot) =>
    recompiled.some(
      (other) =>
        other.tenant_id === snapshot.tenant_id &&
        other.field_mapping_version_id === snapshot.field_mapping_version_id &&
        other.snapshot_hash === snapshot.snapshot_hash &&
        other.newHash !== snapshot.newHash
    )
  );
  if (ambiguous.length)
    throw new Error(
      `Mapping graph migration refused ambiguous snapshot equivalence: ${JSON.stringify(
        ambiguous.map((snapshot) => ({
          tenant_id: snapshot.tenant_id,
          set_id: snapshot.field_mapping_set_id,
          version_id: snapshot.field_mapping_version_id,
          snapshot_id: snapshot.id,
          previous_snapshot_hash: snapshot.snapshot_hash,
        }))
      )}`
    );
  statements.push('DROP TABLE __mapping_graph_023_payloads;');
  return statements;
}

/** Setup's SQL-file runner uses the same bounded statements as the D1 batch runner. */
export async function mappingGraphMigrationSuffix(
  sourceSql: string,
  query: MappingGraphMigrationQuery
): Promise<string> {
  return (await mappingGraphMigrationStatements(sourceSql, query)).join('\n');
}
