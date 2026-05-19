import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { getD1DatabaseName } from '../../core/naming.js';
import { queryD1Rows } from '../../core/cloudflare.js';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';

interface TenantDatabasePoolStatusOptions {
  env?: string;
  json?: boolean;
}

interface TenantDatabaseSlotStatusRow extends Record<string, unknown> {
  slot_number: number;
  slot_id: string;
  state: string;
  assigned_tenant_id: string | null;
  core_binding_ref: string;
  pii_binding_ref: string;
  core_database_name: string;
  pii_database_name: string;
  updated_at: number;
}

interface TenantDatabaseSlotCountRow extends Record<string, unknown> {
  state: string;
  count: number;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

async function loadEnvironmentConfig(env: string): Promise<AuthrimConfig | null> {
  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) {
    return null;
  }
  return AuthrimConfigSchema.parse(JSON.parse(await readFile(envPaths.config, 'utf-8')));
}

export async function tenantDatabasePoolStatusCommand(
  options: TenantDatabasePoolStatusOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const config = await loadEnvironmentConfig(env);
  const storageProfile = config?.profiles?.defaults?.storage ?? 'unknown';
  if (config && storageProfile !== 'builtin:storage:tenant-d1') {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            env,
            storage_profile: storageProfile,
            tenant_d1_pool: { enabled: false },
            tenant_addition_mode: 'shared-d1',
          },
          null,
          2
        )
      );
      return;
    }

    console.log(chalk.bold('\nTenant storage status\n'));
    console.log(`Environment:      ${chalk.cyan(env)}`);
    console.log(`Storage profile:  ${chalk.cyan(storageProfile)}`);
    console.log(`Tenant D1 pool:   ${chalk.gray('not enabled')}`);
    console.log(chalk.green('\nTenant additions use the shared deployment D1 databases.'));
    console.log(chalk.gray('No preallocated tenant D1 slot expansion or reset is required.'));
    return;
  }

  const adminDbName = getD1DatabaseName(env, 'admin-db');

  const [counts, slots] = await Promise.all([
    queryD1Rows<TenantDatabaseSlotCountRow>(
      adminDbName,
      'SELECT state, COUNT(*) AS count FROM tenant_database_slots GROUP BY state ORDER BY state;'
    ),
    queryD1Rows<TenantDatabaseSlotStatusRow>(
      adminDbName,
      `SELECT slot_number, slot_id, state, assigned_tenant_id, core_binding_ref, pii_binding_ref,
              core_database_name, pii_database_name, updated_at
         FROM tenant_database_slots
        ORDER BY slot_number ASC;`
    ),
  ]);

  const summary = Object.fromEntries(counts.map((row) => [row.state, numberValue(row.count)]));
  const capacity = Object.values(summary).reduce((total, count) => total + count, 0);
  const available = summary.available ?? 0;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          env,
          admin_database: adminDbName,
          capacity,
          available,
          counts: summary,
          slots,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(chalk.bold('\nTenant D1 pool status\n'));
  console.log(`Environment:    ${chalk.cyan(env)}`);
  console.log(`Admin DB:       ${chalk.cyan(adminDbName)}`);
  console.log(`Capacity:       ${chalk.cyan(String(capacity))}`);
  console.log(`Available:      ${available > 0 ? chalk.green(String(available)) : chalk.red('0')}`);
  console.log('');

  for (const state of [
    'available',
    'reserved',
    'assigned',
    'pending_binding',
    'unavailable',
    'reset_required',
    'retired',
  ]) {
    if (summary[state]) {
      console.log(`${state.padEnd(16)} ${chalk.cyan(String(summary[state]))}`);
    }
  }

  console.log('');
  for (const slot of slots) {
    const owner = slot.assigned_tenant_id ? ` tenant=${slot.assigned_tenant_id}` : '';
    const state =
      slot.state === 'available'
        ? chalk.green(slot.state)
        : slot.state === 'reset_required' || slot.state === 'unavailable'
          ? chalk.red(slot.state)
          : chalk.yellow(slot.state);
    console.log(
      `#${String(slot.slot_number).padStart(4, '0')} ${slot.slot_id.padEnd(13)} ${state}${owner}`
    );
  }
}
