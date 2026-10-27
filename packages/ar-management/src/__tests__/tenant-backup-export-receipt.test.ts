import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantBackupRequestIntent } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { readTenantBackupExportReceipt } from '../tenant-backup-export-receipt';

const opened: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(count = 2) {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  db.exec(`
    CREATE TABLE tenant_backup_operations(id TEXT,tenant_id TEXT,kind TEXT,state TEXT,phase TEXT,request_digest TEXT);
    CREATE TABLE tenant_backup_publications(operation_id TEXT,tenant_id TEXT,attempt_id TEXT,published_at INTEGER,expires_at INTEGER);
    CREATE TABLE tenant_backup_artifact_attempts(id TEXT,tenant_id TEXT,operation_id TEXT,state TEXT,part_count INTEGER,byte_count INTEGER);
    CREATE TABLE tenant_backup_export_manifests(attempt_id TEXT,manifest_json TEXT,manifest_sha256 TEXT);
    CREATE TABLE tenant_backup_execution_inventories(operation_id TEXT,tenant_id TEXT,request_digest TEXT,state TEXT,chain_digest TEXT);
    CREATE TABLE tenant_backup_artifact_parts(attempt_id TEXT,tenant_id TEXT,ordinal INTEGER,byte_count INTEGER,sha256 TEXT,uploaded INTEGER);
    INSERT INTO tenant_backup_operations VALUES('operation-a','tenant-a','export','ready','export_complete','request-a');
    INSERT INTO tenant_backup_publications VALUES('operation-a','tenant-a','attempt-a',100,1000);
  `);
  const intent: TenantBackupRequestIntent = {
    version: 1,
    kind: 'export',
    inputs: [],
    source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
  };
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId: 'a'.repeat(32),
    source: intent.source,
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 99,
    inventoryDigestSha256: 'b'.repeat(64),
    selection: intent.selection,
    datasets: [
      {
        id: 'core.users',
        module: 'users',
        kind: 'users',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  function saveManifest() {
    db.exec('DELETE FROM tenant_backup_export_manifests');
    const json = JSON.stringify(manifest);
    db.prepare('INSERT INTO tenant_backup_export_manifests VALUES(?,?,?)').run(
      'attempt-a',
      json,
      hash(json)
    );
  }
  saveManifest();
  db.prepare('INSERT INTO tenant_backup_execution_inventories VALUES(?,?,?,?,?)').run(
    'operation-a',
    'tenant-a',
    'request-a',
    'sealed',
    manifest.inventoryDigestSha256
  );
  db.prepare('INSERT INTO tenant_backup_artifact_attempts VALUES(?,?,?,?,?,?)').run(
    'attempt-a',
    'tenant-a',
    'operation-a',
    'sealed',
    count,
    count * 7
  );
  for (let ordinal = 0; ordinal < count; ordinal++)
    db.prepare('INSERT INTO tenant_backup_artifact_parts VALUES(?,?,?,?,?,?)').run(
      'attempt-a',
      'tenant-a',
      ordinal,
      7,
      hash(String(ordinal)),
      1
    );
  const queryCalls = vi.fn();
  const database: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
    async query<T>(sql: string, params?: unknown[]) {
      queryCalls(sql, params);
      return db.prepare(sql).all(...((params ?? []) as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params?: unknown[]) {
      return (db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) ?? null) as T | null;
    },
  };
  const input = {
    database,
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    intent,
    now: () => 200,
    signal: new AbortController().signal,
  };
  return {
    db,
    database,
    queryCalls,
    input,
    intent,
    manifest,
    saveManifest,
    read: () => readTenantBackupExportReceipt(input),
  };
}

describe('authenticated publication receipt metadata', () => {
  it('uses sealed server metadata with exact ordered concatenated download boundaries and bounded pages', async () => {
    const f = fixture(130);
    const receipt = await f.read();
    expect(receipt.receipt.parts).toEqual(
      Array.from({ length: 130 }, (_, i) => ({ size: 7, sha256: hash(String(i)) }))
    );
    expect(receipt).toMatchObject({
      formatVersion: 1,
      operationId: 'operation-a',
      expiresAt: 1000,
      byteCount: 910,
      boundaryUnixMs: 99,
      selection: f.intent.selection,
      datasets: f.manifest.datasets,
      receipt: { source: f.intent.source, bundleId: f.manifest.bundleId },
    });
    expect(f.queryCalls).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(receipt)).not.toMatch(/attempt-a|request-a|object_key|manifest_json/);
  });
  it.each([
    "UPDATE tenant_backup_operations SET state='running'",
    "UPDATE tenant_backup_operations SET phase='prepare'",
    'UPDATE tenant_backup_publications SET expires_at=200',
    'UPDATE tenant_backup_publications SET published_at=201',
    "UPDATE tenant_backup_artifact_attempts SET state='writing'",
    "UPDATE tenant_backup_artifact_attempts SET operation_id='other-operation'",
    "UPDATE tenant_backup_execution_inventories SET state='building'",
    "UPDATE tenant_backup_execution_inventories SET request_digest='other-request'",
    "UPDATE tenant_backup_execution_inventories SET chain_digest='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
    "UPDATE tenant_backup_export_manifests SET manifest_sha256='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
    'UPDATE tenant_backup_artifact_parts SET uploaded=0 WHERE ordinal=0',
    'DELETE FROM tenant_backup_artifact_parts WHERE ordinal=0',
    'UPDATE tenant_backup_artifact_parts SET ordinal=9 WHERE ordinal=1',
    'UPDATE tenant_backup_artifact_parts SET byte_count=6 WHERE ordinal=1',
    'INSERT INTO tenant_backup_artifact_parts SELECT attempt_id,tenant_id,2,byte_count,sha256,uploaded FROM tenant_backup_artifact_parts WHERE ordinal=1',
  ])('rejects unavailable, altered or incomplete publication: %s', async (sql) => {
    const f = fixture();
    f.db.exec(sql);
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['tenant', 'issuer', 'selection', 'boundary'] as const)(
    'rejects manifest mismatch: %s',
    async (kind) => {
      const f = fixture();
      f.manifest = structuredClone(f.manifest); // mutate the persisted document below, not the authorized request
      if (kind === 'tenant') f.manifest.source.tenantId = 'tenant-b';
      if (kind === 'issuer') f.manifest.source.issuer = 'https://other.example.test';
      if (kind === 'selection') f.manifest.selection.admin = true;
      if (kind === 'boundary') f.manifest.boundaryUnixMs = 201;
      const json = JSON.stringify(f.manifest);
      f.db
        .prepare('UPDATE tenant_backup_export_manifests SET manifest_json=?,manifest_sha256=?')
        .run(json, hash(json));
      await expect(f.read()).rejects.toThrow();
    }
  );
  it('rejects cross-tenant requests and expiry between pages', async () => {
    const f = fixture(130);
    f.input.tenantId = 'tenant-b';
    await expect(f.read()).rejects.toThrow();
    f.input.tenantId = 'tenant-a';
    const query = f.database.query.bind(f.database);
    f.database.query = async <T>(sql: string, params?: unknown[]) => {
      const result = await query<T>(sql, params);
      f.db.exec('UPDATE tenant_backup_publications SET expires_at=200');
      return result;
    };
    await expect(f.read()).rejects.toThrow();
  });
});
