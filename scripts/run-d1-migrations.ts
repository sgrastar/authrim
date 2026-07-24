#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getD1MigrationStatus,
  findMigrationsRoot,
  runD1Migrations,
  type D1MigrationDatabaseRole,
} from '../packages/setup/src/core/cloudflare.js';
import {
  acquireEnvironmentOperationLock,
  loadLockFileAuto,
} from '../packages/setup/src/core/lock.js';
import { getRootProductVersion } from '../packages/setup/src/core/version.js';
import {
  evaluateReleaseDeploymentGuard,
  releaseDeploymentGuardMessage,
} from '../packages/setup/src/core/release-deployment-guard.js';
import { loadInstalledReleaseMigrationManifest } from '../packages/setup/src/core/release-migrations.js';

interface Arguments {
  database: string;
  directory: string;
  role: D1MigrationDatabaseRole;
  status: boolean;
  env: string;
}

const CORE_EXCLUDED_DIRECTORIES = new Set(['admin', 'archive', 'external', 'pii', 'releases']);

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function parseArguments(argv: string[]): Arguments {
  if (argv.includes('--initial')) {
    throw new Error(
      '--initial is no longer supported; initial schema bootstrap must use authrim-setup deploy.'
    );
  }
  const database = optionValue(argv, '--database');
  const directory = optionValue(argv, '--directory');
  const role = optionValue(argv, '--role') ?? 'core';
  const env = optionValue(argv, '--env');
  if (!database || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(database)) {
    throw new Error('--database must be a non-empty D1 database name');
  }
  if (!directory) throw new Error('--directory is required');
  if (!env || !/^[a-z][a-z0-9-]*$/u.test(env)) {
    throw new Error('--env must be a valid environment name');
  }
  if (role !== 'core' && role !== 'pii' && role !== 'admin') {
    throw new Error('--role must be core, pii, or admin');
  }
  return {
    database,
    directory: resolve(directory),
    role,
    status: argv.includes('--status'),
    env,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseArguments(argv);
  const rootDir = resolve(process.cwd());
  const { lock, path: lockPath } = await loadLockFileAuto(rootDir, input.env);
  if (!lock) {
    throw new Error(`Environment ${input.env} has no lock file.`);
  }
  if (!lock.productVersion && Object.keys(lock.workers ?? {}).length === 0) {
    throw new Error(
      'Initial schema bootstrap must use authrim-setup deploy; standalone D1 migrations require a completed release.'
    );
  }
  if (!Object.values(lock.d1).some((resource) => resource.name === input.database)) {
    throw new Error(
      `Database ${input.database} is not registered in environment ${input.env}'s lock file.`
    );
  }

  const operationLock = input.status
    ? undefined
    : await acquireEnvironmentOperationLock(lockPath, 'manual-d1-migration');
  try {
    let activeLock = lock;
    if (operationLock) {
      const lockedEnvironment = await loadLockFileAuto(rootDir, input.env);
      if (
        !lockedEnvironment.lock ||
        JSON.stringify(lockedEnvironment.lock) !== JSON.stringify(lock)
      ) {
        throw new Error('environment_changed_while_waiting_for_manual_d1_migration_lock');
      }
      activeLock = lockedEnvironment.lock;
    }

    const productVersion = await getRootProductVersion(rootDir);
    const guard = evaluateReleaseDeploymentGuard(activeLock, productVersion, 'manual_migration');
    if (!guard.allowed) {
      throw new Error(releaseDeploymentGuardMessage(guard, productVersion));
    }
    const migrationsRoot = await findMigrationsRoot(rootDir);
    if (!migrationsRoot.path) {
      throw new Error(`Migrations directory not found: ${migrationsRoot.searchPaths.join(', ')}`);
    }
    const release = loadInstalledReleaseMigrationManifest({
      migrationsRoot: migrationsRoot.path,
      productVersion,
      lock: activeLock,
    });
    const streamId =
      input.role === 'core' ? 'd1-core' : input.role === 'pii' ? 'd1-pii' : 'd1-admin';
    const stream = release.manifest.streams.find((candidate) => candidate.id === streamId);
    if (!stream) throw new Error(`release_migration_stream_not_found:${streamId}`);
    const inventoryOptions =
      input.role === 'core' ? { excludeTopLevelDirectories: CORE_EXCLUDED_DIRECTORIES } : {};

    if (input.status) {
      const result = await getD1MigrationStatus(input.database, input.directory, input.role, {
        ...inventoryOptions,
        manifestFiles: stream.files,
        materializeSuperseded: true,
      });
      if (!result.success) throw new Error(result.error ?? 'Could not read D1 migration status');
      for (const migration of result.migrations) {
        console.log(`${migration.status.padEnd(8)} ${migration.filename}`);
      }
      console.log(
        `Applied ${result.counts.applied}, pending ${result.counts.pending}, changed ${result.counts.changed}, orphaned ${result.counts.orphaned}`
      );
      return;
    }

    const result = await runD1Migrations(
      input.database,
      input.directory,
      (message) => console.log(message),
      {
        ...inventoryOptions,
        manifestFiles: stream.files,
        releaseVersion: productVersion,
        backfillLegacyChecksums: !release.draft,
      }
    );
    if (!result.success) throw new Error(result.error ?? 'D1 migration failed');
    console.log(`Applied ${result.appliedCount}; skipped ${result.skippedCount}.`);
  } finally {
    await operationLock?.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
