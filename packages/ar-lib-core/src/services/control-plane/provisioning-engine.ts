export type ControlProvisioningExecutorIdentity = 'control' | 'setup';
export type ControlProvisioningEffect = 'create_d1' | 'apply_migrations';

export interface ControlProvisioningD1Database {
  uuid: string;
  name: string;
  read_replication?: { mode?: string };
}

export interface ControlProvisioningD1Provider {
  listD1Databases(): Promise<ControlProvisioningD1Database[]>;
  getD1Database(databaseId: string): Promise<ControlProvisioningD1Database>;
  createD1Database(input: {
    name: string;
    primary_location_hint?: string;
    jurisdiction?: string;
  }): Promise<ControlProvisioningD1Database>;
  updateD1Database(
    databaseId: string,
    input: { read_replication: { mode: 'auto' | 'disabled' } }
  ): Promise<ControlProvisioningD1Database>;
}

export interface ControlProvisioningD1Plan {
  databaseName: string;
  jurisdiction?: 'eu' | 'fedramp';
  locationHint?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
  readReplicationMode: 'enabled' | 'disabled';
}

export interface ControlProvisioningD1CreateCheckpoint {
  state: 'not_started' | 'issued' | 'identified';
  providerResourceId: string | null;
}

export interface ControlProvisioningOperationState {
  operationId: string;
  attemptCount: number;
  createdAt: number;
  retryBudgetStartedAt?: number;
}

export interface ControlProvisioningFailure {
  code: string;
  permanent: boolean;
}

export interface ControlProvisioningFailureDecision extends ControlProvisioningFailure {
  disposition: 'retry' | 'blocked';
  nextAttemptAt: number | null;
}

export interface ControlProvisioningEffectExecution<TResult, TState> {
  executor: ControlProvisioningExecutorIdentity;
  effect: ControlProvisioningEffect;
  operation: ControlProvisioningOperationState;
  execute: () => Promise<TResult>;
  onSuccess: (result: TResult) => Promise<TState>;
  onRetry: (decision: ControlProvisioningFailureDecision) => Promise<TState>;
  onBlocked: (decision: ControlProvisioningFailureDecision) => Promise<TState>;
  now: () => number;
}

export const CONTROL_PROVISIONING_RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const MAX_RETRY_DELAY_SECONDS = 60 * 60;

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const status = (error as { status?: unknown }).status;
  return Number.isSafeInteger(status) ? (status as number) : null;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/**
 * Shared provider-failure classification for both the Control Worker and setup operator executor.
 * Adapters may throw different error classes, so only stable status/code fields are inspected.
 */
export function classifyControlProvisioningFailure(
  effect: ControlProvisioningEffect,
  error: unknown
): ControlProvisioningFailure {
  const status = errorStatus(error);
  const code = errorCode(error);
  if (status === 401 || status === 403) {
    return { code: 'cloudflare_d1_capability_rejected', permanent: true };
  }
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return {
      code:
        effect === 'create_d1'
          ? 'cloudflare_d1_request_rejected'
          : 'cloudflare_d1_migration_rejected',
      permanent: true,
    };
  }
  if (effect === 'create_d1') {
    if (code === 'control_daily_d1_budget_exhausted') {
      return { code, permanent: false };
    }
    if (
      code === 'cloudflare_d1_create_missing_id' ||
      code === 'cloudflare_d1_replication_state_mismatch' ||
      code === 'cloudflare_d1_provider_identity_mismatch' ||
      code === 'cloudflare_d1_name_conflict' ||
      code === 'cloudflare_d1_create_outcome_ambiguous' ||
      code === 'control_d1_create_checkpoint_invalid'
    ) {
      return { code, permanent: true };
    }
    return { code: 'cloudflare_d1_request_failed', permanent: false };
  }
  if (
    code.startsWith('migration_artifact_') ||
    code.startsWith('migration_release_') ||
    code.startsWith('migration_sql_') ||
    code.startsWith('migration_history_') ||
    code === 'migration_sentinel_verification_failed'
  ) {
    return { code, permanent: true };
  }
  if (status !== null) {
    return { code: 'cloudflare_d1_migration_failed', permanent: false };
  }
  if (
    code === 'migration_d1_batch_failed' ||
    code === 'migration_d1_query_result_invalid' ||
    code === 'migration_commit_state_unknown' ||
    code === 'control_migration_metadata_write_failed'
  ) {
    return { code, permanent: false };
  }
  return { code: 'control_migration_failed', permanent: false };
}

export function controlProvisioningRetryDelaySeconds(
  operation: ControlProvisioningOperationState
): number {
  const exponential = Math.min(
    MAX_RETRY_DELAY_SECONDS,
    30 * 2 ** Math.min(Math.max(operation.attemptCount - 1, 0), 7)
  );
  const jitterSeed = Array.from(operation.operationId).reduce(
    (total, character) => total + character.charCodeAt(0),
    0
  );
  return exponential + (jitterSeed % Math.max(1, Math.floor(exponential / 4)));
}

export function decideControlProvisioningFailure(input: {
  effect: ControlProvisioningEffect;
  operation: ControlProvisioningOperationState;
  error: unknown;
  failedAt: number;
}): ControlProvisioningFailureDecision {
  const failure = classifyControlProvisioningFailure(input.effect, input.error);
  if (failure.code === 'control_daily_d1_budget_exhausted') {
    return {
      ...failure,
      disposition: 'retry',
      nextAttemptAt: (Math.floor(input.failedAt / 86_400) + 1) * 86_400,
    };
  }
  const budgetStartedAt = input.operation.retryBudgetStartedAt ?? input.operation.createdAt;
  if (
    failure.permanent ||
    input.failedAt - budgetStartedAt >= CONTROL_PROVISIONING_RETRY_BUDGET_SECONDS
  ) {
    return {
      code: failure.permanent
        ? failure.code
        : input.effect === 'create_d1'
          ? 'cloudflare_d1_retry_budget_exhausted'
          : 'control_migration_retry_budget_exhausted',
      permanent: true,
      disposition: 'blocked',
      nextAttemptAt: null,
    };
  }
  return {
    ...failure,
    disposition: 'retry',
    nextAttemptAt: input.failedAt + controlProvisioningRetryDelaySeconds(input.operation),
  };
}

/**
 * Execute one fenced provisioning effect through the same lifecycle for Control and setup.
 * Credential acquisition and provider calls stay in the injected adapter; token material is never
 * part of the lifecycle state or callbacks.
 */
export async function executeControlProvisioningEffect<TResult, TState>(
  input: ControlProvisioningEffectExecution<TResult, TState>
): Promise<TState> {
  if (input.executor !== 'control' && input.executor !== 'setup') {
    throw new Error('control_provisioning_executor_invalid');
  }
  try {
    return await input.onSuccess(await input.execute());
  } catch (error) {
    const decision = decideControlProvisioningFailure({
      effect: input.effect,
      operation: input.operation,
      error,
      failedAt: input.now(),
    });
    return decision.disposition === 'blocked' ? input.onBlocked(decision) : input.onRetry(decision);
  }
}

/**
 * Idempotently create and reflect one D1 database. Both the Control Worker and the setup operator
 * executor call this function; credential selection remains in the injected provider.
 */
export async function ensureControlProvisioningD1(input: {
  plan: ControlProvisioningD1Plan;
  provider: ControlProvisioningD1Provider;
  checkpoint: ControlProvisioningD1CreateCheckpoint;
  reserveCreate: () => Promise<boolean>;
  markCreateIssued: () => Promise<void>;
  markCreateDefinitelyRejected: () => Promise<void>;
  checkpointProviderIdentity: (databaseId: string) => Promise<void>;
}): Promise<string> {
  if (
    (input.checkpoint.state === 'identified') !== Boolean(input.checkpoint.providerResourceId) ||
    (input.checkpoint.state !== 'identified' && input.checkpoint.providerResourceId !== null)
  ) {
    throw new Error('control_d1_create_checkpoint_invalid');
  }

  let database: ControlProvisioningD1Database;
  if (input.checkpoint.state === 'identified') {
    database = await input.provider.getD1Database(input.checkpoint.providerResourceId!);
    if (
      database.uuid !== input.checkpoint.providerResourceId ||
      database.name !== input.plan.databaseName
    ) {
      throw new Error('cloudflare_d1_provider_identity_mismatch');
    }
  } else {
    if (input.checkpoint.state === 'issued') {
      throw new Error('cloudflare_d1_create_outcome_ambiguous');
    }
    if (
      (await input.provider.listD1Databases()).some(
        (candidate) => candidate.name === input.plan.databaseName
      )
    ) {
      throw new Error('cloudflare_d1_name_conflict');
    }
    if (!(await input.reserveCreate())) {
      throw new Error('control_daily_d1_budget_exhausted');
    }
    await input.markCreateIssued();
    try {
      database = await input.provider.createD1Database({
        name: input.plan.databaseName,
        jurisdiction: input.plan.jurisdiction,
        primary_location_hint: input.plan.locationHint,
      });
    } catch (error) {
      const status = errorStatus(error);
      if (
        status === 401 ||
        status === 403 ||
        status === 429 ||
        (status !== null && status >= 400 && status < 500 && status !== 408)
      ) {
        await input.markCreateDefinitelyRejected();
      }
      throw error;
    }
    if (!database.uuid) throw new Error('cloudflare_d1_create_missing_id');
    // Persist the immutable UUID before read-replication changes or any other post-create call.
    // A crash after this point can resume only by exact ID; a crash before it remains ambiguous
    // and must never trigger a second create.
    await input.checkpointProviderIdentity(database.uuid);
    if (database.name !== input.plan.databaseName) {
      throw new Error('cloudflare_d1_provider_identity_mismatch');
    }
  }

  const desiredProviderMode = input.plan.readReplicationMode === 'enabled' ? 'auto' : 'disabled';
  const replicationResult =
    database.read_replication?.mode === desiredProviderMode
      ? database
      : await input.provider.updateD1Database(database.uuid, {
          read_replication: { mode: desiredProviderMode },
        });
  if (replicationResult.read_replication?.mode !== desiredProviderMode) {
    throw new Error('cloudflare_d1_replication_state_mismatch');
  }
  const reflectedDatabase = await input.provider.getD1Database(database.uuid);
  if (
    reflectedDatabase.uuid !== database.uuid ||
    reflectedDatabase.name !== input.plan.databaseName ||
    reflectedDatabase.read_replication?.mode !== desiredProviderMode
  ) {
    throw new Error('cloudflare_d1_replication_state_mismatch');
  }
  return database.uuid;
}
