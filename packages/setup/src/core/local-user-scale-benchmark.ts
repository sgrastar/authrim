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
  storageProfile: string;
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
    storageProfile: config.profiles.defaults.storage,
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

CREATE TABLE IF NOT EXISTS users_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_number_verified INTEGER NOT NULL DEFAULT 0,
  email_domain_hash TEXT,
  email_domain_hash_version INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  user_type TEXT NOT NULL DEFAULT 'end_user',
  pii_partition TEXT NOT NULL DEFAULT 'default',
  pii_status TEXT NOT NULL DEFAULT 'active',
  status TEXT NOT NULL DEFAULT 'active',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS users_pii (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  pii_class TEXT NOT NULL DEFAULT 'PROFILE',
  email TEXT NOT NULL,
  email_blind_index TEXT,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  phone_number TEXT,
  declared_residence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_core_tenant ON users_core(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_core_status ON users_core(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_users_core_type ON users_core(tenant_id, user_type);
CREATE INDEX IF NOT EXISTS idx_users_core_pii_status ON users_core(pii_status);
CREATE INDEX IF NOT EXISTS idx_users_core_email_domain ON users_core(email_domain_hash);
CREATE INDEX IF NOT EXISTS idx_users_core_domain_hash
  ON users_core(tenant_id, email_domain_hash, email_domain_hash_version);
CREATE INDEX IF NOT EXISTS idx_users_core_tenant_active
  ON users_core(tenant_id, is_active, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);
CREATE INDEX IF NOT EXISTS idx_users_pii_tenant
  ON users_pii(tenant_id);
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

DELETE FROM users_core;
DELETE FROM users_pii;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO users_core (
  id,
  tenant_id,
  email_verified,
  phone_number_verified,
  email_domain_hash,
  email_domain_hash_version,
  password_hash,
  is_active,
  user_type,
  pii_partition,
  pii_status,
  status,
  lifecycle_state,
  created_at,
  updated_at,
  last_login_at
)
SELECT
  'usr_' || printf('%010d', i),
  ${tenantSql},
  i % 2,
  CASE WHEN i % 13 = 0 THEN 1 ELSE 0 END,
  'domain_hash_' || printf('%04d', i % 500),
  1,
  NULL,
  CASE WHEN i % 997 = 0 THEN 0 ELSE 1 END,
  'end_user',
  CASE WHEN i % 5 = 0 THEN 'eu' WHEN i % 5 = 1 THEN 'us' ELSE 'default' END,
  'active',
  CASE WHEN i % 997 = 0 THEN 'suspended' ELSE 'active' END,
  'active',
  1770000000000 - i,
  1770000000000 - i,
  CASE WHEN i % 3 = 0 THEN 1770000000000 - i ELSE NULL END
FROM seq;

WITH RECURSIVE seq(i) AS (
  SELECT 0
  UNION ALL
  SELECT i + 1 FROM seq WHERE i + 1 < ${users}
)
INSERT INTO users_pii (
  id,
  tenant_id,
  pii_class,
  email,
  email_blind_index,
  name,
  given_name,
  family_name,
  phone_number,
  declared_residence,
  created_at,
  updated_at
)
SELECT
  'usr_' || printf('%010d', i),
  ${tenantSql},
  'PROFILE',
  'user' || printf('%010d', i) || '@example' || printf('%03d', i % 500) || '.edu',
  'email_blind_' || printf('%010d', i),
  'User ' || printf('%010d', i),
  'User',
  printf('%010d', i),
  '+1555' || printf('%010d', i % 1000000000),
  CASE WHEN i % 5 = 0 THEN 'EU' WHEN i % 5 = 1 THEN 'US' ELSE 'JP' END,
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
        sql: `SELECT COUNT(*) FROM users_core WHERE tenant_id = ${tenant} AND is_active = 1`,
      },
      {
        name: 'admin_core_first_page',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT id FROM users_core WHERE tenant_id = ${tenant} AND is_active = 1 ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET 0)`,
      },
      {
        name: 'admin_core_deep_page',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT id FROM users_core WHERE tenant_id = ${tenant} AND is_active = 1 ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET ${deepOffset})`,
      },
      {
        name: 'admin_first_page_pii_hydrate',
        sql:
          `WITH core_page AS (` +
          `SELECT id FROM users_core WHERE tenant_id = ${tenant} AND is_active = 1 ` +
          `ORDER BY created_at DESC LIMIT 50 OFFSET 0) ` +
          `SELECT COUNT(*) FROM users_pii WHERE tenant_id = ${tenant} ` +
          `AND id IN (SELECT id FROM core_page)`,
      },
    ],
    piiSearch: [
      {
        name: 'pii_email_blind_index_lookup',
        sql:
          `SELECT COUNT(*) FROM users_pii WHERE tenant_id = ${tenant} ` +
          `AND email_blind_index = ${sqlLiteral(`email_blind_${String(firstUserIndex).padStart(10, '0')}`)}`,
      },
      {
        name: 'admin_pii_contains_search_current',
        sql:
          `SELECT COUNT(*) FROM (` +
          `SELECT id FROM users_pii WHERE tenant_id = ${tenant} ` +
          `AND (email LIKE ${sqlLiteral(rareSearch)} ESCAPE '\\' ` +
          `OR name LIKE ${sqlLiteral(rareSearch)} ESCAPE '\\') LIMIT 1000)`,
      },
    ],
    domainLookup: [
      {
        name: 'core_domain_hash_lookup',
        sql:
          `SELECT COUNT(*) FROM users_core WHERE tenant_id = ${tenant} ` +
          `AND email_domain_hash = ${sqlLiteral(`domain_hash_${String(firstUserIndex % 500).padStart(4, '0')}`)} ` +
          `AND email_domain_hash_version = 1`,
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
