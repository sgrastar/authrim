import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { loadLockFileAuto, mergeLockFiles, saveLockFile } from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import { getRequiredR2Buckets, provisionR2Buckets } from '../../core/cloudflare.js';
import { deployCommand } from './deploy.js';

interface R2ProvisionOptions {
  env?: string;
  dryRun?: boolean;
  skipDeploy?: boolean;
  yes?: boolean;
}

export async function r2ProvisionCommand(options: R2ProvisionOptions): Promise<void> {
  const env = options.env ?? 'prod';
  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });

  if (!existsSync(envPaths.config)) {
    console.error(chalk.red(`Config file not found: ${envPaths.config}`));
    process.exit(1);
  }

  const { lock, path: lockPath } = await loadLockFileAuto(baseDir, env);
  if (!lock || !lockPath) {
    console.error(chalk.red(`Lock file not found for environment "${env}".`));
    console.log(chalk.gray('Run authrim-setup init before provisioning R2 buckets.'));
    process.exit(1);
  }

  const config = AuthrimConfigSchema.parse(
    JSON.parse(await readFile(envPaths.config, 'utf-8'))
  ) as AuthrimConfig;
  const requiredBuckets = getRequiredR2Buckets(env);
  const missingBuckets = requiredBuckets.filter((bucket) => !lock.r2?.[bucket.binding]?.name);

  console.log(chalk.bold('\nDedicated R2 bucket provisioning\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Required buckets: ${chalk.cyan(requiredBuckets.length)}`);
  console.log(`Missing buckets:  ${chalk.cyan(missingBuckets.length)}`);

  if (missingBuckets.length > 0) {
    for (const bucket of missingBuckets) {
      console.log(`  • ${bucket.binding}: ${bucket.name}`);
    }
  }

  if (options.dryRun) {
    console.log(chalk.yellow('\nDry run only. No bucket, lock, config, or deployment changes made.'));
    return;
  }

  if (!options.yes) {
    const ok = await confirm({
      message: options.skipDeploy
        ? 'Create missing R2 buckets and update local config/lock?'
        : 'Create missing R2 buckets, update bindings, and deploy workers?',
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  const provisionedBuckets = await provisionR2Buckets(env, {
    existing: lock.r2,
    onProgress: (message) => console.log(chalk.gray(message)),
  });
  const updatedLock = mergeLockFiles(lock, {
    r2: Object.fromEntries(
      provisionedBuckets.map((bucket) => [bucket.binding, { name: bucket.name }])
    ),
  });
  await saveLockFile(updatedLock, lockPath);

  const updatedConfig: AuthrimConfig = {
    ...config,
    features: {
      ...config.features,
      r2: { enabled: true },
    },
    updatedAt: new Date().toISOString(),
  };
  await writeFile(envPaths.config, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');

  console.log(chalk.green('✓ R2 buckets are recorded in the environment lock file.'));
  console.log(chalk.green('✓ R2 feature flag is enabled in config.'));

  if (options.skipDeploy) {
    console.log(chalk.yellow('Skipped deploy. Run authrim-setup deploy to publish bindings.'));
    return;
  }

  await deployCommand({
    env,
    config: envPaths.config,
    source: baseDir,
    yes: true,
  });
}
