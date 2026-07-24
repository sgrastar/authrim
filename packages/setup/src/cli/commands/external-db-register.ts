import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { findMigrationsRoot } from '../../core/cloudflare.js';
import { AuthrimConfigSchema, type AuthrimConfig } from '../../core/config.js';
import { hasDatabaseTopologyChange } from '../../core/environment-config-policy.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
  saveLockFile,
} from '../../core/lock.js';
import { findAuthrimBaseDir, getEnvironmentPaths } from '../../core/paths.js';
import {
  calculateReleaseManifestChecksum,
  loadInstalledReleaseMigrationManifest,
  resolveReleaseMigrationTargets,
} from '../../core/release-migrations.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../../core/release-deployment-guard.js';
import { withRecordedReleaseSchemaTargets } from '../../core/release-state.js';
import { getRootProductVersion } from '../../core/version.js';
import { deployCommand } from './deploy.js';
import { assertPendingTopologyUpdate, prepareTopologyUpdate } from '../../core/topology-update.js';
import {
  commitTopologyConfigTransaction,
  readEffectiveTopologyConfig,
  recoverTopologyConfigTransaction,
} from '../../core/topology-config-transaction.js';

export interface ExternalDatabaseRegisterOptions {
  env?: string;
  config?: string;
  externalSchemaReady?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

function nonExternalTopologySnapshot(config: AuthrimConfig): object {
  return {
    ...config,
    updatedAt: undefined,
    profiles: {
      ...config.profiles,
      defaults: { ...config.profiles.defaults, storage: undefined, audit: undefined },
      seed: { ...config.profiles.seed, storage: [], audit: [] },
      references: { ...config.profiles.references, hyperdrive: {} },
    },
  };
}

export async function externalDatabaseRegisterCommand(
  options: ExternalDatabaseRegisterOptions
): Promise<void> {
  const env = options.env ?? 'prod';

  const baseDir = findAuthrimBaseDir(process.cwd());
  const envPaths = getEnvironmentPaths({ baseDir, env });
  if (!existsSync(envPaths.config)) throw new Error(`Config file not found: ${envPaths.config}`);
  const diskConfig = AuthrimConfigSchema.parse(
    JSON.parse(await readFile(envPaths.config, 'utf-8'))
  );
  const plannedEnvironment = await loadLockFileAuto(baseDir, env);
  if (!plannedEnvironment.lock) throw new Error(`Lock file not found for environment "${env}".`);
  const productVersion = await getRootProductVersion(baseDir);
  if (
    plannedEnvironment.lock.topologyUpdate &&
    plannedEnvironment.lock.topologyUpdate.kind !== 'external_database'
  ) {
    throw new Error(`topology_update_pending:${plannedEnvironment.lock.topologyUpdate.kind}`);
  }
  const currentConfig = await readEffectiveTopologyConfig(plannedEnvironment.lock, envPaths.config);
  const resuming = plannedEnvironment.lock.topologyUpdate?.kind === 'external_database';
  if (!options.config && !resuming) throw new Error('external_database_config_required');
  const candidatePath = options.config ? resolve(options.config) : envPaths.config;
  if (!existsSync(candidatePath))
    throw new Error(`Candidate config file not found: ${candidatePath}`);
  const candidateConfig = options.config
    ? AuthrimConfigSchema.parse(JSON.parse(await readFile(candidatePath, 'utf-8')))
    : currentConfig;
  if (candidateConfig.environment.prefix !== env) {
    throw new Error(
      `candidate_config_environment_mismatch:${candidateConfig.environment.prefix}:${env}`
    );
  }
  if (resuming) {
    assertPendingTopologyUpdate(plannedEnvironment.lock, {
      kind: 'external_database',
      targetProductVersion: productVersion,
      config: currentConfig,
    });
  }
  const hasTopologyChange = hasDatabaseTopologyChange(currentConfig, candidateConfig);
  if (!hasTopologyChange && !resuming) {
    throw new Error('candidate_config_has_no_database_topology_change');
  }
  if (resuming && hasTopologyChange) {
    throw new Error('pending_external_database_config_must_match_candidate');
  }
  if (
    JSON.stringify(currentConfig.database) !== JSON.stringify(candidateConfig.database) ||
    JSON.stringify(currentConfig.tenantD1) !== JSON.stringify(candidateConfig.tenantD1)
  ) {
    throw new Error('external_database_command_cannot_change_d1_topology');
  }
  if (
    JSON.stringify(nonExternalTopologySnapshot(currentConfig)) !==
    JSON.stringify(nonExternalTopologySnapshot(candidateConfig))
  ) {
    throw new Error('external_database_command_accepts_only_profile_and_hyperdrive_changes');
  }

  const guard = evaluateReleaseDeploymentGuard(
    plannedEnvironment.lock,
    productVersion,
    'topology_change'
  );
  if (!guard.allowed) throw new Error(releaseDeploymentGuardMessage(guard, productVersion));

  const migrationsRoot = await findMigrationsRoot(baseDir);
  if (!migrationsRoot.path) throw new Error('Release migrations directory not found.');
  const installedRelease = loadInstalledReleaseMigrationManifest({
    migrationsRoot: migrationsRoot.path,
    productVersion,
    lock: plannedEnvironment.lock,
  });
  const manifestChecksum = calculateReleaseManifestChecksum(installedRelease.manifest);
  const externalTargets = resolveReleaseMigrationTargets({
    lock: plannedEnvironment.lock,
    config: candidateConfig,
  }).filter((target) => target.scope === 'external');
  const unsupportedTargets = externalTargets.filter((target) => !target.streamId);
  if (unsupportedTargets.length > 0) {
    throw new Error(
      `external_database_release_stream_missing:${unsupportedTargets
        .map((target) => target.connectionRef ?? target.id)
        .join(',')}`
    );
  }
  const targetsNeedingAcknowledgement = externalTargets.filter((target) => {
    const state = plannedEnvironment.lock?.schemaTargets?.[target.id];
    return (
      !state ||
      state.productVersion !== productVersion ||
      state.manifestChecksum !== manifestChecksum ||
      state.streamId !== target.streamId
    );
  });
  if (targetsNeedingAcknowledgement.length > 0 && options.externalSchemaReady !== true) {
    throw new Error(
      `external_database_schema_acknowledgement_required:${targetsNeedingAcknowledgement
        .map((target) => target.connectionRef ?? target.id)
        .join(',')}`
    );
  }

  console.log(chalk.bold('\nExternal database topology registration\n'));
  console.log(`Environment: ${chalk.cyan(env)}`);
  console.log(`Installed release: ${chalk.cyan(productVersion)}`);
  for (const target of externalTargets) {
    console.log(`  • ${target.connectionRef ?? target.id}: ${target.streamId}`);
  }
  if (options.dryRun) {
    console.log(chalk.yellow('\nDry run only. No config, lock, or Worker changes made.'));
    return;
  }
  if (!options.yes) {
    const accepted = await confirm({
      message: 'Register the acknowledged external schemas and deploy affected Worker bindings?',
      default: false,
    });
    if (!accepted) return;
  }

  const operationLock = await acquireEnvironmentOperationLock(
    plannedEnvironment.path,
    'external-db-register'
  );
  try {
    const lockedEnvironment = await loadLockFileAuto(baseDir, env);
    const lockedConfig = AuthrimConfigSchema.parse(
      JSON.parse(await readFile(envPaths.config, 'utf-8'))
    );
    if (
      !lockedEnvironment.lock ||
      JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(plannedEnvironment.lock) ||
      JSON.stringify(lockedConfig) !== JSON.stringify(diskConfig)
    ) {
      throw new Error('environment_changed_while_waiting_for_external_database_lock');
    }
    const registeredLock = withRecordedReleaseSchemaTargets(lockedEnvironment.lock, {
      productVersion,
      manifest: installedRelease.manifest,
      targets: externalTargets,
      targetIds: new Set(targetsNeedingAcknowledgement.map((target) => target.id)),
      manualTargetIds: new Set(targetsNeedingAcknowledgement.map((target) => target.id)),
    });
    const persistedConfig: AuthrimConfig = resuming
      ? currentConfig
      : { ...candidateConfig, updatedAt: new Date().toISOString() };
    if (!resuming) {
      await commitTopologyConfigTransaction({
        lock: registeredLock,
        lockPath: plannedEnvironment.path,
        configPath: envPaths.config,
        kind: 'external_database',
        targetProductVersion: productVersion,
        config: persistedConfig,
      });
    } else if (lockedEnvironment.lock.topologyUpdate?.phase === 'config_staged') {
      await recoverTopologyConfigTransaction({
        lock: registeredLock,
        lockPath: plannedEnvironment.path,
        configPath: envPaths.config,
        kind: 'external_database',
        targetProductVersion: productVersion,
      });
    } else {
      const pending = prepareTopologyUpdate(registeredLock, {
        kind: 'external_database',
        targetProductVersion: productVersion,
        config: persistedConfig,
      });
      await saveLockFile(pending.lock, plannedEnvironment.path);
    }
  } finally {
    await operationLock.release();
  }

  await deployCommand({
    env,
    config: envPaths.config,
    source: baseDir,
    yes: true,
    operationKind: 'topology_change',
  });
}
