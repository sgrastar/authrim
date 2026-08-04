import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseConfig } from './config.js';
import { resolveGeneratedEnvValidationTarget } from './generated-env-validator.js';
import { loadLockFileAuto } from './lock.js';

const execFileAsync = promisify(execFile);

export type LocalUserScaleScenario = 'admin-list' | 'pii-search' | 'domain-lookup' | 'mixed';

export interface LocalUserScaleBenchmarkOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  users?: number;
  tenantCount?: number;
  targetTenant?: string;
  dbPath?: string;
  fresh?: boolean;
  queryIterations?: number;
  scenario?: LocalUserScaleScenario;
}

export interface LocalUserScaleBenchmarkPlan {
  env?: string;
  baseDir?: string;
  configPath?: string;
  users: number;
  tenantCount: number;
  targetTenant: string;
  dbPath: string;
  fresh: boolean;
  queryIterations: number;
  scenario: LocalUserScaleScenario;
}

export interface LocalUserScaleQueryResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  explain: string[];
}

export interface LocalUserScaleBenchmarkResult {
  ok: boolean;
  plan: LocalUserScaleBenchmarkPlan;
  setupTarget?: LocalUserScaleSetupTarget;
  seeded: boolean;
  seedMs: number;
  dbSizeBytes: number;
  tenantUserEstimate: number;
  queryResults: LocalUserScaleQueryResult[];
  notes: string[];
}

export interface LocalUserScaleSetupTarget {
  env: string;
  baseDir: string;
  configPath: string;
  lockPath: string;
  tenantId: string;
  placementPolicy: 'shared_pool' | 'tenant_exclusive';
  d1: Record<string, { name: string; id: string }>;
}

const SCENARIOS: readonly LocalUserScaleScenario[] = [
  'admin-list',
  'pii-search',
  'domain-lookup',
  'mixed',
] as const;

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

export function resolveLocalUserScaleBenchmarkPlan(
  options: LocalUserScaleBenchmarkOptions
): LocalUserScaleBenchmarkPlan {
  const users = requirePositiveInteger(options.users ?? 100_000, 'users');
  if (users > 10_000_000) {
    throw new Error('invalid_users');
  }

  const tenantCount = requirePositiveInteger(options.tenantCount ?? 200, 'tenant_count');
  if (tenantCount > 10_000) {
    throw new Error('invalid_tenant_count');
  }

  const scenario = options.scenario ?? 'mixed';
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`invalid_local_user_scale_scenario:${scenario}`);
  }

  const queryIterations = requirePositiveInteger(options.queryIterations ?? 10, 'query_iterations');
  if (queryIterations > 1_000) {
    throw new Error('invalid_query_iterations');
  }

  const targetTenant = options.targetTenant ?? 'tenant-001';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(targetTenant)) {
    throw new Error('invalid_target_tenant');
  }

  return {
    env: options.env,
    baseDir: options.baseDir,
    configPath: options.configPath,
    users,
    tenantCount,
    targetTenant,
    dbPath: resolve(
      options.dbPath ?? `/tmp/authrim-local-user-scale-${users}-${tenantCount}.sqlite`
    ),
    fresh: options.fresh ?? false,
    queryIterations,
    scenario,
  };
}

async function resolveSetupTarget(
  options: LocalUserScaleBenchmarkOptions
): Promise<LocalUserScaleSetupTarget | undefined> {
  if (!options.env && !options.configPath) {
    return undefined;
  }

  const target = resolveGeneratedEnvValidationTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
  });
  const config = parseConfig(JSON.parse(await readFile(target.configPath, 'utf-8')));
  const loadedLock = await loadLockFileAuto(target.baseDir, target.env);
  return {
    env: target.env,
    baseDir: target.baseDir,
    configPath: target.configPath,
    lockPath: loadedLock.path,
    tenantId: config.tenant.name,
    placementPolicy: config.tenant.placementPolicy,
    d1: loadedLock.lock?.d1 ?? {},
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runSqlite(dbPath: string, sql: string, timeoutMs = 300_000): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', ['-batch', dbPath, sql], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 32,
  });
  return stdout.toString();
}

function buildSchemaSql(): string {
  return `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS identity_subjects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  subject_type TEXT NOT NULL DEFAULT 'person',
  primary_account_id TEXT,
  display_label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'user',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT 'person',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_points (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  account_id TEXT,
  contact_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'primary',
  value_storage_ref TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_attribute_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT,
  value_storage_ref TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  purpose TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_sensitive_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value_key TEXT NOT NULL,
  value_json TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'sensitive',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, lifecycle_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_subject
  ON profiles(tenant_id, subject_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_profile_attribute_values_hash
  ON profile_attribute_values(tenant_id, catalog_entry_id, value_hash, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_contact_points_account
  ON contact_points(tenant_id, account_id, contact_type, lifecycle_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key);
CREATE INDEX IF NOT EXISTS idx_identity_sensitive_values_hash
  ON identity_sensitive_values(tenant_id, value_key, value_hash, lifecycle_state);
`;
}

function buildTenantSqlExpression(tenantCount: number, targetTenant: string): string {
  const generatedTenant = `'tenant-' || printf('%03d', (i % ${tenantCount}) + 1)`;
  if (targetTenant === 'tenant-001') {
    return generatedTenant;
  }
  return `CASE WHEN i % ${tenantCount} = 0 THEN ${sqlLiteral(targetTenant)} ELSE ${generatedTenant} END`;
}

function buildSeedSql(users: number, tenantCount: number, targetTenant: string): string {
  const tenantSql = buildTenantSqlExpression(tenantCount, targetTenant);
  return `
${buildSchemaSql()}

DELETE FROM identity_subjects;
DELETE FROM identity_accounts;
DELETE FROM profiles;
DELETE FROM contact_points;
DELETE FROM profile_attribute_values;
DELETE FROM identity_sensitive_values;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO identity_subjects (
  id,
  tenant_id,
  lifecycle_state,
  subject_type,
  primary_account_id,
  display_label,
  created_at,
  updated_at
)
SELECT
  'subject:usr_' || printf('%010d', i),
  ${tenantSql},
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  'person',
  'account:usr_' || printf('%010d', i),
  'User ' || printf('%010d', i),
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO identity_accounts (
  id,
  tenant_id,
  account_type,
  lifecycle_state,
  legacy_user_id,
  primary_subject_id,
  display_label,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  'account:usr_' || printf('%010d', i),
  ${tenantSql},
  'user',
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  'usr_' || printf('%010d', i),
  'subject:usr_' || printf('%010d', i),
  'User ' || printf('%010d', i),
  json_object(
    'status', CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
    'last_login_at', CASE WHEN i % 3 = 0 THEN 1770000000000 - i ELSE NULL END
  ),
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO profiles (
  id,
  tenant_id,
  subject_id,
  profile_type,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  'profile:usr_' || printf('%010d', i),
  ${tenantSql},
  'subject:usr_' || printf('%010d', i),
  'person',
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO contact_points (
  id,
  tenant_id,
  subject_id,
  account_id,
  contact_type,
  purpose,
  value_storage_ref,
  is_primary,
  verification_state,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  'contact:usr_' || printf('%010d', i) || ':email',
  ${tenantSql},
  'subject:usr_' || printf('%010d', i),
  'account:usr_' || printf('%010d', i),
  'email',
  'primary',
  'canonical-sensitive://' || ${tenantSql} || '/usr_' || printf('%010d', i) || '/email',
  1,
  CASE WHEN i % 2 = 0 THEN 'verified' ELSE 'unverified' END,
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO profile_attribute_values (
  id,
  tenant_id,
  profile_id,
  catalog_entry_id,
  value_type,
  value_json,
  value_hash,
  classification,
  purpose,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  'profile-attribute:usr_' || printf('%010d', i) || ':email_domain_hash',
  ${tenantSql},
  'profile:usr_' || printf('%010d', i),
  'field.canonical.email_domain_hash',
  'string',
  json_quote('domain_hash_' || printf('%04d', i % 500)),
  'domain_hash_' || printf('%04d', i % 500),
  'internal',
  'tenant_discovery',
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO identity_sensitive_values (
  id,
  tenant_id,
  owner_type,
  owner_id,
  value_key,
  value_json,
  value_hash,
  classification,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  'sensitive:usr_' || printf('%010d', i) || ':email',
  ${tenantSql},
  'runtime_user',
  'usr_' || printf('%010d', i),
  'email',
  json_quote('user' || printf('%010d', i) || '@example' || printf('%03d', i % 500) || '.edu'),
  'email_blind_' || printf('%010d', i),
  'sensitive',
  CASE WHEN i % 997 = 0 THEN 'deleted' ELSE 'active' END,
  1770000000000 - i,
  1770000000000 - i
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO identity_sensitive_values (
  id,
  tenant_id,
  owner_type,
  owner_id,
  value_key,
  value_json,
  value_hash,
  classification,
  lifecycle_state,
  created_at,
  updated_at
)
SELECT
  'sensitive:usr_' || printf('%010d', i) || ':name',
  ${tenantSql},
  'runtime_user',
  'usr_' || printf('%010d', i),
  'name',
  json_quote('User ' || printf('%010d', i)),
  NULL,
  'sensitive',
  CASE WHEN i % 997 = 0 THEN 'deleted' ELSE 'active' END,
  1770000000000 - i,
  1770000000000 - i
FROM seq;

ANALYZE;
`;
}

function selectQueries(plan: LocalUserScaleBenchmarkPlan): Array<{ name: string; sql: string }> {
  const tenant = sqlLiteral(plan.targetTenant);
  const tenantOrdinal = Number.parseInt(plan.targetTenant.slice('tenant-'.length), 10);
  const firstUserIndex =
    Number.isFinite(tenantOrdinal) && tenantOrdinal > 0 ? tenantOrdinal - 1 : 0;
  const deepOffset = Math.max(0, Math.min(10_000, Math.floor(plan.users / plan.tenantCount / 2)));
  const rareSearch = `%user${String(firstUserIndex).padStart(10, '0')}%`;
  const queries = {
    adminList: [
      {
        name: 'admin_core_count_active',
        sql: `SELECT COUNT(*) FROM identity_accounts WHERE tenant_id = ${tenant} AND lifecycle_state = 'active' AND legacy_user_id IS NOT NULL`,
      },
      {
        name: 'admin_core_first_page',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT legacy_user_id FROM identity_accounts WHERE tenant_id = ${tenant} AND lifecycle_state = 'active' AND legacy_user_id IS NOT NULL ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET 0)`,
      },
      {
        name: 'admin_core_deep_page',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT legacy_user_id FROM identity_accounts WHERE tenant_id = ${tenant} AND lifecycle_state = 'active' AND legacy_user_id IS NOT NULL ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET ${deepOffset})`,
      },
      {
        name: 'admin_first_page_pii_hydrate',
        sql:
          `WITH core_page AS (` +
          `SELECT legacy_user_id AS id FROM identity_accounts WHERE tenant_id = ${tenant} AND lifecycle_state = 'active' AND legacy_user_id IS NOT NULL ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET 0) ` +
          `SELECT COUNT(*) FROM identity_sensitive_values WHERE tenant_id = ${tenant} ` +
          `AND owner_type = 'runtime_user' AND owner_id IN (SELECT id FROM core_page)`,
      },
    ],
    piiSearch: [
      {
        name: 'pii_email_blind_index_lookup',
        sql:
          `SELECT COUNT(*) FROM identity_sensitive_values WHERE tenant_id = ${tenant} ` +
          `AND owner_type = 'runtime_user' AND value_key = 'email' ` +
          `AND value_hash = ${sqlLiteral(`email_blind_${String(firstUserIndex).padStart(10, '0')}`)} ` +
          `AND lifecycle_state = 'active'`,
      },
      {
        name: 'admin_pii_contains_search_current',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT owner_id FROM identity_sensitive_values WHERE tenant_id = ${tenant} ` +
          `AND owner_type = 'runtime_user' AND value_key IN ('email', 'name') ` +
          `AND value_json LIKE ${sqlLiteral(rareSearch)} ESCAPE '\\' LIMIT 1000)`,
      },
    ],
    domainLookup: [
      {
        name: 'core_domain_hash_lookup',
        sql:
          `SELECT COUNT(*) FROM profile_attribute_values WHERE tenant_id = ${tenant} ` +
          `AND catalog_entry_id = 'field.canonical.email_domain_hash' ` +
          `AND value_hash = ${sqlLiteral(`domain_hash_${String(firstUserIndex % 500).padStart(4, '0')}`)} ` +
          `AND lifecycle_state = 'active'`,
      },
    ],
  };

  if (plan.scenario === 'admin-list') return queries.adminList;
  if (plan.scenario === 'pii-search') return queries.piiSearch;
  if (plan.scenario === 'domain-lookup') return queries.domainLookup;
  return [...queries.adminList, ...queries.piiSearch, ...queries.domainLookup];
}

async function benchmarkQuery(
  dbPath: string,
  query: { name: string; sql: string },
  iterations: number
): Promise<LocalUserScaleQueryResult> {
  const explain = (await runSqlite(dbPath, `EXPLAIN QUERY PLAN ${query.sql};`))
    .trim()
    .split('\n')
    .filter(Boolean);
  const repeatedSql = Array.from({ length: iterations }, () => `${query.sql};`).join('\n');
  const started = performance.now();
  await runSqlite(dbPath, repeatedSql);
  const totalMs = performance.now() - started;
  return {
    name: query.name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    explain,
  };
}

export async function runLocalUserScaleBenchmark(
  options: LocalUserScaleBenchmarkOptions
): Promise<LocalUserScaleBenchmarkResult> {
  const setupTarget = await resolveSetupTarget(options);
  const plan = resolveLocalUserScaleBenchmarkPlan({
    ...options,
    env: setupTarget?.env ?? options.env,
    baseDir: setupTarget?.baseDir ?? options.baseDir,
    configPath: setupTarget?.configPath ?? options.configPath,
    targetTenant: options.targetTenant ?? setupTarget?.tenantId,
    dbPath:
      options.dbPath ??
      (setupTarget
        ? `/tmp/authrim-local-user-scale-${setupTarget.env}-${setupTarget.tenantId}-${options.users ?? 100_000}-${options.tenantCount ?? 200}.sqlite`
        : undefined),
  });
  await mkdir(dirname(plan.dbPath), { recursive: true });

  if (plan.fresh && existsSync(plan.dbPath)) {
    await rm(plan.dbPath, { force: true });
    await rm(`${plan.dbPath}-wal`, { force: true });
    await rm(`${plan.dbPath}-shm`, { force: true });
  }

  let seeded = false;
  let seedMs = 0;
  if (!existsSync(plan.dbPath)) {
    const started = performance.now();
    await runSqlite(
      plan.dbPath,
      buildSeedSql(plan.users, plan.tenantCount, plan.targetTenant),
      1_800_000
    );
    seedMs = performance.now() - started;
    seeded = true;
  } else {
    await runSqlite(plan.dbPath, buildSchemaSql());
  }

  const queryResults: LocalUserScaleQueryResult[] = [];
  for (const query of selectQueries(plan)) {
    queryResults.push(await benchmarkQuery(plan.dbPath, query, plan.queryIterations));
  }

  const dbStats = await stat(plan.dbPath);
  return {
    ok: queryResults.every((result) => Number.isFinite(result.avgMs)),
    plan,
    setupTarget,
    seeded,
    seedMs,
    dbSizeBytes: dbStats.size,
    tenantUserEstimate: Math.ceil(plan.users / plan.tenantCount),
    queryResults,
    notes: [
      'This is a Mac-local SQLite approximation for data-volume and query-plan regression checks.',
      'It does not measure Cloudflare D1 remote latency, D1 limits, Durable Object latency, or Worker CPU.',
      'Use --tenant-count 200 for shared multi-tenant shape and --tenant-count 1 for worst-case single-tenant size.',
      'The admin_pii_contains_search_current query reflects the current contains-search shape and can become a scan-heavy path.',
    ],
  };
}
