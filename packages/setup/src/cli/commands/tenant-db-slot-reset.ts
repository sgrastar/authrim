import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  executeD1Command,
  executeD1Migration,
  findMigrationsRoot,
  queryD1Rows,
  runD1Migrations,
} from '../../core/cloudflare.js';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { loadLockFileAuto } from '../../core/lock.js';
import { getD1DatabaseName } from '../../core/naming.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { buildTenantDatabaseSlotPlan } from '../../core/tenant-database.js';

interface TenantDatabaseSlotResetOptions {
  env?: string;
  slot?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface TenantDatabaseSlotRow extends Record<string, unknown> {
  slot_id: string;
  slot_number: number;
  state: string;
  assigned_tenant_id: string | null;
  core_binding_ref: string;
  pii_binding_ref: string;
  core_database_name: string;
  pii_database_name: string;
}

interface SqliteObjectRow extends Record<string, unknown> {
  type: 'table' | 'view';
  name: string;
}

interface MigrationCountRow extends Record<string, unknown> {
  migration_count: number;
}

const RESETTABLE_SLOT_STATES = new Set(['reset_required', 'unavailable']);

function parseSlotNumber(value: string | undefined): number {
  const normalized = value?.trim().match(/\d+/u)?.[0] ?? '';
  const slotNumber = Number.parseInt(normalized, 10);
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 500) {
    throw new Error('Missing or invalid required option: --slot <1-500>');
  }
  return slotNumber;
}

async function loadEnvironmentConfig(baseDir: string, env: string): Promise<AuthrimConfig | null> {
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) {
    return null;
  }
  return AuthrimConfigSchema.parse(JSON.parse(await readFile(envPaths.config, 'utf-8')));
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function listUserSchemaObjects(dbName: string): Promise<SqliteObjectRow[]> {
  const rows = await queryD1Rows<SqliteObjectRow>(
    dbName,
    `SELECT type, name
       FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
      ORDER BY CASE type WHEN 'view' THEN 0 ELSE 1 END, name;`
  );
  return rows.filter((row) => row.type === 'table' || row.type === 'view');
}

function buildDropSchemaSql(objects: SqliteObjectRow[]): string {
  if (objects.length === 0) {
    return 'SELECT 1;';
  }
  return [
    'PRAGMA foreign_keys = OFF;',
    ...objects.map((object) => {
      const verb = object.type === 'view' ? 'DROP VIEW IF EXISTS' : 'DROP TABLE IF EXISTS';
      return `${verb} ${sqlIdentifier(object.name)};`;
    }),
    'PRAGMA foreign_keys = ON;',
  ].join('\n');
}

async function executeSchemaReset(dbName: string, objects: SqliteObjectRow[]): Promise<void> {
  const tempSqlPath = join(
    tmpdir(),
    `authrim-tenant-d1-reset-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`
  );
  await writeFile(tempSqlPath, buildDropSchemaSql(objects), 'utf-8');
  try {
    const result = await executeD1Migration(dbName, tempSqlPath);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to reset schema for ${dbName}`);
    }
  } finally {
    await unlink(tempSqlPath).catch(() => {});
  }
}

function migrationDirForRole(migrationsRoot: string, role: 'tenant_core' | 'tenant_pii'): string {
  return role === 'tenant_pii' ? join(migrationsRoot, 'pii') : migrationsRoot;
}

async function verifyResetDatabase(dbName: string): Promise<void> {
  const [row] = await queryD1Rows<MigrationCountRow>(
    dbName,
    'SELECT COUNT(*) AS migration_count FROM authrim_migrations;'
  );
  const migrationCount =
    typeof row?.migration_count === 'number'
      ? row.migration_count
      : Number.parseInt(String(row?.migration_count ?? '0'), 10);
  if (!Number.isFinite(migrationCount) || migrationCount < 1) {
    throw new Error(`Reset verification failed for ${dbName}: no applied migrations found`);
  }
}

export function buildSlotCleanupSql(slot: TenantDatabaseSlotRow): string {
  const now = Math.floor(Date.now() / 1000);
  const tenantId = slot.assigned_tenant_id?.trim();
  const slotIdSql = sqlString(slot.slot_id);
  const auditIdSql = sqlString(`tenant-db-slot-reset:${slot.slot_id}:${Date.now()}`);
  const tenantIdSql = tenantId ? sqlString(tenantId) : 'NULL';
  const tenantCleanupSql = tenantId
    ? `
DELETE FROM tenant_database_active_pointers WHERE tenant_id = ${tenantIdSql};
DELETE FROM tenant_database_registry WHERE tenant_id = ${tenantIdSql};
UPDATE tenant_runtime_registry_snapshots
   SET status = 'invalid'
 WHERE tenant_id = ${tenantIdSql}
   AND status = 'active';`
    : '';

  return `
${tenantCleanupSql}
UPDATE tenant_database_slots
   SET state = 'available',
       assigned_tenant_id = NULL,
       reserved_by = NULL,
       reserved_at = NULL,
       assigned_at = NULL,
       updated_at = ${now}
 WHERE slot_id = ${slotIdSql};

INSERT INTO tenant_database_slot_audit_events (
  id, tenant_id, slot_id, stage, actor, result, error_code, request_id, metadata_json, created_at
)
VALUES (
  ${auditIdSql},
  ${tenantIdSql},
  ${slotIdSql},
  'manual_reset',
  'setup-cli',
  'succeeded',
  NULL,
  NULL,
  ${sqlString(JSON.stringify({ previous_state: slot.state, slot_number: slot.slot_number }))},
  ${now}
);
`.trim();
}

export function buildSlotRetiredSql(slot: TenantDatabaseSlotRow, error: string): string {
  const now = Math.floor(Date.now() / 1000);
  const tenantId = slot.assigned_tenant_id?.trim();
  const slotIdSql = sqlString(slot.slot_id);
  const auditIdSql = sqlString(`tenant-db-slot-reset-failed:${slot.slot_id}:${Date.now()}`);
  const tenantIdSql = tenantId ? sqlString(tenantId) : 'NULL';
  return `
UPDATE tenant_database_slots
   SET state = 'retired',
       reserved_by = NULL,
       reserved_at = NULL,
       updated_at = ${now}
 WHERE slot_id = ${slotIdSql};

INSERT INTO tenant_database_slot_audit_events (
  id, tenant_id, slot_id, stage, actor, result, error_code, request_id, metadata_json, created_at
)
VALUES (
  ${auditIdSql},
  ${tenantIdSql},
  ${slotIdSql},
  'manual_reset_verify',
  'setup-cli',
  'failed',
  ${sqlString(error)},
  NULL,
  ${sqlString(JSON.stringify({ previous_state: slot.state, slot_number: slot.slot_number }))},
  ${now}
);
`.trim();
}

export async function tenantDatabaseSlotResetCommand(
  options: TenantDatabaseSlotResetOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const slotNumber = parseSlotNumber(options.slot);
  const baseDir = findAuthrimBaseDir(process.cwd());
  const config = await loadEnvironmentConfig(baseDir, env);
  if (config && config.profiles?.defaults?.storage !== 'builtin:storage:tenant-d1') {
    console.error(
      chalk.red(
        `Tenant D1 pool is not enabled for environment "${env}" ` +
          `(storage: ${config.profiles?.defaults?.storage ?? 'unknown'}).`
      )
    );
    console.log(chalk.gray('Shared D1 tenants do not have tenant D1 slots to reset.'));
    process.exit(1);
  }

  const { lock } = await loadLockFileAuto(baseDir, env);
  if (!lock) {
    console.error(chalk.red(`No Authrim lock file found for environment "${env}".`));
    process.exit(1);
  }

  const adminDbName = getD1DatabaseName(env, 'admin-db');
  const [slot] = await queryD1Rows<TenantDatabaseSlotRow>(
    adminDbName,
    `SELECT slot_id, slot_number, state, assigned_tenant_id, core_binding_ref, pii_binding_ref,
            core_database_name, pii_database_name
       FROM tenant_database_slots
      WHERE slot_number = ${slotNumber}
      LIMIT 1;`
  );
  if (!slot) {
    console.error(chalk.red(`Tenant D1 slot not found: ${slotNumber}`));
    process.exit(1);
  }
  if (!RESETTABLE_SLOT_STATES.has(slot.state)) {
    console.error(
      chalk.red(
        `Slot ${slot.slot_id} is "${slot.state}". Only reset_required/unavailable slots can be reset.`
      )
    );
    process.exit(1);
  }

  const slotPlan = buildTenantDatabaseSlotPlan({ env, slotNumber });
  const coreBinding = slotPlan.resources.find((resource) => resource.role === 'tenant_core');
  const piiBinding = slotPlan.resources.find((resource) => resource.role === 'tenant_pii');
  const coreLock = coreBinding ? lock.d1[coreBinding.binding] : undefined;
  const piiLock = piiBinding ? lock.d1[piiBinding.binding] : undefined;
  if (!coreBinding || !piiBinding || !coreLock || !piiLock) {
    console.error(
      chalk.red(
        `Slot ${slot.slot_id} bindings are missing from the lock file. Run tenant-db-pool-expand or deploy first.`
      )
    );
    process.exit(1);
  }

  const migrationsRoot = await findMigrationsRoot(baseDir);
  if (!migrationsRoot.path) {
    throw new Error(
      `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
    );
  }

  const coreObjects = await listUserSchemaObjects(coreLock.name);
  const piiObjects = await listUserSchemaObjects(piiLock.name);

  console.log(chalk.bold('\nTenant D1 slot reset\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Slot:        ${chalk.cyan(slot.slot_id)} (#${slot.slot_number})`);
  console.log(`State:       ${chalk.yellow(slot.state)}`);
  if (slot.assigned_tenant_id) {
    console.log(`Tenant:      ${chalk.cyan(slot.assigned_tenant_id)}`);
  }
  console.log(`Core DB:     ${chalk.cyan(coreLock.name)} (${coreObjects.length} object(s))`);
  console.log(`PII DB:      ${chalk.cyan(piiLock.name)} (${piiObjects.length} object(s))`);

  if (options.dryRun) {
    console.log(
      chalk.yellow('\nDry run only. No D1 schema, migrations, or slot state were changed.')
    );
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message:
        'Drop and recreate this slot’s tenant D1 schemas, clear failed registry rows, and mark it available?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const spinner = ora('Resetting tenant D1 slot schemas...').start();
  try {
    await executeSchemaReset(coreLock.name, coreObjects);
    await executeSchemaReset(piiLock.name, piiObjects);

    spinner.text = 'Running tenant D1 migrations...';
    const coreMigration = await runD1Migrations(
      coreLock.name,
      migrationDirForRole(migrationsRoot.path, 'tenant_core')
    );
    if (!coreMigration.success) {
      throw new Error(`Core migration failed: ${coreMigration.error}`);
    }
    const piiMigration = await runD1Migrations(
      piiLock.name,
      migrationDirForRole(migrationsRoot.path, 'tenant_pii')
    );
    if (!piiMigration.success) {
      throw new Error(`PII migration failed: ${piiMigration.error}`);
    }

    spinner.text = 'Verifying reset schemas...';
    try {
      await verifyResetDatabase(coreLock.name);
      await verifyResetDatabase(piiLock.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.text = 'Reset verification failed; retiring slot...';
      await executeD1Command(adminDbName, buildSlotRetiredSql(slot, message));
      throw new Error(`${message}; slot ${slot.slot_id} was retired and will not be reused`);
    }

    spinner.text = 'Marking slot available...';
    await executeD1Command(adminDbName, buildSlotCleanupSql(slot));
    spinner.succeed(`Tenant D1 slot ${slot.slot_id} reset and marked available.`);
  } catch (error) {
    spinner.fail('Tenant D1 slot reset failed.');
    throw error;
  }
}
