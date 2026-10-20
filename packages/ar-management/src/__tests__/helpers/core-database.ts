import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLiteDatabase } from '../test-sqlite';

/**
 * The real Core baseline on SQLite: `oauth_clients`, `identity_providers` and the platform's
 * `tenants` directory as the migration creates them. For tests that read the apps of a tenant (or
 * the list of tenants) the way production does.
 */
const REPO_ROOT = resolve(__dirname, '../../../../..');

export function openCoreDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      .replaceAll(
        '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
        "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)"
      )
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  // The baseline seeds the default tenant; the tests name their own.
  db.exec('DELETE FROM tenants');
  return db;
}

export function insertTenant(db: SQLiteDatabase, id: string): void {
  db.prepare(
    `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, `code-${id}`, `key-${id}`, `Tenant ${id}`);
}

/** An OIDC client; `identityMapping` is stored as the admin API stores it (JSON text) unless a string. */
export function insertOAuthClient(
  db: SQLiteDatabase,
  input: { tenantId: string; clientId: string; identityMapping?: unknown }
): void {
  const mapping =
    input.identityMapping === undefined
      ? null
      : typeof input.identityMapping === 'string'
        ? input.identityMapping
        : JSON.stringify(input.identityMapping);
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types,
       tenant_id, identity_mapping, created_at, updated_at)
     VALUES (?, ?, '[]', '[]', '[]', ?, ?, 1, 1)`
  ).run(input.clientId, `Client ${input.clientId}`, input.tenantId, mapping);
}

export function insertSamlProvider(
  db: SQLiteDatabase,
  input: { tenantId: string; id: string; providerType?: string; config: unknown }
): void {
  db.prepare(
    `INSERT INTO identity_providers (id, name, provider_type, config_json, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`
  ).run(
    input.id,
    `Provider ${input.id}`,
    input.providerType ?? 'saml_sp',
    typeof input.config === 'string' ? input.config : JSON.stringify(input.config),
    input.tenantId
  );
}
