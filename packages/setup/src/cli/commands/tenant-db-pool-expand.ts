import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { deployCommand } from './deploy.js';

interface TenantDatabasePoolExpandOptions {
  env?: string;
  addSlots?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const MAX_TENANT_D1_SLOTS = 500;

export async function tenantDatabasePoolExpandCommand(
  options: TenantDatabasePoolExpandOptions
): Promise<void> {
  const env = options.env ?? 'prod';
  const addSlots = Number.parseInt(options.addSlots ?? '0', 10);
  if (!Number.isInteger(addSlots) || addSlots < 1) {
    console.error(chalk.red('Missing or invalid required option: --add-slots <n>'));
    process.exit(1);
  }

  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) {
    console.error(chalk.red(`Config file not found: ${envPaths.config}`));
    process.exit(1);
  }

  const config = AuthrimConfigSchema.parse(
    JSON.parse(await readFile(envPaths.config, 'utf-8'))
  ) as AuthrimConfig;
  if (config.profiles?.defaults?.storage !== 'builtin:storage:tenant-d1') {
    console.error(
      chalk.red(
        `Tenant D1 pool is not enabled for environment "${env}" ` +
          `(storage: ${config.profiles?.defaults?.storage ?? 'unknown'}).`
      )
    );
    console.log(chalk.gray('Shared D1 tenants can be added from Admin UI without pool expansion.'));
    process.exit(1);
  }

  const currentSlots = config.tenantD1?.preallocatedSlots ?? 3;
  const nextSlots = currentSlots + addSlots;
  if (nextSlots > MAX_TENANT_D1_SLOTS) {
    console.error(
      chalk.red(
        `Tenant D1 slot hard limit exceeded: ${nextSlots}/${MAX_TENANT_D1_SLOTS}. ` +
          'Use Tenant DB Shard Worker design for larger installations.'
      )
    );
    process.exit(1);
  }

  console.log(chalk.bold('\nTenant D1 pool expansion\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Current slots: ${chalk.cyan(currentSlots)}`);
  console.log(`Add slots:     ${chalk.cyan(addSlots)}`);
  console.log(`Next slots:    ${chalk.cyan(nextSlots)}`);

  if (options.dryRun) {
    console.log(
      chalk.yellow('\nDry run only. No config, D1, binding, or deployment changes made.')
    );
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message:
        'Update config, create additional tenant D1 slots, refresh bindings, and deploy workers?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const updatedConfig: AuthrimConfig = {
    ...config,
    tenantD1: {
      ...(config.tenantD1 ?? { preallocatedSlots: currentSlots }),
      preallocatedSlots: nextSlots,
    },
    updatedAt: new Date().toISOString(),
  };
  await writeFile(envPaths.config, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
  console.log(chalk.green(`✓ Updated preallocated tenant slots: ${currentSlots} -> ${nextSlots}`));

  await deployCommand({
    env,
    config: envPaths.config,
    source: baseDir,
    yes: true,
  });
}
