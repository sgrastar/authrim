import { PluginOutboundGateway } from './outbound-gateway';
import { PluginAccountMetadataService } from './account-metadata';
import type { D1NotificationIntentDeliveryStore } from './notification-intent';
import type { D1PluginInstallationResolver } from './installations';
import type {
  PluginEgressContext,
  PluginExecutionBackend,
  PluginHookBackend,
  PluginHookExecutionInvocation,
  PluginHookInvocation,
  PluginNotificationHookReferencePayload,
  PluginRunnerEnv,
  PluginShardExecutionScope,
  WritePluginAccountMetadataInput,
  WritePluginAccountMetadataResult,
} from './types';

function isNotificationReference(
  invocation: PluginHookInvocation
): invocation is PluginHookInvocation & { payload: PluginNotificationHookReferencePayload } {
  return (
    invocation.capability === 'notifier.send' &&
    invocation.eventType === 'notification.delivery.requested' &&
    'intentId' in invocation.payload
  );
}

export interface InProcessPluginAccess {
  signal: AbortSignal;
  fetchExternal(request: Request): Promise<Response>;
  writeAccountMetadata(
    input: WritePluginAccountMetadataInput
  ): Promise<WritePluginAccountMetadataResult>;
}

export type InProcessPluginHookHandler = (
  invocation: PluginHookExecutionInvocation,
  access: InProcessPluginAccess
) => Promise<{ providerMessageId?: string } | void>;

export interface InProcessPluginRegistry {
  resolve(pluginId: string, capability: string): InProcessPluginHookHandler | null;
}

export class StaticInProcessPluginRegistry implements InProcessPluginRegistry {
  constructor(
    private readonly handlers: ReadonlyMap<string, InProcessPluginHookHandler> = new Map()
  ) {}

  resolve(pluginId: string, capability: string): InProcessPluginHookHandler | null {
    return this.handlers.get(`${pluginId}:${capability}`) ?? null;
  }
}

export class PluginHookBackendRouter implements PluginHookBackend {
  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly installations: D1PluginInstallationResolver,
    private readonly dynamicBackend: PluginExecutionBackend,
    private readonly inProcessRegistry: InProcessPluginRegistry,
    private readonly executionScope?: PluginShardExecutionScope,
    private readonly notificationIntents?: D1NotificationIntentDeliveryStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async invoke(invocation: PluginHookInvocation): Promise<void> {
    let target;
    try {
      target = await this.installations.resolveBackend(invocation);
    } catch (error) {
      if (error instanceof Error && error.message === 'plugin_installation_lookup_invalid') {
        throw new Error('plugin_hook_rejected');
      }
      if (error instanceof Error && error.message === 'plugin_installation_timeout_invalid') {
        throw new Error('plugin_hook_provider_rejected');
      }
      throw new Error('plugin_hook_transient_failure');
    }
    if (!target) throw new Error('plugin_hook_provider_rejected');
    const notificationReference = isNotificationReference(invocation);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) throw new Error('plugin_hook_transient_failure');
    let execution: PluginHookExecutionInvocation;
    if (notificationReference) {
      if (!this.notificationIntents) throw new Error('plugin_hook_rejected');
      try {
        const loaded = await this.notificationIntents.load({
          tenantId: invocation.tenantId,
          pluginInstallationId: invocation.pluginInstallationId,
          reference: invocation.payload,
          now,
        });
        if (loaded.state === 'delivered') return;
        execution = {
          ...invocation,
          payload: {
            tenantId: loaded.tenantId,
            intentId: loaded.intentId,
            eventType: 'notification.delivery.requested',
            eventVersion: 1,
            notificationKind: loaded.notificationKind,
            expiresAt: loaded.expiresAt,
            delivery: loaded.payload,
          },
        };
      } catch (error) {
        if (error instanceof Error) {
          const notificationErrorCodes: Record<string, string> = {
            notification_intent_key_unavailable: 'plugin_notification_key_unavailable',
            notification_intent_key_unwrap_failed: 'plugin_notification_key_unwrap_failed',
            notification_intent_payload_authentication_failed:
              'plugin_notification_payload_authentication_failed',
            notification_intent_decryption_failed: 'plugin_notification_decryption_failed',
            notification_intent_envelope_invalid: 'plugin_notification_envelope_invalid',
            notification_intent_payload_invalid: 'plugin_notification_payload_invalid',
          };
          const normalized = notificationErrorCodes[error.message];
          if (normalized) throw new Error(normalized);
        }
        if (
          error instanceof Error &&
          [
            'notification_intent_unavailable',
            'notification_intent_terminal',
            'notification_intent_expired',
            'notification_intent_row_invalid',
            'notification_intent_delivery_input_invalid',
          ].includes(error.message)
        ) {
          throw new Error('plugin_hook_rejected');
        }
        throw new Error('plugin_hook_transient_failure');
      }
    } else {
      if (!('accountId' in invocation.payload)) throw new Error('plugin_hook_rejected');
      execution = { ...invocation, payload: invocation.payload };
    }
    const invoke = async (): Promise<{ providerMessageId?: string } | void> => {
      if (target.backendKind === 'dynamic_worker') {
        return this.dynamicBackend.invoke(execution);
      }
      const handler = this.inProcessRegistry.resolve(target.pluginId, invocation.capability);
      if (!handler) throw new Error('plugin_hook_provider_rejected');
      const signal = AbortSignal.timeout(target.timeoutMs);
      const timeout = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('plugin_hook_transient_failure')), {
          once: true,
        });
      });
      const outboundContext: PluginEgressContext = {
        contractVersion: 1,
        tenantId: invocation.tenantId,
        pluginInstallationId: invocation.pluginInstallationId,
        capability: invocation.capability,
        requestId: invocation.idempotencyKey,
        ...(this.executionScope
          ? {
              executionScope: {
                ...this.executionScope,
                ...('accountId' in invocation.payload
                  ? { accountId: invocation.payload.accountId }
                  : {}),
              },
            }
          : {}),
      };
      try {
        return await Promise.race([
          handler(execution, {
            signal,
            fetchExternal: (request) =>
              new PluginOutboundGateway({
                ...this.env,
                AUTHRIM_PLUGIN_EGRESS_CONTEXT: outboundContext,
              }).fetch(request),
            writeAccountMetadata: (input) =>
              new PluginAccountMetadataService(this.env).write(outboundContext, input),
          }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'plugin_in_process_message_rejected') {
            throw new Error('plugin_hook_rejected');
          }
          if (error.message === 'plugin_in_process_provider_rejected') {
            throw new Error('plugin_hook_provider_rejected');
          }
          if (error.message === 'plugin_in_process_transient_failure') {
            throw new Error('plugin_hook_transient_failure');
          }
        }
        throw new Error('plugin_hook_transient_failure');
      }
    };
    const executionResult = await invoke();
    if (notificationReference && this.notificationIntents) {
      try {
        await this.notificationIntents.complete({
          tenantId: invocation.tenantId,
          intentId: invocation.payload.intentId,
          pluginInstallationId: invocation.pluginInstallationId,
          providerMessageId: executionResult?.providerMessageId,
          now,
        });
      } catch {
        throw new Error('plugin_hook_transient_failure');
      }
    }
  }
}
