import type { D1Database } from '@cloudflare/workers-types';
import { loadVerifiedPluginRunnerRegistry } from '@authrim/ar-lib-core/control-plane';
import { PluginHookBackendRouter } from './backend-router';
import { createBuiltinNotifierRegistry } from './builtin-notifiers';
import { D1PluginDispatchLimiter } from './dispatch-limiter';
import {
  DynamicWorkerPluginBackend,
  type PluginHostInterfaceEnvFactory,
  type PluginOutboundFactory,
} from './dynamic-worker-backend';
import { R2PluginWorkerCodeResolver } from './dynamic-worker-code';
import { D1PluginInstallationResolver } from './installations';
import {
  D1NotificationIntentDeliveryStore,
  notificationPrivateJwksFromEnv,
} from './notification-intent';
import { D1PluginHookOutboxStore, PluginHookOutboxDispatcher } from './outbox';
import type { PluginRunnerEnv } from './types';

const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,120}$/u;

export interface ImmediateNotificationDeliveryInput {
  tenantId: string;
  intentId: string;
  outboxId: string;
  pluginInstallationId: string;
  bindingRef: string;
}

export type ImmediateNotificationDeliveryResult = 'delivered' | 'pending' | 'permanent_failure';

function tenantDatabase(env: PluginRunnerEnv, bindingRef: string): D1Database {
  if (!SAFE_BINDING.test(bindingRef)) throw new Error('plugin_notification_binding_invalid');
  const candidate = env[bindingRef] as Partial<D1Database> | undefined;
  if (
    !candidate ||
    typeof candidate.prepare !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('plugin_notification_binding_unavailable');
  }
  return candidate as D1Database;
}

export class ImmediateNotificationDeliveryService {
  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly outbound?: PluginOutboundFactory,
    private readonly hostInterfaces?: PluginHostInterfaceEnvFactory
  ) {}

  async deliver(
    input: ImmediateNotificationDeliveryInput
  ): Promise<ImmediateNotificationDeliveryResult> {
    const now = this.now();
    const registry = await loadVerifiedPluginRunnerRegistry({
      store: this.env.TENANT_RUNTIME_REGISTRY,
      environmentId: this.env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
      now,
    });
    const shard = registry.shards.find((candidate) => candidate.bindingRef === input.bindingRef);
    if (!shard) return 'pending';

    const db = tenantDatabase(this.env, shard.bindingRef);
    const installations = new D1PluginInstallationResolver(this.env.PLUGIN_RUNNER_DB);
    const executionScope = {
      bindingRef: shard.bindingRef,
      dataRole: shard.dataRole,
      residencyPartition: shard.residencyPartition,
    } as const;
    const dispatcher = new PluginHookOutboxDispatcher(
      new D1PluginHookOutboxStore(db),
      new PluginHookBackendRouter(
        this.env,
        installations,
        new DynamicWorkerPluginBackend(
          this.env.PLUGIN_LOADER,
          installations,
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
      installations,
      new D1PluginDispatchLimiter(this.env.PLUGIN_RUNNER_DB)
    );
    return dispatcher.processReference({
      ownerId: `immediate-${crypto.randomUUID()}`,
      now,
      outboxId: input.outboxId,
      tenantId: input.tenantId,
      pluginInstallationId: input.pluginInstallationId,
      intentId: input.intentId,
    });
  }
}
