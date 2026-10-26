import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';
import { AWS_RUNTIME_SCHEMA_FILES } from '../import/aws-schema-bootstrap';

export const DATABASE_FAMILIES = ['core', 'pii', 'state'] as const;
export type DatabaseFamily = (typeof DATABASE_FAMILIES)[number];
export interface MaintenanceDatabase {
  name: string;
  user: string;
  password: string;
  connectionString: string;
}
export interface MaintenanceSqlClient {
  connect(this: void): Promise<void>;
  query<T extends QueryResultRow = QueryResultRow>(
    this: void,
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(this: void): Promise<void>;
}
export type MaintenanceSqlFactory = (connectionString: string) => MaintenanceSqlClient;
export const createMaintenanceSqlClient: MaintenanceSqlFactory = (connectionString) => {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  return {
    connect: async () => {
      await client.connect();
    },
    query: (sql, values) => client.query(sql, values),
    end: () => client.end(),
  };
};

function invalid(): never {
  throw new Error('aws_database_initialization_invalid');
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) invalid();
  return `"${value}"`;
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
export function maintenanceDatabaseUrl(input: {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}): string {
  if (
    !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/u.test(input.host) ||
    input.port !== 5432 ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(input.database) ||
    !/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/u.test(input.username) ||
    input.password.length < 16 ||
    input.password.length > 256
  )
    invalid();
  const url = new URL(`postgresql://${input.host}:${input.port}/${input.database}`);
  url.username = input.username;
  url.password = input.password;
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/** The database itself confirms TLS, rather than relying on a URI label alone. */
export async function assertMaintenanceTls(client: MaintenanceSqlClient): Promise<void> {
  const result = await client.query<{ ssl: boolean }>(
    'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
  );
  if (result.rows.length !== 1 || result.rows[0].ssl !== true)
    throw new Error('aws_database_tls_required');
}

export async function withMaintenanceLock<T>(
  masterUrl: string,
  initializationId: string,
  run: (master: MaintenanceSqlClient) => Promise<T>,
  clientFactory: MaintenanceSqlFactory = createMaintenanceSqlClient
): Promise<T> {
  const client = clientFactory(masterUrl);
  await client.connect();
  try {
    await assertMaintenanceTls(client);
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [`authrim:maintenance:${initializationId}`]
    );
    if (lock.rows[0]?.acquired !== true) throw new Error('aws_database_maintenance_busy');
    return await run(client);
  } finally {
    // A session-scoped advisory lock is released even after an interrupted transaction.
    await client.end();
  }
}

export async function inspectMaintenanceTargets(
  master: MaintenanceSqlClient,
  names: readonly string[]
): Promise<{
  databases: Array<{ name: string; owner: string; marker: string | null }>;
  roles: Array<{ name: string; marker: string | null; safe: boolean }>;
}> {
  for (const name of names) identifier(name);
  const [databases, roles] = await Promise.all([
    master.query<{ name: string; owner: string; marker: string | null }>(
      `SELECT d.datname AS name, r.rolname AS owner,
              shobj_description(d.oid, 'pg_database') AS marker
         FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
        WHERE d.datname=ANY($1::text[])`,
      [names]
    ),
    master.query<{ name: string; marker: string | null; safe: boolean }>(
      `SELECT r.rolname AS name, shobj_description(r.oid, 'pg_authid') AS marker,
              (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND
               NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
               AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) AS safe
         FROM pg_roles r WHERE r.rolname=ANY($1::text[])`,
      [names]
    ),
  ]);
  return { databases: databases.rows, roles: roles.rows };
}

export async function loadMaintenanceMigrations(
  family: DatabaseFamily,
  root: URL = new URL('./', import.meta.url)
): Promise<{ digest: string; sql: string; files: string[] }> {
  // In the built artifact import.meta.url is /var/task/maintenance.mjs.
  const directory =
    family === 'state'
      ? new URL('storage/', root)
      : new URL(`migrations/${family}/postgresql/`, root);
  const files =
    family === 'state'
      ? [...AWS_RUNTIME_SCHEMA_FILES]
      : (await readdir(directory)).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  if (files.length === 0) invalid();
  const sources = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(new URL(file, directory), 'utf8');
      if (!sql.trim()) invalid();
      return { file, sql: family === 'state' ? sql : renderPortableMigrationSql(sql, 'postgres') };
    })
  );
  const digest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  return {
    digest,
    files,
    // Fresh baselines reset search_path like pg_dump; later forward deltas use public.
    sql: `${sources.map((source) => `SET search_path TO public;\n${source.sql}`).join('\n')}\nSET search_path TO public;`,
  };
}

async function assertSchemaState(
  client: MaintenanceSqlClient,
  initializationId: string,
  family: DatabaseFamily,
  digest: string
): Promise<'empty' | 'initialized'> {
  const namespaces = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_namespace
      WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema')`
  );
  if (namespaces.rows[0]?.count !== '0') invalid();
  const objects = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`
  );
  if (objects.rows.length > 0) {
    if (!objects.rows.some((row) => row.name === 'authrim_aws_schema_initialization')) invalid();
    const prior = await client.query<{ initialization_id: string; family: string; digest: string }>(
      'SELECT initialization_id, family, digest FROM authrim_aws_schema_initialization'
    );
    if (
      prior.rows.length !== 1 ||
      prior.rows[0].initialization_id !== initializationId ||
      prior.rows[0].family !== family ||
      prior.rows[0].digest !== digest
    )
      invalid();
    return 'initialized';
  }
  // Standalone functions and enum/domain/composite types also make a fresh target nonempty.
  const functions = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`
  );
  const types = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`
  );
  if (functions.rows[0]?.count !== '0' || types.rows[0]?.count !== '0') invalid();
  return 'empty';
}

export async function initializeMaintenanceDatabases(input: {
  master: MaintenanceSqlClient;
  initializationId: string;
  databases: Record<DatabaseFamily, MaintenanceDatabase>;
  migrations: Record<DatabaseFamily, Awaited<ReturnType<typeof loadMaintenanceMigrations>>>;
  clientFactory?: MaintenanceSqlFactory;
}): Promise<Array<{ family: DatabaseFamily; database: string; schemaSha256: string }>> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.initializationId)) invalid();
  const factory = input.clientFactory ?? createMaintenanceSqlClient;
  const names = DATABASE_FAMILIES.map((family) => input.databases[family].name);
  if (new Set(names).size !== 3) invalid();
  const marker = `authrim-initialization:${input.initializationId}`;
  const before = await inspectMaintenanceTargets(input.master, names);
  // Preflight all destinations before changing any one of them.
  for (const family of DATABASE_FAMILIES) {
    const db = input.databases[family];
    identifier(db.name);
    identifier(db.user);
    if (db.name !== db.user || !/^[A-Za-z0-9_-]{43}$/u.test(db.password)) invalid();
    const role = before.roles.find((row) => row.name === db.user);
    const existing = before.databases.find((row) => row.name === db.name);
    if (role && (role.marker !== marker || !role.safe)) invalid();
    if (
      existing &&
      (!role ||
        existing.owner !== db.user ||
        (existing.marker !== null && existing.marker !== marker))
    )
      invalid();
  }
  for (const family of DATABASE_FAMILIES) {
    const db = input.databases[family];
    if (!before.databases.some((row) => row.name === db.name)) continue;
    const client = factory(db.connectionString);
    await client.connect();
    try {
      await assertMaintenanceTls(client);
      await assertSchemaState(
        client,
        input.initializationId,
        family,
        input.migrations[family].digest
      );
    } finally {
      await client.end();
    }
  }
  const masterIdentity = await input.master.query<{ name: string }>('SELECT current_user AS name');
  const masterName = masterIdentity.rows[0]?.name;
  if (!masterName) invalid();
  const receipt: Array<{ family: DatabaseFamily; database: string; schemaSha256: string }> = [];
  for (const family of DATABASE_FAMILIES) {
    const db = input.databases[family];
    if (!before.roles.some((role) => role.name === db.user)) {
      await input.master.query('BEGIN');
      try {
        await input.master.query(
          `CREATE ROLE ${identifier(db.user)} LOGIN PASSWORD ${literal(db.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
        );
        await input.master.query(`COMMENT ON ROLE ${identifier(db.user)} IS ${literal(marker)}`);
        // PostgreSQL 17 requires membership with SET for a non-superuser creating a DB owner.
        await input.master.query(
          `GRANT ${identifier(db.user)} TO ${identifier(masterName)} WITH SET TRUE, INHERIT FALSE`
        );
        await input.master.query('COMMIT');
      } catch (error) {
        await input.master.query('ROLLBACK');
        throw error;
      }
    }
    if (!before.databases.some((database) => database.name === db.name)) {
      await input.master.query(
        `CREATE DATABASE ${identifier(db.name)} OWNER ${identifier(db.user)} TEMPLATE template0 ENCODING 'UTF8'`
      );
    }
    await input.master.query(`SET ROLE ${identifier(db.user)}`);
    try {
      await input.master.query(`REVOKE ALL ON DATABASE ${identifier(db.name)} FROM PUBLIC`);
      await input.master.query(`COMMENT ON DATABASE ${identifier(db.name)} IS ${literal(marker)}`);
    } finally {
      await input.master.query('RESET ROLE');
    }
    const client = factory(db.connectionString);
    await client.connect();
    try {
      await assertMaintenanceTls(client);
      const schema = input.migrations[family];
      await client.query('BEGIN');
      try {
        const priorState = await assertSchemaState(
          client,
          input.initializationId,
          family,
          schema.digest
        );
        if (priorState === 'empty') {
          await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
          await client.query(schema.sql);
          await client.query(`CREATE TABLE authrim_aws_schema_initialization (
            initialization_id text PRIMARY KEY, family text NOT NULL, digest text NOT NULL)`);
          await client.query('INSERT INTO authrim_aws_schema_initialization VALUES ($1,$2,$3)', [
            input.initializationId,
            family,
            schema.digest,
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      receipt.push({ family, database: db.name, schemaSha256: schema.digest });
    } finally {
      await client.end();
    }
  }
  return receipt;
}

/** Nonsecret reconciliation counts for the restored tenant, not database-wide row values. */
export async function countMaintenanceRows(
  databases: Record<DatabaseFamily, MaintenanceDatabase>,
  tenantId: string,
  clientFactory: MaintenanceSqlFactory = createMaintenanceSqlClient
): Promise<Record<string, number>> {
  const tables: Record<DatabaseFamily, string[]> = {
    core: ['users_core', 'identity_accounts', 'passkeys', 'identity_providers'],
    pii: ['users_pii', 'identity_sensitive_values'],
    state: [
      'authrim_aws_account_auth_state',
      'authrim_aws_passkey_counters',
      'authrim_aws_saml_persistent_nameids',
      'authrim_aws_restore_activations',
    ],
  };
  const counts: Record<string, number> = {};
  for (const family of DATABASE_FAMILIES) {
    const client = clientFactory(databases[family].connectionString);
    await client.connect();
    try {
      await assertMaintenanceTls(client);
      for (const table of tables[family]) {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${identifier(table)} WHERE tenant_id=$1`,
          [tenantId]
        );
        const count = Number(result.rows[0]?.count);
        if (!Number.isSafeInteger(count) || count < 0) invalid();
        counts[`${family}.${table}`] = count;
      }
    } finally {
      await client.end();
    }
  }
  return counts;
}
