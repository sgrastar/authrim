import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Pool } from 'pg';
import type { EnvironmentAuthority } from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { createReplicationRpcClient } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { canonicalRestoreJson, readPinnedRestoreFile } from '../import/restore-evidence';
import { replicationSecret } from './plan';
import { replicationAuthorityDatabaseUrl } from './authority-database-url';
import { initializeReplicationAuthorityDatabase } from './initialize';
import { ReplicationJournal, type ReplicationJournalRecord } from './journal';
import {
  parseEnvironmentReplicationPlan,
  type EnvironmentReplicationPlan,
} from './environment-plan';
import {
  advanceEnvironmentReplicationOperation,
  advanceEnvironmentFailover,
  type EnvironmentOperationPlan,
  type EnvironmentOperationProgress,
} from './environment-coordinator';
import { readEnvironmentReplicationInventory } from './environment-inventory-client';
import { createReplicationExportControl } from './export-control-client';
import { downloadReplicationExport } from './export-client';
import { restoreReplicationGeneration } from './restore-generation';

export interface EnvironmentObservedState {
  formatVersion: 2;
  kind: 'initialize' | 'operation';
  planPath: string;
  planSha256: string;
  observedAtMs: number;
  mode: 'initialize' | 'sync' | 'switch' | 'failover';
  journal: ReplicationJournalRecord<EnvironmentOperationProgress> | null;
}
function invalid(): never {
  throw new Error('environment_replication_cli_invalid');
}
export async function readEnvironmentObservation(
  path: string
): Promise<EnvironmentObservedState | null> {
  const stat = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 8 * 1024 * 1024 ||
    (stat.mode & 0o077) !== 0 ||
    !isAbsolute(path) ||
    (await realpath(path)) !== path
  )
    invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = JSON.parse(await file.readFile('utf8')) as EnvironmentObservedState;
    if (
      !value ||
      value.formatVersion !== 2 ||
      !['initialize', 'operation'].includes(value.kind) ||
      !['initialize', 'sync', 'switch', 'failover'].includes(value.mode) ||
      !Number.isSafeInteger(value.observedAtMs) ||
      value.observedAtMs < 0 ||
      !/^[a-f0-9]{64}$/u.test(value.planSha256) ||
      !isAbsolute(value.planPath)
    )
      invalid();
    return value;
  } finally {
    await file.close();
  }
}
async function writeNew(path: string, value: unknown) {
  if ((await realpath(dirname(path))) !== dirname(path)) invalid();
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(canonicalRestoreJson(value));
    await file.sync();
  } finally {
    await file.close();
  }
}
async function saveObservation(path: string, value: EnvironmentObservedState) {
  const prior = await readEnvironmentObservation(path);
  if (!prior) {
    await writeNew(path, value);
    return;
  }
  if (
    prior.planPath !== value.planPath ||
    prior.planSha256 !== value.planSha256 ||
    prior.mode !== value.mode
  )
    invalid();
  const temp = join(dirname(path), `.environment-replication-${randomUUID()}.json`);
  try {
    await writeNew(temp, value);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
export function environmentObservationSummary(value: EnvironmentObservedState) {
  const progress = value.journal?.value;
  return {
    status: value.kind === 'initialize' ? 'initialized' : (progress?.phase ?? 'unknown'),
    scope: 'environment',
    mode: value.mode,
    observedAtMs: value.observedAtMs,
    live: false,
    planSha256: value.planSha256,
    trafficSwitched: false,
    ...(progress
      ? {
          operationId: progress.plan.operationId,
          environmentId: progress.plan.environmentId,
          generationId: progress.generationId,
          tenants: progress.children.length,
          verifiedTenants: progress.children.filter((child) => child.phase === 'verified').length,
          writerAuthorityChanged: progress.writerAuthorityChanged,
        }
      : {}),
  };
}

export function environmentAuthorityClient(
  rpc: ReturnType<typeof createReplicationRpcClient>
): EnvironmentAuthority {
  return {
    initialize: async (payload) =>
      (await rpc('environmentInitialize', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['initialize']>
      >,
    get: async (pairId, environmentId) =>
      (await rpc('environmentGet', { pairId, environmentId })) as Awaited<
        ReturnType<EnvironmentAuthority['get']>
      >,
    enter: async () => {
      throw new Error('controller_cannot_enter');
    },
    complete: async () => {
      throw new Error('controller_cannot_complete');
    },
    beginDrain: async (payload) =>
      (await rpc('environmentBeginDrain', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['beginDrain']>
      >,
    getOperation: async (payload) =>
      (await rpc('environmentGetOperation', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['getOperation']>
      >,
    registerGeneration: async (payload) => {
      const result = (await rpc('environmentRegisterGeneration', payload)) as {
        registered?: boolean;
      };
      if (result?.registered !== true) invalid();
    },
    getGeneration: async (payload) =>
      (await rpc('environmentGetGeneration', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['getGeneration']>
      >,
    verifyGeneration: async (payload, proof) =>
      (await rpc('environmentVerifyGeneration', { ...payload, proof })) as Awaited<
        ReturnType<EnvironmentAuthority['verifyGeneration']>
      >,
    promote: async (payload) =>
      (await rpc('environmentPromote', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['promote']>
      >,
    cancelDrain: async (payload) =>
      (await rpc('environmentCancelDrain', payload)) as Awaited<
        ReturnType<EnvironmentAuthority['cancelDrain']>
      >,
    getServingGeneration: async () => {
      throw new Error('controller_cannot_serve');
    },
  };
}

/** Called only after the main CLI has pinned the actual plan bytes and executable. */
export async function runEnvironmentReplicationCommand(input: {
  command: string;
  planPath: string;
  planSha256: string;
  statePath: string;
  rawPlan: string;
  executorSha256: string;
  environment: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const plan: EnvironmentReplicationPlan = parseEnvironmentReplicationPlan(
    input.rawPlan,
    input.executorSha256
  );
  const config = plan.configuration;
  const prior = await readEnvironmentObservation(input.statePath);
  if (prior && (prior.planPath !== input.planPath || prior.planSha256 !== input.planSha256))
    invalid();
  const cancel = input.command === 'cancel';
  const mode = input.command === 'resume' || cancel ? (prior?.mode ?? invalid()) : input.command;
  if (
    !['initialize', 'sync', 'switch', 'failover'].includes(mode) ||
    (prior && prior.mode !== mode) ||
    (cancel && !['switch', 'failover'].includes(mode))
  )
    invalid();
  const secret = (name: string) => replicationSecret(input.environment, name);
  const pool = new Pool({
    connectionString: replicationAuthorityDatabaseUrl(config.authority, mode, secret),
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30_000,
  });
  pool.on('error', () => undefined);
  const authority = environmentAuthorityClient(
    createReplicationRpcClient({
      endpoint: config.authority.endpoint,
      credentialId: config.authority.credentialId,
      secret: secret(config.authority.secretEnv),
    })
  );
  const observe = async (
    journal: ReplicationJournalRecord<EnvironmentOperationProgress> | null
  ) => {
    const value: EnvironmentObservedState = {
      formatVersion: 2,
      kind: mode === 'initialize' ? 'initialize' : 'operation',
      planPath: input.planPath,
      planSha256: input.planSha256,
      observedAtMs: Date.now(),
      mode: mode as EnvironmentObservedState['mode'],
      journal,
    };
    await saveObservation(input.statePath, value);
    return value;
  };
  try {
    if (mode === 'initialize') {
      const bootstrap = config.authority.bootstrap;
      await initializeReplicationAuthorityDatabase(
        pool,
        plan.authoritySchemaSha256,
        bootstrap && { serviceRole: bootstrap.serviceRole, journalRole: bootstrap.journalRole }
      );
      await authority.initialize(config.pair);
      process.stdout.write(
        `${canonicalRestoreJson(environmentObservationSummary(await observe(null)))}\n`
      );
      return;
    }
    const expectedPlan: EnvironmentOperationPlan = {
      operationId: `${plan.planId}:${mode}`,
      pairId: config.pair.pairId,
      environmentId: config.pair.environmentId,
      sourceDeploymentId: config.sourceDeploymentId,
      destinationDeploymentId: config.destinationDeploymentId,
      expectedEpoch: config.expectedEpoch,
      mode: mode as EnvironmentOperationPlan['mode'],
    };
    const initial: EnvironmentOperationProgress = {
      formatVersion: 2,
      plan: expectedPlan,
      phase: 'pending',
      generationId: randomUUID(),
      children: [],
      writerAuthorityChanged: false,
    };
    const selectedTenant = (tenantId: string) =>
      config.tenants.find((tenant) => tenant.pair.tenantId === tenantId) ?? invalid();
    await new ReplicationJournal(pool, 'environment').withOperation({
      pairId: config.pair.pairId,
      operationId: expectedPlan.operationId,
      planSha256: input.planSha256,
      initial,
      async run(journal) {
        const checkpoint = {
          current: () => journal.current(),
          async save(value: EnvironmentOperationProgress) {
            const result = await journal.save(value);
            await observe(result);
            return result;
          },
        };
        await observe(journal.current());
        if (cancel) {
          const before = journal.current().value;
          if (before.writerAuthorityChanged || before.phase === 'complete' || !before.cutover)
            invalid();
          const cutover = await authority.cancelDrain({
            pairId: config.pair.pairId,
            environmentId: config.pair.environmentId,
            operationId: expectedPlan.operationId,
          });
          if (cutover.state !== 'cancelled') invalid();
          await checkpoint.save({
            ...before,
            cutover,
            phase: 'cancelled',
            writerAuthorityChanged: false,
          });
        } else if (mode === 'failover') {
          const approval = config.failover ?? invalid();
          const bytes = await readPinnedRestoreFile(
            approval.standbyStatePath,
            approval.standbyStateSha256,
            8 * 1024 * 1024
          );
          const reviewed = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          ) as EnvironmentObservedState;
          if (
            reviewed.formatVersion !== 2 ||
            reviewed.kind !== 'operation' ||
            reviewed.mode !== 'sync' ||
            !reviewed.journal ||
            reviewed.journal.planSha256 !== reviewed.planSha256 ||
            reviewed.journal.value.inventory?.tenants.length !== config.tenants.length ||
            reviewed.journal.value.inventory.tenants.some(
              (tenant, index) =>
                tenant.tenantId !== config.tenants[index].pair.tenantId ||
                tenant.issuer !== config.tenants[index].source.identity.issuer ||
                tenant.productVersion !== config.tenants[index].source.identity.productVersion
            )
          )
            invalid();
          await advanceEnvironmentFailover({
            expectedPlan,
            authority,
            checkpoint,
            reviewedStandby: { planSha256: reviewed.planSha256, progress: reviewed.journal.value },
            maximumSnapshotAgeMs: approval.maximumSnapshotAgeMs,
          });
        } else {
          await advanceEnvironmentReplicationOperation({
            expectedPlan,
            authority,
            checkpoint,
            maximumSnapshotAgeMs: config.maxSnapshotAgeMs,
            source: {
              inventory: (minimumObservedAtMs) =>
                readEnvironmentReplicationInventory({
                  configuration: config,
                  credential: secret(config.inventory.credentialEnv),
                  minimumObservedAtMs,
                }),
              advance(tenantId, idempotencyKey) {
                const child = selectedTenant(tenantId);
                return createReplicationExportControl({
                  origin: child.source.managementOrigin,
                  grantId: child.source.grantId,
                  tenantId,
                  credential: secret(child.source.credentialEnv),
                  passphrase: secret(child.source.passphraseEnv),
                }).advance(idempotencyKey);
              },
              download(tenantId, operationId, minimumBoundaryUnixMs) {
                const child = selectedTenant(tenantId);
                return downloadReplicationExport({
                  managementOrigin: child.source.managementOrigin,
                  grantId: child.source.grantId,
                  operationId,
                  authorization: `Bearer ${secret(child.source.credentialEnv)}`,
                  expectedSource: child.source.identity,
                  maxSnapshotAgeMs: config.maxSnapshotAgeMs,
                  minimumBoundaryUnixMs,
                  outputDirectory: join(
                    dirname(input.statePath),
                    `environment-export-${randomUUID()}`
                  ),
                });
              },
            },
            target: {
              restore(value) {
                const configuration = selectedTenant(value.tenantId);
                return restoreReplicationGeneration({
                  configuration,
                  environment: input.environment,
                  snapshot: value.snapshot,
                  generationId: value.restoreId,
                  servingEpoch: value.servingEpoch,
                  environmentWriter: {
                    version: 2,
                    endpoint: config.authority.endpoint,
                    credentialId: configuration.destination.writerCredentialId,
                    pairId: config.pair.pairId,
                    environmentId: config.pair.environmentId,
                    deploymentId: config.destinationDeploymentId,
                    generationId: value.generationId,
                    epoch: value.servingEpoch,
                    tenantId: value.tenantId,
                    restoreId: value.restoreId,
                  },
                });
              },
            },
          });
        }
        process.stdout.write(
          `${canonicalRestoreJson(environmentObservationSummary(await observe(journal.current())))}\n`
        );
      },
    });
  } finally {
    await pool.end();
  }
}
