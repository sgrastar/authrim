import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export const MAX_SEED_ACCOUNTS = 500;
export const MAX_VERIFICATION_ACCOUNTS = 10000;
export const DEFAULT_METADATA_BYTES = 768;
export const TENANT_ID = 'default';
const BASE_TIME = 1792108800;

/** A single current core shard, with PII remaining in a different, unmeasured database. */
export const profile = {
  name: 'authrim-current-core-shard',
  stream: 'core-d1',
  tenantId: TENANT_ID,
  scope: 'One core shard; canonical PII/admin/control/lookup streams are not combined into it.',
  pii: 'users_core points to benchmark-pii-out-of-scope; no users_pii records or PII DB are created.',
  populatedTables: [
    'users_core',
    'identity_subjects',
    'identity_accounts',
    'subject_account_links',
    'passkeys',
    'role_assignments',
    'oauth_client_consents',
    'sessions',
    'user_token_families',
  ],
  triggerPopulatedTables: [
    'account_webhook_outbox',
    'service_group_inputs',
    'account_legal_hold_states',
  ],
  staticTables: ['roles', 'oauth_clients'],
  metadata: 'Three real metadata_json fields per account; each has a random hexadecimal value.',
  metadataHexCharactersPerField: DEFAULT_METADATA_BYTES,
  passkeysPerAccount: 'One primary plus one secondary for every fourth account.',
  limitations: [
    'Synthetic storage distribution, not a replay of real Authrim traffic or user data.',
    'Passkey material is synthetic storage data and cannot authenticate.',
    'No PII data or external storage is included; this measures a core-shard dump only.',
    'Hexadecimal metadata has four bits of entropy per output byte.',
    'Canonical legacy users table is retained in the schema but remains unpopulated.',
  ],
};

// Keep these substitutions identical to src/migrations/sql-portability.ts. Schema guards
// in the canonical primary-key migration compare the rendered default expressions exactly.
function renderSql(sql) {
  return sql
    .replaceAll(
      '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
      "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
    )
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

export async function loadSchema() {
  const root = new URL('../../migrations/', import.meta.url);
  const manifestBytes = await readFile(new URL('release-manifest.draft.json', root));
  const manifest = JSON.parse(manifestBytes);
  const stream = manifest.streams.find((entry) => entry.id === 'core-d1');
  assert.ok(stream && stream.files.length > 0, 'Current draft is missing the core-d1 stream.');
  const migrations = [];
  for (const entry of stream.files) {
    assert.match(entry.path, /^[a-zA-Z0-9_.-]+\.sql$/);
    const source = await readFile(new URL(`core/d1/${entry.path}`, root), 'utf8');
    const sql = renderSql(source);
    const checksum = createHash('sha256').update(sql).digest('hex');
    assert.equal(checksum, entry.checksum, `Draft checksum mismatch: core-d1/${entry.path}`);
    migrations.push({ path: `migrations/core/d1/${entry.path}`, checksum, sql });
  }
  return {
    profile: {
      ...profile,
      productVersion: manifest.productVersion,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      migrationFiles: migrations.map(({ path, checksum }) => ({ path, checksum })),
    },
    migrations,
    schemaSql: migrations.map((entry) => entry.sql).join('\n'),
  };
}

/**
 * Apply canonical migrations locally, then serialize their exact final schema and
 * reference rows for a NEW empty D1. This avoids replaying table-rebuild migrations
 * through D1's import API. Never apply this fresh schema to an existing environment.
 * schemaStatements must be applied as one transaction/batch with deferred FKs.
 */
export async function compileSchema() {
  const loaded = await loadSchema();
  const database = new DatabaseSync(':memory:');
  try {
    for (const migration of loaded.migrations) database.exec(migration.sql);
    database.exec(bootstrapSql);
    const objects = database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1
           WHEN 'index' THEN 2 ELSE 3 END, name`
      )
      .all();
    const tables = objects.filter((object) => object.type === 'table');
    const statements = ['PRAGMA defer_foreign_keys = ON;'];
    statements.push(...tables.map((table) => `${table.sql};`));
    for (const table of tables) {
      const columns = database
        .prepare(`PRAGMA table_xinfo(${literal(table.name)})`)
        .all()
        .filter((column) => column.hidden === 0)
        .map((column) => column.name);
      const columnSql = columns.map(identifier).join(', ');
      for (const row of database
        .prepare(`SELECT ${columnSql} FROM ${identifier(table.name)}`)
        .all()) {
        statements.push(
          `INSERT INTO ${identifier(table.name)} (${columnSql}) VALUES (${columns
            .map((column) => literal(row[column]))
            .join(', ')});`
        );
      }
    }
    statements.push(...objects.filter((object) => object.type !== 'table').map((o) => `${o.sql};`));
    statements.push('PRAGMA defer_foreign_keys = OFF;');
    assert.ok(statements.every((sql) => Buffer.byteLength(sql) <= 100000));
    const baseCounts = {};
    for (const table of verifiedTables) {
      baseCounts[table.name] = database
        .prepare(`SELECT COUNT(*) AS count FROM ${identifier(table.name)}`)
        .get().count;
    }
    return {
      ...loaded,
      profile: {
        ...loaded.profile,
        tableCount: tables.length,
        indexCount: database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index'")
          .get().count,
        triggerCount: objects.filter((object) => object.type === 'trigger').length,
        baseCounts,
      },
      schemaSql: statements.join('\n'),
      schemaStatements: statements,
    };
  } finally {
    database.close();
  }
}

/**
 * Provision a NEW empty D1 through independent REST query batches. Create every
 * table and index before reference data, order reference inserts by their real FK
 * dependencies, and install triggers last. Every batch can commit independently;
 * this plan does not rely on FK deferral surviving a bulk import's internal chunks.
 * Persist the complete plan before applying it so runtime-generated seed values
 * remain identical when resuming. Do not blindly retry an ambiguous DDL outcome.
 */
export function schemaProvisioningBatches(compiled, { batchSize = 32 } = {}) {
  assert.ok(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 512);
  assert.ok(Array.isArray(compiled.schemaStatements));
  const tables = [];
  const views = [];
  const indexes = [];
  const triggers = [];
  const insertsByTable = new Map();
  for (const sql of compiled.schemaStatements) {
    if (/^CREATE TABLE\b/.test(sql)) tables.push(sql);
    else if (/^CREATE VIEW\b/.test(sql)) views.push(sql);
    else if (/^CREATE (?:UNIQUE )?INDEX\b/.test(sql)) indexes.push(sql);
    else if (/^CREATE TRIGGER\b/.test(sql)) triggers.push(sql);
    else if (/^INSERT INTO\b/.test(sql)) {
      const match = /^INSERT INTO "((?:[^"]|"")+)"\s/.exec(sql);
      assert.ok(match, 'Expected a quoted compiled reference-data table name.');
      const name = match[1].replaceAll('""', '"');
      if (!insertsByTable.has(name)) insertsByTable.set(name, []);
      insertsByTable.get(name).push(sql);
    } else {
      assert.match(sql, /^PRAGMA defer_foreign_keys = (?:ON|OFF);$/);
    }
  }

  const database = new DatabaseSync(':memory:');
  const inserts = [];
  try {
    for (const sql of tables) database.exec(sql);
    const visited = new Set();
    const visiting = new Set();
    const visit = (table) => {
      if (visited.has(table)) return;
      assert.ok(!visiting.has(table), `Reference-data FK dependency cycle: ${table}`);
      visiting.add(table);
      const parents = database.prepare(`PRAGMA foreign_key_list(${literal(table)})`).all();
      for (const parent of new Set(parents.map((foreignKey) => foreignKey.table))) {
        // Preserve canonical row order for self-referencing data such as roles.
        if (parent !== table && insertsByTable.has(parent)) visit(parent);
      }
      visiting.delete(table);
      visited.add(table);
      inserts.push(...insertsByTable.get(table));
    };
    for (const table of insertsByTable.keys()) visit(table);
  } finally {
    database.close();
  }

  const batches = [];
  for (const phase of [tables, views, indexes, inserts, triggers]) {
    for (let offset = 0; offset < phase.length; offset += batchSize) {
      const batch = phase.slice(offset, offset + batchSize);
      assert.ok(batch.every((sql) => Buffer.byteLength(sql) <= 100000));
      assert.ok(
        Buffer.byteLength(JSON.stringify({ batch: batch.map((sql) => ({ sql })) })) <= 4 * 1024 ** 2
      );
      batches.push(batch);
    }
  }
  return batches;
}

export const bootstrapSql = `
CREATE TABLE bench_probe (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  writes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bench_probe (id, writes, updated_at) VALUES (1, 0, 0);
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
INSERT OR IGNORE INTO roles
  (id, tenant_id, name, permissions_json, role_type, display_name, created_at, updated_at)
SELECT 'bench-role-' || i, 'default', 'benchmark-role-' || i,
  '["profile:read","application:access"]', 'custom', 'Benchmark role ' || i,
  ${BASE_TIME}, ${BASE_TIME} FROM n;
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
INSERT OR IGNORE INTO oauth_clients
  (client_id, tenant_id, client_name, redirect_uris, grant_types, response_types,
   scope, token_endpoint_auth_method, require_pkce, created_at, updated_at)
SELECT 'bench-client-' || i, 'default', 'Synthetic application ' || i,
  '["https://benchmark.invalid/callback"]', '["authorization_code","refresh_token"]',
  '["code"]', 'openid profile email offline_access', 'none', 1,
  ${BASE_TIME}, ${BASE_TIME} FROM n;
`.trim();

export function seedSql(startId, accountCount, { metadataBytes = DEFAULT_METADATA_BYTES } = {}) {
  requireRange(startId, accountCount, MAX_SEED_ACCOUNTS);
  assert.ok(
    Number.isSafeInteger(metadataBytes) && metadataBytes >= 0 && metadataBytes <= 4096,
    'metadataBytes must be an integer from 0 to 4096.'
  );
  const cte = `WITH RECURSIVE n(i) AS (SELECT ${startId} UNION ALL
    SELECT i + 1 FROM n WHERE i < ${startId + accountCount - 1})`;
  const key = (prefix) => `'bench-${prefix}-' || printf('%012d', i)`;
  const user = key('user');
  const subject = key('subject');
  const account = key('account');
  const metadata = `json_object('source', 'synthetic-benchmark', 'department',
    'department-' || (i % 32), 'application_context',
    substr(hex(randomblob(${Math.max(1, Math.ceil(metadataBytes / 2))})), 1, ${metadataBytes}))`;
  const timestamp = `${BASE_TIME} + i`;
  const statements = [
    `${cte} INSERT OR IGNORE INTO users_core
      (id, tenant_id, email_verified, email_domain_hash, is_active, user_type,
       pii_partition, pii_status, status, lifecycle_state, created_at, updated_at, last_login_at)
      SELECT ${user}, 'default', 1, lower(hex(randomblob(32))), 1, 'end_user',
       'benchmark-pii-out-of-scope', 'active', 'active', 'active',
       ${timestamp}, ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO identity_subjects
      (id, tenant_id, subject_type, lifecycle_state, display_label, primary_account_id,
       assurance_level, metadata_json, created_at, updated_at)
      SELECT ${subject}, 'default', 'person', 'active', 'Synthetic person ' || i,
       ${account}, 'aal2', ${metadata}, ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO identity_accounts
      (id, tenant_id, account_type, lifecycle_state, legacy_user_id, primary_subject_id,
       display_label, metadata_json, directory_publication_state, registration_state,
       created_at, updated_at)
      SELECT ${account}, 'default', 'user', 'active', ${user}, ${subject},
       'Synthetic account ' || i, ${metadata}, 'active', 'registered',
       ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO subject_account_links
      (id, tenant_id, subject_id, account_id, link_type, created_at, updated_at)
      SELECT ${key('link')}, 'default', ${subject}, ${account}, 'primary',
       ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO passkeys
      (id, tenant_id, user_id, credential_id, public_key, counter, transports,
       device_name, aaguid, rp_id, created_at, last_used_at)
      SELECT 'bench-passkey-' || printf('%012d', i) || '-1', 'default', ${user},
       lower(hex(randomblob(32))), lower(hex(randomblob(77))), i % 128,
       '["internal","hybrid"]', 'Synthetic platform authenticator',
       '00000000-0000-0000-0000-000000000000', 'benchmark.invalid',
       ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO passkeys
      (id, tenant_id, user_id, credential_id, public_key, counter, transports,
       device_name, aaguid, rp_id, created_at, last_used_at)
      SELECT 'bench-passkey-' || printf('%012d', i) || '-2', 'default', ${user},
       lower(hex(randomblob(32))), lower(hex(randomblob(77))), i % 64,
       '["usb","nfc"]', 'Synthetic security key',
       '00000000-0000-0000-0000-000000000000', 'benchmark.invalid',
       ${timestamp}, ${timestamp} FROM n WHERE i % 4 = 0;`,
    `${cte} INSERT OR IGNORE INTO role_assignments
      (id, tenant_id, subject_id, role_id, scope_type, scope_target, assigned_by,
       metadata_json, created_at, updated_at)
      SELECT ${key('assignment')}, 'default', ${user}, 'bench-role-' || (i % 4),
       'global', '', 'synthetic-benchmark', ${metadata}, ${timestamp}, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO oauth_client_consents
      (id, tenant_id, user_id, client_id, scope, selected_scopes, granted_at,
       created_at, updated_at, consent_version, consent_generation)
      SELECT ${key('consent')}, 'default', ${user}, 'bench-client-' || (i % 4),
       'openid profile email offline_access', '["openid","profile","email","offline_access"]',
       ${timestamp}, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z', 1, 0 FROM n;`,
    `${cte} INSERT OR IGNORE INTO sessions
      (id, tenant_id, user_id, expires_at, created_at)
      SELECT ${key('session')}, 'default', ${user}, ${timestamp} + 86400, ${timestamp} FROM n;`,
    `${cte} INSERT OR IGNORE INTO user_token_families
      (jti, tenant_id, user_id, client_id, generation, expires_at, is_revoked)
      SELECT ${key('token')}, 'default', ${user}, 'bench-client-' || (i % 4),
       1, ${timestamp} + 2592000, 0 FROM n;`,
  ];
  const sql = statements.join('\n');
  assert.ok(Buffer.byteLength(sql) <= 100000, 'Seed SQL exceeds the D1 statement size bound.');
  return sql;
}

const verifiedTables = [
  { name: 'users_core', key: 'id', prefix: 'user', time: 'updated_at' },
  { name: 'identity_subjects', key: 'id', prefix: 'subject', time: 'updated_at', metadata: true },
  { name: 'identity_accounts', key: 'id', prefix: 'account', time: 'updated_at', metadata: true },
  { name: 'subject_account_links', key: 'id', prefix: 'link', time: 'updated_at' },
  { name: 'passkeys', key: 'id', prefix: 'passkey', time: 'created_at', variableSuffix: true },
  { name: 'role_assignments', key: 'id', prefix: 'assignment', time: 'updated_at', metadata: true },
  { name: 'oauth_client_consents', key: 'id', prefix: 'consent', time: 'granted_at' },
  { name: 'sessions', key: 'id', prefix: 'session', time: 'created_at' },
  { name: 'user_token_families', key: 'jti', prefix: 'token', time: 'expires_at' },
  {
    name: 'account_webhook_outbox',
    key: 'user_id',
    prefix: 'user',
    time: 'occurred_at',
    timeDivisor: 1000,
  },
  { name: 'service_group_inputs', key: 'user_id', prefix: 'user', time: 'revision' },
  { name: 'account_legal_hold_states', key: 'account_id', prefix: 'account', time: 'updated_at' },
];

export const globalCountsSql = [
  ...verifiedTables.map((table) => table.name),
  'roles',
  'oauth_clients',
  'users',
]
  .map(
    (table) => `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${identifier(table)}`
  )
  .join('\nUNION ALL\n');

export const schemaFingerprintSql = `SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`;

/** Bounded aggregate and first/last row samples for every populated account table. */
export function verificationPlan(startId, accountCount) {
  requireRange(startId, accountCount, MAX_VERIFICATION_ACCOUNTS);
  return verifiedTables.map((table) => tableVerificationPlan(table, startId, accountCount));
}

/**
 * Outbox user_id has no range index in the canonical schema. Scan it once for the
 * whole fixture rather than once per account chunk. Keep legacy first/last sample
 * windows exactly, including a one-account final chunk, so existing hashes match.
 */
export function globalVerificationPlan(accountCount) {
  requireRange(1, accountCount, 999999999999);
  const table = verifiedTables.find((entry) => entry.name === 'account_webhook_outbox');
  const firstCount = Math.min(accountCount, MAX_VERIFICATION_ACCOUNTS);
  const lastStart =
    Math.floor((accountCount - 1) / MAX_VERIFICATION_ACCOUNTS) * MAX_VERIFICATION_ACCOUNTS + 1;
  return [
    {
      ...tableVerificationPlan(table, 1, accountCount),
      sampleSql: tableVerificationPlan(table, 1, firstCount).sampleSql,
      lastSampleSql: tableVerificationPlan(table, lastStart, accountCount - lastStart + 1)
        .lastSampleSql,
    },
  ];
}

function tableVerificationPlan(table, startId, accountCount) {
  const first = syntheticId(table.prefix, startId);
  const last = syntheticId(table.prefix, startId + accountCount - 1);
  const predicate = `tenant_id = 'default' AND ${identifier(table.key)} BETWEEN
      ${literal(first)} AND ${literal(table.variableSuffix ? `${last}-9` : last)}`;
  // Without ANALYZE statistics, SQLite otherwise prefers a tenant equality index
  // and scans the entire tenant for each ID range. These nine canonical TEXT PK
  // indexes exist in both the source and every SQL-restored copy of this schema.
  const index = profile.populatedTables.includes(table.name)
    ? ` INDEXED BY ${identifier(`sqlite_autoindex_${table.name}_1`)}`
    : '';
  const source = `${identifier(table.name)}${index}`;
  const metadata = table.metadata
    ? `, COALESCE(SUM(length(CAST(metadata_json AS BLOB))), 0) AS metadata_bytes,
          COALESCE(SUM(NOT json_valid(metadata_json)), 0) AS invalid_json`
    : '';
  return {
    name: table.name,
    sql: `SELECT COUNT(*) AS row_count, MIN(${identifier(table.key)}) AS min_key,
        MAX(${identifier(table.key)}) AS max_key,
        COALESCE(SUM(${identifier(table.time)}${table.timeDivisor ? ` / ${table.timeDivisor}` : ''}), 0) AS time_sum${metadata}
        FROM ${source} WHERE ${predicate}`,
    // Return a few complete rows separately; callers can hash these locally for reports.
    sampleSql: `SELECT * FROM ${source} WHERE ${predicate}
        ORDER BY ${identifier(table.key)} LIMIT 2`,
    lastSampleSql: `SELECT * FROM ${source} WHERE ${predicate}
        ORDER BY ${identifier(table.key)} DESC LIMIT 2`,
  };
}

/** Application-level tenant checks supplement schema FKs, some of which only cover IDs. */
export function relationshipCheckSql(startId, accountCount) {
  requireRange(startId, accountCount, MAX_VERIFICATION_ACCOUNTS);
  const first = literal(syntheticId('account', startId));
  const last = literal(syntheticId('account', startId + accountCount - 1));
  return `SELECT COUNT(*) AS invalid_relationships FROM identity_accounts a
    LEFT JOIN users_core u ON u.id = a.legacy_user_id AND u.tenant_id = a.tenant_id
    LEFT JOIN identity_subjects s ON s.id = a.primary_subject_id AND s.tenant_id = a.tenant_id
    LEFT JOIN subject_account_links l ON l.account_id = a.id AND l.subject_id = s.id
      AND l.tenant_id = a.tenant_id AND l.link_type = 'primary'
    WHERE a.id BETWEEN ${first} AND ${last} AND (
      u.id IS NULL OR s.id IS NULL OR l.id IS NULL OR s.primary_account_id <> a.id OR
      NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id AND p.tenant_id = a.tenant_id) OR
      NOT EXISTS (SELECT 1 FROM role_assignments r JOIN roles role
        ON role.id = r.role_id AND role.tenant_id = r.tenant_id
        WHERE r.subject_id = u.id AND r.tenant_id = a.tenant_id) OR
      NOT EXISTS (SELECT 1 FROM oauth_client_consents c JOIN oauth_clients client
        ON client.client_id = c.client_id AND client.tenant_id = c.tenant_id
        WHERE c.user_id = u.id AND c.tenant_id = a.tenant_id)
    )`;
}

export function syntheticId(prefix, ordinal) {
  assert.match(prefix, /^[a-z-]+$/);
  assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 999999999999);
  return `bench-${prefix}-${String(ordinal).padStart(12, '0')}`;
}

function requireRange(startId, count, maximum) {
  assert.ok(Number.isSafeInteger(startId) && startId >= 1 && startId <= 999999999999);
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= maximum);
  assert.ok(count - 1 <= 999999999999 - startId);
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value));
    return String(value);
  }
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  assert.equal(typeof value, 'string');
  return `'${value.replaceAll("'", "''")}'`;
}
