import type { ExecutionContext } from '@cloudflare/workers-types';
import { withReplicationStorageBindings } from '../deployment-replication/write-effects';
import type { SamlDrWriterInventoryReceipt } from './saml-dr-writer-contract';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  runRequiredTenantBackupCoveredEffect,
  withTenantBackupMutationCoverage,
  type TenantBackupMutationCoverage,
} from './covered-mutation';
import type { ControlServiceBinding } from '../control-plane/control-plane-contracts';
import {
  hasReplicationWriterConfiguration,
  runReplicationWriterOperation,
  type ReplicationWriterEnv,
} from '../deployment-replication/writer';

export interface SamlDrWriterEnv extends ReplicationWriterEnv {
  ENABLE_SAML_DR_EXPORT?: string;
  TENANT_BACKUP_WRAPPING_KEY?: string;
  SAML_DR_MUTATION_CONTROL?: Pick<
    ControlServiceBinding,
    'acquireEnvironmentBackupMutationPermit' | 'completeEnvironmentBackupMutationPermit'
  >;
}

export interface SamlDrCoverageEnv extends SamlDrWriterEnv {
  AUTHRIM_ENVIRONMENT_NAME?: string;
  CONTROL?: Pick<ControlServiceBinding, 'inspectSamlDrWriterCoverage'>;
}

interface OwnedOperation {
  environments: Set<object>;
  pending: Set<Promise<unknown>>;
  active: boolean;
}
// Async-local ownership is isolated between simultaneous RPCs, even on the same DO instance.
const ownedOperation = new AsyncLocalStorage<OwnedOperation>();

function trackedContext<C extends Pick<ExecutionContext, 'waitUntil'>>(
  context: C | undefined,
  owner: OwnedOperation
): C | undefined {
  return (
    context &&
    new Proxy(context, {
      get(target, property) {
        if (property === 'waitUntil')
          return (effect: Promise<unknown>) => {
            const promise = Promise.resolve(effect);
            owner.pending.add(promise);
            target.waitUntil(promise.catch(() => undefined));
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value.bind(target) as unknown) : value;
      },
    })
  );
}

/** Track a started effect even when its caller intentionally does not await it. */
export function samlDrTrackEffect<T>(effect: Promise<T>): Promise<T> {
  const owner = ownedOperation.getStore();
  if (owner?.active) {
    // The caller owns success/retry/error semantics; the guard only owns effect lifetime.
    owner.pending.add(effect.catch(() => undefined));
  }
  return effect;
}

/** Keep sibling effects owned even when Promise.all rejects before they settle. */
export function samlDrAll<T extends readonly unknown[] | []>(
  values: T
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const owner = ownedOperation.getStore();
  if (owner?.active) {
    for (const value of values) owner.pending.add(Promise.resolve(value).catch(() => undefined));
  }
  return Promise.all(values);
}

/** Register effects from class entrypoints whose native ctx cannot be replaced. */
export function samlDrWaitUntil(
  context: Pick<ExecutionContext, 'waitUntil'>,
  effect: Promise<unknown>
): void {
  const owner = ownedOperation.getStore();
  if (!owner?.active) {
    context.waitUntil(effect);
    return;
  }
  owner.pending.add(effect);
  context.waitUntil(effect.catch(() => undefined));
}

/** Keep the permit until every request-owned deferred storage effect settles. */
export async function runSamlDrCoveredOperation<
  T,
  E extends SamlDrWriterEnv,
  C extends Pick<ExecutionContext, 'waitUntil'>,
>(
  env: E,
  context: C | undefined,
  operation: (env: E, context: C | undefined) => Promise<T>
): Promise<T> {
  const backupEnabled = env.ENABLE_SAML_DR_EXPORT === 'true';
  if (!backupEnabled && !hasReplicationWriterConfiguration(env)) return operation(env, context);
  if (backupEnabled && !env.SAML_DR_MUTATION_CONTROL) throw new Error('saml_dr_writer_unavailable');
  const current = ownedOperation.getStore();
  if (current?.active && current.environments.has(env)) {
    const effect = Promise.resolve().then(() => operation(env, trackedContext(context, current)));
    current.pending.add(effect.catch(() => undefined));
    return effect;
  }
  const coverage: TenantBackupMutationCoverage = { environment: true };
  const runOwned = async () => {
    const covered = withReplicationStorageBindings(
      backupEnabled ? withTenantBackupMutationCoverage(env, coverage) : env
    );
    const owner: OwnedOperation = {
      environments: new Set([env, covered]),
      pending: new Set(),
      active: true,
    };
    return ownedOperation.run(owner, async () => {
      let result!: T;
      let failed = false;
      let failure: unknown;
      try {
        result = await operation(covered, trackedContext(context, owner));
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        while (owner.pending.size) {
          const batch = [...owner.pending];
          const results = await Promise.allSettled(batch);
          for (let index = 0; index < batch.length; index++) {
            owner.pending.delete(batch[index]);
            const observed = results[index];
            if (observed.status === 'rejected' && !failed) {
              failed = true;
              failure = observed.reason;
            }
          }
        }
        if (failed) throw failure;
        return result;
      } finally {
        owner.active = false;
      }
    });
  };
  // The backup admission comes first. Its refusal happens before any write, while an exception
  // inside the replication permit is kept as an unconfirmed write: a refusal that came after
  // the permit would leave it open and block a later switch of the primary.
  return backupEnabled
    ? runRequiredTenantBackupCoveredEffect(
        { CONTROL: env.SAML_DR_MUTATION_CONTROL },
        coverage,
        () => runReplicationWriterOperation(env, runOwned)
      )
    : runReplicationWriterOperation(env, runOwned);
}

export async function runSamlDrCoveredFetch<
  E extends SamlDrWriterEnv,
  C extends Pick<ExecutionContext, 'waitUntil'>,
>(
  env: E | undefined,
  context: C | undefined,
  fetch: (env: E | undefined, context: C | undefined) => Promise<Response>
): Promise<Response> {
  if (!env || (env.ENABLE_SAML_DR_EXPORT !== 'true' && !hasReplicationWriterConfiguration(env)))
    return fetch(env, context);
  try {
    return await runSamlDrCoveredOperation(env, context, fetch);
  } catch {
    return new Response('Service temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    });
  }
}

/** Read-only provider evidence is acquired before the hold and rechecked after release. */
export async function assertSamlDrWriterCoverage(
  env: SamlDrCoverageEnv,
  tenantId: string,
  signal?: AbortSignal,
  expectedReceipt?: SamlDrWriterInventoryReceipt
): Promise<SamlDrWriterInventoryReceipt> {
  signal?.throwIfAborted();
  if (env.ENABLE_SAML_DR_EXPORT !== 'true' || !env.CONTROL?.inspectSamlDrWriterCoverage)
    throw new Error('saml_dr_writer_inventory_unverified');
  const receipt = await env.CONTROL.inspectSamlDrWriterCoverage({
    tenantId,
    ...(expectedReceipt ? { expectedReceipt } : {}),
  });
  signal?.throwIfAborted();
  if (
    !receipt ||
    receipt.formatVersion !== 1 ||
    receipt.tenantId !== tenantId ||
    receipt.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
    !/^[a-f0-9]{64}$/.test(receipt.inventoryDigest) ||
    !Array.isArray(receipt.workers) ||
    !receipt.workers.length ||
    !Array.isArray(receipt.protectedResources) ||
    !receipt.protectedResources.length
  )
    throw new Error('saml_dr_writer_inventory_unverified');
  if (expectedReceipt && receipt.inventoryDigest !== expectedReceipt.inventoryDigest)
    throw new Error('saml_dr_writer_inventory_changed');
  return receipt;
}
