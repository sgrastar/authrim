import type { D1Database } from '@cloudflare/workers-types';
import { createD1Adapter } from '@authrim/ar-lib-core';
import {
  cleanupExpiredPluginHookOutbox,
  loadVerifiedPluginRunnerRegistry,
} from '@authrim/ar-lib-core/control-plane';
import { D1PluginDispatchLimiter } from './dispatch-limiter';
import { PluginHookBackendRouter } from './backend-router';
import { createBuiltinNotifierRegistry } from './builtin-notifiers';
import { D1PluginConfigReencryptor } from './config-reencryption';
import { pluginEncryptionKeyringFromEnv } from './encryption-keyring';
import { DynamicWorkerPluginBackend } from './dynamic-worker-backend';
import type {
  PluginHostInterfaceEnvFactory,
  PluginOutboundFactory,
} from './dynamic-worker-backend';
import { R2PluginWorkerCodeResolver } from './dynamic-worker-code';
import { D1PluginInstallationResolver } from './installations';
import { D1PluginHookOutboxStore, PluginHookOutboxDispatcher } from './outbox';
import {
  cleanupExpiredNotificationDeliveryIntents,
  D1NotificationIntentDeliveryStore,
  notificationPrivateJwksFromEnv,
} from './notification-intent';
import { D1PluginRunnerStateRepository, type ClaimedRunnerShard } from './registry-state';
import type { PluginRunnerEnv } from './types';

const NORMAL_SCAN_LIMIT = 32;
const SHARD_CONCURRENCY = 6;
const MAX_HOOKS_PER_SHARD = 2;
const IDLE_RESCAN_SECONDS = 5 * 60;
const ERROR_RETRY_SECONDS = 60;
const SAFE_BINDING = /^(?:[A-Z][A-Z0-9_]*_)?TDB_[A-Z0-9_]{1,120}$/u;
const NEXT_DUE_SQL = `SELECT MIN(next_due_at) AS next_due_at
  FROM (
    SELECT MIN(CASE
             WHEN status = 'queued' THEN created_at
             WHEN status = 'waiting_retry' THEN next_attempt_at
             WHEN status = 'locked' THEN lease_until
           END) AS next_due_at
      FROM plugin_hook_outbox
     WHERE status IN ('queued', 'waiting_retry', 'locked')
    UNION ALL
    SELECT MIN(delete_after) AS next_due_at
      FROM notification_delivery_intents
  )`;

interface NextDueRow {
  next_due_at: number | string | null;
}

function tenantDatabase(env: PluginRunnerEnv, bindingRef: string): D1Database {
  if (!SAFE_BINDING.test(bindingRef)) {
    throw new Error('plugin_runner_tenant_binding_invalid');
  }
  const candidate = env[bindingRef] as Partial<D1Database> | undefined;
  if (
    !candidate ||
    typeof candidate.prepare !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('plugin_runner_tenant_binding_unavailable');
  }
  return candidate as D1Database;
}

function nextDue(value: number | string | null, now: number): number {
  if (value === null) return now + IDLE_RESCAN_SECONDS;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('plugin_runner_next_due_invalid');
  }
  return Math.max(now, parsed);
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await action(values[index]);
    }
  });
  await Promise.all(workers);
}

export class PluginRunnerScheduler {
  private readonly state: D1PluginRunnerStateRepository;
  private readonly installations: D1PluginInstallationResolver;

  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly outbound?: PluginOutboundFactory,
    private readonly hostInterfaces?: PluginHostInterfaceEnvFactory
  ) {
    this.state = new D1PluginRunnerStateRepository(env.PLUGIN_RUNNER_DB);
    this.installations = new D1PluginInstallationResolver(env.PLUGIN_RUNNER_DB);
  }

  async run(): Promise<void> {
    const now = this.now();
    const registry = await loadVerifiedPluginRunnerRegistry({
      store: this.env.TENANT_RUNTIME_REGISTRY,
      environmentId: this.env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
      now,
    });
    const sweep = await this.state.advanceSweep(registry, now);
    const ownerId = `runner-${crypto.randomUUID()}`;
    if (sweep && sweep.shards.length > 0) {
      const shardIds = sweep.shards.map((shard) => shard.shardId);
      const sweepClaims = await this.state.claimDueShards({
        ownerId,
        now,
        limit: shardIds.length,
        shardIds,
      });
      await mapWithConcurrency(sweepClaims, SHARD_CONCURRENCY, (claim) =>
        this.probeShard(claim, now)
      );
    }
    const deliveryClaims = await this.state.claimDueShards({
      ownerId,
      now,
      limit: NORMAL_SCAN_LIMIT,
    });
    await mapWithConcurrency(deliveryClaims, SHARD_CONCURRENCY, (claim) =>
      this.processShard(claim, now)
    );
    const configReencryptor = new D1PluginConfigReencryptor(
      this.env.PLUGIN_RUNNER_DB,
      pluginEncryptionKeyringFromEnv(this.env),
      () => now
    );
    await configReencryptor.ensureActive();
    await configReencryptor.advanceActive();
  }

  private async probeShard(claim: ClaimedRunnerShard, now: number): Promise<void> {
    let nextDueAt = now + ERROR_RETRY_SECONDS;
    let errorCode: string | undefined;
    try {
      const db = tenantDatabase(this.env, claim.bindingRef);
      const row = await db.withSession('first-primary').prepare(NEXT_DUE_SQL).first<NextDueRow>();
      nextDueAt = nextDue(row?.next_due_at ?? null, now);
    } catch {
      errorCode = 'plugin_runner_shard_probe_failed';
    }
    await this.state.finishShard({ claim, now, nextDueAt, errorCode });
  }

  private async processShard(claim: ClaimedRunnerShard, now: number): Promise<void> {
    let nextDueAt = now + ERROR_RETRY_SECONDS;
    let errorCode: string | undefined;
    try {
      const db = tenantDatabase(this.env, claim.bindingRef);
      const executionScope = {
        bindingRef: claim.bindingRef,
        dataRole: claim.dataRole,
        residencyPartition: claim.residencyPartition,
      } as const;
      const dispatcher = new PluginHookOutboxDispatcher(
        new D1PluginHookOutboxStore(db),
        new PluginHookBackendRouter(
          this.env,
          this.installations,
          new DynamicWorkerPluginBackend(
            this.env.PLUGIN_LOADER,
            this.installations,
            new R2PluginWorkerCodeResolver(this.env.PLUGIN_BUNDLES),
            this.outbound ??
              (() => {
                throw new Error('plugin_worker_outbound_unavailable');
              }),
            executionScope,
            this.hostInterfaces
          ),
          createBuiltinNotifierRegistry(this.env),
          executionScope,
          new D1NotificationIntentDeliveryStore(
            db,
            this.env.AUTHRIM_ENVIRONMENT_NAME,
            notificationPrivateJwksFromEnv(this.env)
          ),
          () => now
        ),
        this.installations,
        new D1PluginDispatchLimiter(this.env.PLUGIN_RUNNER_DB)
      );
      for (let index = 0; index < MAX_HOOKS_PER_SHARD; index += 1) {
        const result = await dispatcher.processOne({ ownerId: claim.ownerId, now });
        if (result === 'idle') break;
      }
      await cleanupExpiredPluginHookOutbox(createD1Adapter(db, 'plugin-outbox-retention'), {
        now,
        limit: 100,
      });
      await cleanupExpiredNotificationDeliveryIntents(db, { now, limit: 100 });
      const row = await db.withSession('first-primary').prepare(NEXT_DUE_SQL).first<NextDueRow>();
      nextDueAt = nextDue(row?.next_due_at ?? null, now);
    } catch {
      errorCode = 'plugin_runner_shard_scan_failed';
    }
    await this.state.finishShard({ claim, now, nextDueAt, errorCode });
  }
}
