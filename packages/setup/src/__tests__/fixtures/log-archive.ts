import { vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['pipeline', 'scheduled'],
}));

import { createDefaultConfig, parseConfig, type AuthrimConfig } from '../../core/config.js';
import {
  createLogArchiveConfig,
  logArchiveRuntimeVars,
  type LogArchiveLock,
  LOG_ARCHIVE_PRODUCER_COMPONENTS,
} from '../../core/log-archive-config.js';
import { LOG_ARCHIVE_SCHEMA_DIGEST } from '../../core/log-archive.js';
import { generateWranglerConfig, type ResourceIds } from '../../core/wrangler.js';
import { WORKER_COMPONENTS } from '../../core/naming.js';

const accountId = 'a'.repeat(32);
const generation = 'ba430128-4087-4a8a-8792-001000000001';

/** Explicit new-install state for tests that are about other Setup behavior. */
export function selectScheduledArchive(config: AuthrimConfig): AuthrimConfig {
  config.logging = { archive: createLogArchiveConfig(config.environment.prefix, 'scheduled') };
  config.logging.archive.storageGeneration = generation;
  config.logging.archive.tableName = `logs_v1_${generation.replaceAll('-', '')}`;
  config.logging.archive.activatedAt = '2026-10-27T00:00:00.000Z';
  config.features.r2.enabled = true;
  return config;
}

export function archiveLockFixture(
  config: AuthrimConfig,
  accountOverride?: string
): LogArchiveLock {
  const archive = config.logging!.archive;
  const account = accountOverride ?? config.cloudflare.accountId ?? accountId;
  const warehouse = `${account}_${archive.bucketName}`;
  return {
    mode: archive.mode,
    storageGeneration: archive.storageGeneration,
    activatedAt: archive.activatedAt,
    schemaVersion: archive.schemaVersion,
    schemaDigest: LOG_ARCHIVE_SCHEMA_DIGEST,
    accountId: account,
    bucketName: archive.bucketName,
    namespace: archive.namespace,
    tableName: archive.tableName,
    catalogUri: `https://catalog.cloudflarestorage.com/${account}/${archive.bucketName}`,
    warehouse,
    catalog: { id: 'fixture-catalog-id', name: warehouse },
    activation: {
      basis: 'new_owned_empty_table',
      tableUuid: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
      schemaId: 0,
      specId: 0,
      schemaSpecFingerprint: 'b'.repeat(64),
      metadataLocation: `s3://${archive.bucketName}/authrim/${archive.tableName}/metadata/00000.json`,
      checkedAt: '2026-10-27T00:00:01.000Z',
    },
    maintenance: {
      policyDigest: archive.maintenancePolicyDigest,
      snapshotExpirationState: 'disabled',
      compactionState: 'enabled',
      compactionTargetSizeMb: 64,
      nextEligibleAt: null,
      inFlightJobs: 'unverified',
    },
  };
}

export function archiveResourceIds(config: AuthrimConfig, resources: ResourceIds): ResourceIds {
  return {
    ...resources,
    d1: {
      DB_ADMIN: {
        id: 'fixture-admin-db-id',
        name: `${config.environment.prefix}-authrim-admin-db`,
      },
      ...resources.d1,
    },
    logArchive: resources.logArchive ?? archiveLockFixture(config),
    r2: { ...resources.r2, LOG_ARCHIVE: { name: config.logging!.archive.bucketName } },
  };
}

/** Installs new-mode evidence into an existing deployment fixture; no provider operations. */
export async function writeDeploymentArchiveFixture(
  rootDir: string,
  env: string,
  options: { refreshMaster?: boolean } = {}
): Promise<void> {
  const directory = join(rootDir, '.authrim', env);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, 'config.json');
  const input = existsSync(configPath)
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : createDefaultConfig(env);
  const config = selectScheduledArchive(
    parseConfig(input.environment ? input : createDefaultConfig(env))
  );
  await writeFile(configPath, JSON.stringify(config));
  const lockPath = join(directory, 'lock.json');
  const lock = existsSync(lockPath)
    ? JSON.parse(await readFile(lockPath, 'utf8'))
    : { version: '1.0.0', env, createdAt: '2026-10-27T00:00:00.000Z', d1: {}, kv: {} };
  lock.logArchive = archiveLockFixture(config);
  lock.r2 = {
    ...lock.r2,
    LOG_ARCHIVE: {
      name: config.logging!.archive.bucketName,
      creationDate: '2026-10-27T00:00:00.000Z',
      ownershipId: '11111111-1111-4111-8111-111111111111',
      ownershipMarkerKey:
        '__authrim_setup__/ownership-v1-11111111-1111-4111-8111-111111111111.json',
    },
  };
  await writeFile(lockPath, JSON.stringify(lock));
  const archive = lock.logArchive as LogArchiveLock;
  const values = Object.entries(logArchiveRuntimeVars(config.logging!.archive, archive)).map(
    ([name, value]) => `${name} = ${JSON.stringify(value)}`
  );
  for (const component of WORKER_COMPONENTS) {
    const path = join(rootDir, 'packages', component, 'wrangler.toml');
    if (!existsSync(path)) continue;
    const lines = (await readFile(path, 'utf8'))
      .split(/\r?\n/u)
      .filter(
        (line) =>
          !line.trim().startsWith('AUTHRIM_LOG_ARCHIVE_') &&
          !/^OBJECT_ENCRYPTION_KEY_VERSION\s*=/u.test(line.trim())
      );
    const header = `[env.${env}.vars]`;
    if (LOG_ARCHIVE_PRODUCER_COMPONENTS.includes(component)) {
      const index = lines.findIndex((line) => line.trim() === header);
      if (index < 0) lines.push('', header, ...values);
      else lines.splice(index + 1, 0, ...values);
    }
    const content = lines.join('\n');
    await writeFile(path, content);
    const bootstrap = join(rootDir, 'packages', component, 'wrangler.bootstrap.toml');
    if (LOG_ARCHIVE_PRODUCER_COMPONENTS.includes(component) && existsSync(bootstrap)) {
      const bootstrapLines = (await readFile(bootstrap, 'utf8'))
        .split(/\r?\n/u)
        .filter(
          (line) =>
            !line.trim().startsWith('AUTHRIM_LOG_ARCHIVE_') &&
            !/^OBJECT_ENCRYPTION_KEY_VERSION\s*=/u.test(line.trim())
        );
      const bootstrapVars = bootstrapLines.findIndex((line) => line.trim() === header);
      if (bootstrapVars < 0) bootstrapLines.push('', header, ...values);
      else bootstrapLines.splice(bootstrapVars + 1, 0, ...values);
      await writeFile(bootstrap, bootstrapLines.join('\n'));
    }
    await mkdir(join(directory, 'wrangler'), { recursive: true });
    const master = join(directory, 'wrangler', `${component}.toml`);
    if (!existsSync(master) || options.refreshMaster) await writeFile(master, content);
  }
}

export function createArchiveTestConfig(prefix: string): AuthrimConfig {
  return selectScheduledArchive(createDefaultConfig(prefix));
}

export function generateArchiveTestWrangler(
  ...args: Parameters<typeof generateWranglerConfig>
): ReturnType<typeof generateWranglerConfig> {
  if (!args[1].logging) selectScheduledArchive(args[1]);
  return generateWranglerConfig(
    args[0],
    args[1],
    archiveResourceIds(args[1], args[2]),
    args[3],
    args[4]
  );
}
