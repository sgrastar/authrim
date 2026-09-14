import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';

// Phase 0 feasibility fixture, not the Phase 1 public streaming-bundle format or an API handler.
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const core = inventoryBackupSchemas(root).inspectedStreams.find(
  (stream) => stream.id === 'core-d1'
)!;
const tables = ['oauth_clients', 'roles', 'branding_settings'];
// Uses the manifest schema with DB-enforced non-null identities. This fixture is
// still only a limited module roundtrip, not complete tenant restore coverage.
const schemas: SnapshotTableSchema[] = tables.map((table) => {
  const metadata = core.tables.find((candidate) => candidate.name === table)!;
  const uniqueKeys = metadata.indexes
    .filter((index) => index.unique)
    .map((index) => {
      const columns = index.columns.filter((column) => column.key);
      if (columns.some((column) => column.name === null || column.collation !== 'BINARY')) {
        throw new Error(`spike_requires_specialized_index:${table}`);
      }
      // Ignoring a partial predicate captures a superset of possible conflicts, never a subset.
      return columns.map((column) => column.name!);
    });
  return {
    table,
    tenantColumn: 'tenant_id',
    columns: metadata.columns.filter((column) => !column.generated).map((column) => column.name),
    primaryKey: metadata.columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((column) => column.name),
    uniqueKeys,
  };
});

function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const migration of core.migrations) {
    db.exec('BEGIN');
    try {
      db.exec(
        renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

async function fixtureKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

describe('Phase 0 settings offline roundtrip feasibility', () => {
  it('restores real client/role/branding rows and an asset after discarding the source DB and key', async () => {
    const source = freshDatabase();
    const target = freshDatabase();
    let sourceKey: string | undefined = '11'.repeat(32);
    const targetKey = '22'.repeat(32);
    const passphrase = 'local-fixture-backup-passphrase';
    const logo = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>';
    const sourceAssets = new Map([['branding/logo.svg', logo]]);
    let sourceClosed = false;
    try {
      const secret = await encryptValue('fixture-webhook-secret', sourceKey, 'AES-256-GCM', 1);
      source
        .prepare(
          `INSERT INTO oauth_clients (
        client_id, tenant_id, client_name, redirect_uris, grant_types, response_types,
        created_at, updated_at, logout_webhook_secret_encrypted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'fixture-client',
          'tenant-a',
          'Original client',
          '["https://client.example/callback"]',
          '["authorization_code"]',
          '["code"]',
          1,
          1,
          secret.encrypted
        );
      source.exec(`INSERT INTO roles (id,tenant_id,name,permissions_json,created_at)
        VALUES ('fixture-parent','tenant-a','Parent','["profile:read"]',1);
        INSERT INTO roles (id,tenant_id,name,permissions_json,created_at,parent_role_id)
        VALUES ('fixture-child','tenant-a','Child','[]',1,'fixture-parent');
        INSERT INTO branding_settings (id,tenant_id,logo_url,updated_at)
        VALUES ('fixture-branding','tenant-a','https://issuer.example/branding/logo.svg',1);
        INSERT INTO roles (id,tenant_id,name,permissions_json,created_at)
        VALUES ('other-tenant-role','tenant-b','Private','[]',1);
        ${SQLITE_SNAPSHOT_SCHEMA}`);
      for (const schema of schemas) source.exec(sqliteSnapshotTriggers(schema));
      source.exec("INSERT INTO tenant_backup_snapshots VALUES ('s1','tenant-a','capturing')");
      source.exec(
        "UPDATE oauth_clients SET client_name = 'Changed during export' WHERE tenant_id = 'tenant-a'"
      );
      const records = schemas.map((schema) => ({
        table: schema.table,
        rows: source
          .prepare(sqliteSnapshotPageQuery(schema))
          .all('s1', 'tenant-a', '', 100)
          .map((row) => String(row.row_json)),
      }));
      // Resolve the source's at-rest encryption while the source key is still available.
      for (const entry of records) {
        if (entry.table !== 'oauth_clients') continue;
        entry.rows = await Promise.all(
          entry.rows.map(async (row) => {
            const fields = JSON.parse(row);
            fields.logout_webhook_secret_encrypted = [
              'text',
              (await decryptValue(fields.logout_webhook_secret_encrypted[1], sourceKey!)).decrypted,
            ];
            return JSON.stringify(fields);
          })
        );
      }
      const fixture = {
        kind: 'phase0-roundtrip-fixture',
        tenantId: 'tenant-a',
        records,
        assets: [...sourceAssets].map(([key, body]) => ({ key, body })),
      };
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await fixtureKey(passphrase, salt),
        new TextEncoder().encode(JSON.stringify(fixture))
      );
      expect(new TextDecoder().decode(ciphertext)).not.toContain('fixture-webhook-secret');
      source.close();
      sourceClosed = true;
      sourceKey = undefined;
      sourceAssets.clear();

      await expect(
        crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          await fixtureKey('wrong passphrase', salt),
          ciphertext
        )
      ).rejects.toThrow();
      const decoded = new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          await fixtureKey(passphrase, salt),
          ciphertext
        )
      );
      const restored: typeof fixture = JSON.parse(decoded);
      expect(restored.tenantId).toBe('tenant-a');
      const targetAssets = new Map(restored.assets.map((asset) => [asset.key, asset.body]));
      // Dependencies, not arbitrary archive order: restore the parent before its child.
      for (const entry of restored.records) {
        const schema = schemas.find((candidate) => candidate.table === entry.table)!;
        const rows =
          entry.table === 'roles'
            ? [...entry.rows].sort(
                (a, b) =>
                  Number(JSON.parse(a).parent_role_id[0] !== 'null') -
                  Number(JSON.parse(b).parent_role_id[0] !== 'null')
              )
            : entry.rows;
        for (const encoded of rows) {
          const fields = JSON.parse(encoded);
          if (fields.tenant_id[1] !== restored.tenantId) throw new Error('cross_tenant_fixture');
          if (entry.table === 'oauth_clients') {
            fields.logout_webhook_secret_encrypted = [
              'text',
              (
                await encryptValue(
                  fields.logout_webhook_secret_encrypted[1],
                  targetKey,
                  'AES-256-GCM',
                  2
                )
              ).encrypted,
            ];
          }
          const insert = sqliteSnapshotRowInsert(
            schema.table,
            schema.columns,
            JSON.stringify(fields)
          );
          target.prepare(insert.sql).run(...insert.params);
        }
      }
      expect(
        target.prepare("SELECT client_name FROM oauth_clients WHERE tenant_id = 'tenant-a'").get()
      ).toEqual({ client_name: 'Original client' });
      expect(
        target.prepare("SELECT parent_role_id FROM roles WHERE id = 'fixture-child'").get()
      ).toEqual({ parent_role_id: 'fixture-parent' });
      expect(
        target.prepare("SELECT count(*) AS n FROM roles WHERE tenant_id = 'tenant-b'").get()
      ).toEqual({ n: 0 });
      expect(targetAssets.get('branding/logo.svg')).toBe(logo);
      const stored = String(
        target
          .prepare(
            "SELECT logout_webhook_secret_encrypted AS value FROM oauth_clients WHERE tenant_id = 'tenant-a'"
          )
          .get()!.value
      );
      expect((await decryptValue(stored, targetKey)).decrypted).toBe('fixture-webhook-secret');
      expect(stored).not.toBe(secret.encrypted);
      expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      if (!sourceClosed) source.close();
      target.close();
    }
  });
});
