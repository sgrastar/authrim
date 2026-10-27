import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { DeploymentAuthority } from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { createReplicationRpcClient } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { canonicalRestoreJson, readPinnedRestoreFile } from '../import/restore-evidence';
import { replicationAuthorityDatabaseUrl } from './authority-database-url';
export { replicationAuthorityDatabaseUrl } from './authority-database-url';
import {
  createReplicationPlan,
  parseReplicationPlan,
  replicationPlanDigest,
  replicationSecret,
  type ReplicationPlan,
} from './plan';
import { initializeReplicationAuthorityDatabase } from './initialize';
import { ReplicationJournal, type ReplicationJournalRecord } from './journal';
import {
  advanceReplicationOperation,
  type ReplicationOperationPlan,
  type ReplicationOperationProgress,
} from './coordinator';
import { createReplicationExportControl } from './export-control-client';
import { downloadReplicationExport } from './export-client';
import { restoreReplicationGeneration } from './restore-generation';
import { advanceReplicationFailover } from './failover';
import {
  createEnvironmentReplicationPlan,
  environmentReplicationPlanDigest,
} from './environment-plan';
import {
  readEnvironmentObservation,
  environmentObservationSummary,
  runEnvironmentReplicationCommand,
} from './environment-cli';

interface ObservedState {
  formatVersion: 1;
  kind: 'initialize' | 'operation';
  planPath: string;
  planSha256: string;
  observedAtMs: number;
  mode: 'initialize' | 'sync' | 'switch' | 'failover';
  journal: ReplicationJournalRecord<ReplicationOperationProgress> | null;
}

function invalid(): never {
  throw new Error('replication_cli_invalid');
}
function options(args: readonly string[]): Record<string, string> & { command: string } {
  const [command, ...values] = args;
  const keys =
    command === 'plan'
      ? ['config', 'out']
      : command === 'status'
        ? ['state']
        : ['initialize', 'sync', 'switch', 'failover', 'resume', 'cancel'].includes(command)
          ? ['plan', 'plan-sha256', 'state']
          : invalid();
  if (values.length !== keys.length * 2) invalid();
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index].slice(2);
    const value = values[index + 1];
    if (
      !values[index].startsWith('--') ||
      !keys.includes(name) ||
      result[name] !== undefined ||
      !value ||
      (name === 'plan-sha256'
        ? !/^[a-f0-9]{64}$/u.test(value)
        : !isAbsolute(value) || resolve(value) !== value)
    )
      invalid();
    result[name] = value;
  }
  return { command, ...result };
}

async function readJson(path: string): Promise<unknown> {
  if (!isAbsolute(path) || (await realpath(path)) !== path) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) invalid();
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

async function writeNew(path: string, value: unknown): Promise<void> {
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

async function observation(path: string): Promise<ObservedState | null> {
  const stat = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) invalid();
  const value = (await readJson(path)) as ObservedState;
  if (
    !value ||
    value.formatVersion !== 1 ||
    !['initialize', 'operation'].includes(value.kind) ||
    !['initialize', 'sync', 'switch', 'failover'].includes(value.mode) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    !/^[a-f0-9]{64}$/u.test(value.planSha256) ||
    !isAbsolute(value.planPath)
  )
    invalid();
  return value;
}

export async function saveReplicationObservation(path: string, value: ObservedState) {
  const prior = await observation(path);
  if (
    prior &&
    (prior.planPath !== value.planPath ||
      prior.planSha256 !== value.planSha256 ||
      prior.mode !== value.mode)
  )
    invalid();
  // Claim the observation path exclusively before its first checkpoint. Two different pairs
  // must not overwrite each other's local resume handle even though their DB locks differ.
  if (!prior) {
    await writeNew(path, value);
    return;
  }
  const temp = join(dirname(path), `.replication-state-${randomUUID()}.json`);
  try {
    await writeNew(temp, value);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

function authorityClient(rpc: ReturnType<typeof createReplicationRpcClient>): DeploymentAuthority {
  return {
    initialize: async (definition) =>
      (await rpc('initialize', definition)) as Awaited<
        ReturnType<DeploymentAuthority['initialize']>
      >,
    get: async (pairId, tenantId) =>
      (await rpc('get', { pairId, tenantId })) as Awaited<ReturnType<DeploymentAuthority['get']>>,
    enter: async () => {
      throw new Error('controller_cannot_enter');
    },
    complete: async () => {
      throw new Error('controller_cannot_complete');
    },
    beginDrain: async (request) =>
      (await rpc('beginDrain', request)) as Awaited<ReturnType<DeploymentAuthority['beginDrain']>>,
    beginFailoverDrain: async (request) =>
      (await rpc('beginFailoverDrain', request)) as Awaited<
        ReturnType<DeploymentAuthority['beginFailoverDrain']>
      >,
    registerStandbyGeneration: async (value) => {
      const result = (await rpc('registerStandbyGeneration', value)) as { registered?: boolean };
      if (result?.registered !== true) invalid();
    },
    verifyFailoverGeneration: async (identity, proof) =>
      (await rpc('verifyFailoverGeneration', { ...identity, proof })) as Awaited<
        ReturnType<DeploymentAuthority['verifyFailoverGeneration']>
      >,
    getOperation: async (identity) =>
      (await rpc('getOperation', identity)) as Awaited<
        ReturnType<DeploymentAuthority['getOperation']>
      >,
    verifyGeneration: async (identity, generation) =>
      (await rpc('verifyGeneration', { ...identity, generation })) as Awaited<
        ReturnType<DeploymentAuthority['verifyGeneration']>
      >,
    promote: async (identity) =>
      (await rpc('promote', identity)) as Awaited<ReturnType<DeploymentAuthority['promote']>>,
  };
}

function summary(value: ObservedState) {
  const progress = value.journal?.value;
  return {
    status: value.kind === 'initialize' ? 'initialized' : (progress?.phase ?? 'unknown'),
    mode: value.mode,
    observedAtMs: value.observedAtMs,
    live: false,
    planSha256: value.planSha256,
    ...(progress
      ? {
          operationId: progress.plan.operationId,
          generationId: progress.generationId,
          attempt: progress.attempt,
          writerAuthorityChanged: progress.writerAuthorityChanged,
          outstandingDrain: progress.phase === 'draining',
        }
      : {}),
    trafficSwitched: false,
  };
}

/** Operator entry point. Planning/status are local-only; mutations require an exact reviewed plan. */
export async function runReplicationCli(
  args: readonly string[],
  environment = process.env
): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'replication-cli plan --config ABS --out ABS | status --state ABS | initialize|sync|switch|failover|resume|cancel --plan ABS --plan-sha256 SHA256 --state ABS\n'
    );
    return;
  }
  let pool: Pool | undefined;
  try {
    const argsByName = options(args);
    const command = argsByName.command;
    const executorSha256 = createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex');
    if (command === 'plan') {
      const configuration = await readJson(argsByName.config);
      if ((configuration as { formatVersion?: unknown })?.formatVersion === 2) {
        const plan = await createEnvironmentReplicationPlan(configuration, executorSha256);
        await writeNew(argsByName.out, plan);
        process.stdout.write(
          `${canonicalRestoreJson({ status: 'planned', scope: 'environment', planId: plan.planId, planSha256: environmentReplicationPlanDigest(plan), cloudChanges: false })}\n`
        );
        return;
      }
      const plan = await createReplicationPlan(configuration, executorSha256);
      await writeNew(argsByName.out, plan);
      process.stdout.write(
        `${canonicalRestoreJson({ status: 'planned', planId: plan.planId, planSha256: replicationPlanDigest(plan), cloudChanges: false })}\n`
      );
      return;
    }
    if (command === 'status') {
      const rawState = await readJson(argsByName.state);
      if ((rawState as { formatVersion?: unknown })?.formatVersion === 2) {
        const value = (await readEnvironmentObservation(argsByName.state)) ?? invalid();
        process.stdout.write(`${canonicalRestoreJson(environmentObservationSummary(value))}\n`);
        return;
      }
      const value = (await observation(argsByName.state)) ?? invalid();
      process.stdout.write(`${canonicalRestoreJson(summary(value))}\n`);
      return;
    }
    const raw = await readPinnedRestoreFile(
      argsByName.plan,
      argsByName['plan-sha256'],
      8 * 1024 * 1024
    );
    const rawPlan = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
    if ((JSON.parse(rawPlan) as { formatVersion?: unknown })?.formatVersion === 2) {
      await runEnvironmentReplicationCommand({
        command,
        planPath: argsByName.plan,
        planSha256: argsByName['plan-sha256'],
        statePath: argsByName.state,
        rawPlan,
        executorSha256,
        environment,
      });
      return;
    }
    const plan: ReplicationPlan = parseReplicationPlan(rawPlan, executorSha256);
    const configuration = plan.configuration;
    const prior = await observation(argsByName.state);
    if (
      prior &&
      (prior.planPath !== argsByName.plan || prior.planSha256 !== argsByName['plan-sha256'])
    )
      invalid();
    const mode = command === 'resume' ? (prior?.mode ?? invalid()) : command;
    if (prior && prior.mode !== mode) invalid();
    if (!['initialize', 'sync', 'switch', 'failover'].includes(mode)) invalid();
    const secret = (name: string) => replicationSecret(environment, name);
    const databaseUrl = replicationAuthorityDatabaseUrl(configuration.authority, mode, secret);
    const bootstrap = configuration.authority.bootstrap;
    pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30_000,
    });
    pool.on('error', () => undefined);
    const rpc = createReplicationRpcClient({
      endpoint: configuration.authority.endpoint,
      credentialId: configuration.authority.credentialId,
      secret: secret(configuration.authority.secretEnv),
    });
    const authority = authorityClient(rpc);
    const observe = async (
      journal: ReplicationJournalRecord<ReplicationOperationProgress> | null
    ) => {
      const value: ObservedState = {
        formatVersion: 1,
        kind: mode === 'initialize' ? 'initialize' : 'operation',
        planPath: argsByName.plan,
        planSha256: argsByName['plan-sha256'],
        observedAtMs: Date.now(),
        mode: mode as ObservedState['mode'],
        journal,
      };
      await saveReplicationObservation(argsByName.state, value);
      return value;
    };
    if (mode === 'initialize') {
      await initializeReplicationAuthorityDatabase(
        pool,
        plan.authoritySchemaSha256,
        bootstrap && { serviceRole: bootstrap.serviceRole, journalRole: bootstrap.journalRole }
      );
      await authority.initialize(configuration.pair);
      process.stdout.write(`${canonicalRestoreJson(summary(await observe(null)))}\n`);
      return;
    }
    const expectedPlan: ReplicationOperationPlan = {
      operationId: `${plan.planId}:${mode}`,
      pairId: configuration.pair.pairId,
      tenantId: configuration.pair.tenantId,
      sourceDeploymentId: configuration.sourceDeploymentId,
      destinationDeploymentId: configuration.destinationDeploymentId,
      expectedEpoch: configuration.expectedEpoch,
      mode: mode as 'sync' | 'switch' | 'failover',
    };
    const initial: ReplicationOperationProgress = {
      formatVersion: 1,
      phase: 'pending',
      plan: expectedPlan,
      generationId: randomUUID(),
      attempt: 1,
      writerAuthorityChanged: false,
    };
    // Only controllers can register/observe operation state. Per-pair session locking serializes
    // different plans, and every checkpoint is persisted before its next external side effect.
    await new ReplicationJournal(pool).withOperation({
      pairId: configuration.pair.pairId,
      operationId: expectedPlan.operationId,
      planSha256: argsByName['plan-sha256'],
      initial,
      async run(journal) {
        const checkpoint = {
          current: () => journal.current(),
          async save(value: ReplicationOperationProgress) {
            const saved = await journal.save(value);
            await observe(saved);
            return saved;
          },
        };
        await observe(journal.current());
        if (mode === 'failover') {
          const approval = configuration.failover ?? invalid();
          const bytes = await readPinnedRestoreFile(
            approval.standbyStatePath,
            approval.standbyStateSha256,
            8 * 1024 * 1024
          );
          const observed = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
          ) as ObservedState;
          if (
            observed.formatVersion !== 1 ||
            observed.kind !== 'operation' ||
            observed.mode !== 'sync' ||
            !observed.journal ||
            observed.planSha256 !== observed.journal.planSha256
          )
            invalid();
          await advanceReplicationFailover({
            expectedPlan,
            authority,
            checkpoint,
            reviewedStandby: { planSha256: observed.planSha256, progress: observed.journal.value },
            maximumSnapshotAgeMs: approval.maximumSnapshotAgeMs,
          });
        } else
          await advanceReplicationOperation({
            authority,
            checkpoint,
            expectedPlan,
            source: {
              ...createReplicationExportControl({
                origin: configuration.source.managementOrigin,
                grantId: configuration.source.grantId,
                tenantId: configuration.pair.tenantId,
                credential: secret(configuration.source.credentialEnv),
                passphrase: secret(configuration.source.passphraseEnv),
              }),
              download: (operationId, minimumBoundaryUnixMs) =>
                downloadReplicationExport({
                  managementOrigin: configuration.source.managementOrigin,
                  grantId: configuration.source.grantId,
                  operationId,
                  authorization: `Bearer ${secret(configuration.source.credentialEnv)}`,
                  expectedSource: configuration.source.identity,
                  maxSnapshotAgeMs: configuration.maxSnapshotAgeMs,
                  minimumBoundaryUnixMs,
                  outputDirectory: join(
                    dirname(argsByName.state),
                    `replication-export-${randomUUID()}`
                  ),
                }),
            },
            target: {
              restore: (value) =>
                restoreReplicationGeneration({ configuration, environment, ...value }),
              async register(generation) {
                const result = (await rpc('registerGeneration', generation)) as {
                  registered?: boolean;
                };
                if (result?.registered !== true) invalid();
              },
            },
          });
        process.stdout.write(
          `${canonicalRestoreJson(summary(await observe(journal.current())))}\n`
        );
      },
    });
  } catch {
    // Database/cloud errors may include row data and credentials; only this fixed diagnostic leaves CLI.
    process.stderr.write(
      'replication_operation_failed; inspect the saved state and resume with the same plan\n'
    );
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await runReplicationCli(process.argv.slice(2));
