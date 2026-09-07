import type { Fetcher, WorkerLoader } from '@cloudflare/workers-types';
import type { PluginWorkerCodeResolver } from './dynamic-worker-code';
import type {
  PluginExecutionBackend,
  PluginHookExecutionInvocation,
  PluginShardExecutionScope,
} from './types';
import type { PluginHostInterfaceBindingContract } from '@authrim/ar-lib-core/services/plugin-host-interface-contract';
import type { PluginResourceBindingDescriptor } from './resource-bindings';

const SAFE_SCRIPT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface PluginInstallationTarget {
  scriptName: string;
  pluginId: string;
  codeObjectKey: string;
  codeSha256: string;
  timeoutMs: number;
  hostInterfaces: readonly PluginHostInterfaceBindingContract[];
  resources: readonly PluginResourceBindingDescriptor[];
}

export interface PluginInstallationResolver {
  resolve(input: {
    tenantId: string;
    pluginInstallationId: string;
    capability: string;
  }): Promise<PluginInstallationTarget | null>;
}

export type PluginOutboundFactory = (context: {
  contractVersion: 1;
  tenantId: string;
  pluginInstallationId: string;
  capability: string;
  requestId: string;
  executionScope?: PluginShardExecutionScope & { accountId?: string };
}) => Fetcher;

export type PluginHostInterfaceEnvFactory = (
  context: Parameters<PluginOutboundFactory>[0],
  bindings: readonly PluginHostInterfaceBindingContract[],
  resources: readonly PluginResourceBindingDescriptor[],
  pluginId: string
) => Record<string, unknown>;

export class DynamicWorkerPluginBackend implements PluginExecutionBackend {
  constructor(
    private readonly loader: WorkerLoader | undefined,
    private readonly installations: PluginInstallationResolver,
    private readonly code: PluginWorkerCodeResolver,
    private readonly outbound: PluginOutboundFactory,
    private readonly executionScope?: PluginShardExecutionScope,
    private readonly hostInterfaces?: PluginHostInterfaceEnvFactory
  ) {}

  async invoke(input: PluginHookExecutionInvocation): Promise<void> {
    if (!this.loader) {
      throw new Error('plugin_hook_provider_rejected');
    }
    let target;
    try {
      target = await this.installations.resolve(input);
    } catch (error) {
      if (error instanceof Error && error.message === 'plugin_installation_lookup_invalid') {
        throw new Error('plugin_hook_rejected');
      }
      if (
        error instanceof Error &&
        ['plugin_installation_script_invalid', 'plugin_installation_timeout_invalid'].includes(
          error.message
        )
      ) {
        throw new Error('plugin_hook_provider_rejected');
      }
      throw new Error('plugin_hook_transient_failure');
    }
    if (
      !target ||
      !SAFE_SCRIPT.test(target.scriptName) ||
      !Number.isSafeInteger(target.timeoutMs) ||
      target.timeoutMs < 1 ||
      target.timeoutMs > 30_000
    ) {
      throw new Error('plugin_hook_provider_rejected');
    }
    let response: Response;
    try {
      const executionScope = this.executionScope
        ? {
            ...this.executionScope,
            ...('accountId' in input.payload ? { accountId: input.payload.accountId } : {}),
          }
        : undefined;
      const scopeKey = JSON.stringify([
        input.tenantId,
        input.pluginInstallationId,
        input.capability,
        executionScope?.bindingRef ?? null,
        executionScope?.accountId ?? null,
        target.codeSha256,
      ]);
      const workerId = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scopeKey))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
      const context = {
        contractVersion: 1 as const,
        tenantId: input.tenantId,
        pluginInstallationId: input.pluginInstallationId,
        capability: input.capability,
        requestId: `scope:${workerId}`,
        ...(executionScope ? { executionScope } : {}),
      };
      const workerCode = await this.code.resolve(target);
      if (workerCode.env !== undefined) throw new Error('plugin_worker_env_forbidden');
      if (
        (target.hostInterfaces.length > 0 || target.resources.length > 0) &&
        !this.hostInterfaces
      ) {
        throw new Error('plugin_host_interface_unavailable');
      }
      response = await this.loader
        .get(workerId, async () => ({
          ...workerCode,
          env:
            this.hostInterfaces?.(
              context,
              target.hostInterfaces,
              target.resources,
              target.pluginId
            ) ?? {},
          globalOutbound: this.outbound(context),
        }))
        .getEntrypoint()
        .fetch('https://authrim.invalid/internal/plugin-hook', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Authrim-Plugin-Contract':
              'delivery' in input.payload ? 'notification-delivery-v1' : 'hook-reference-v1',
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(target.timeoutMs),
          redirect: 'manual',
        });
    } catch {
      throw new Error('plugin_hook_transient_failure');
    }
    const contentLength = Number(response.headers.get('Content-Length'));
    if (
      response.status !== 204 ||
      (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES)
    ) {
      await response.body?.cancel();
      throw new Error(
        response.status >= 500 || response.status === 429
          ? 'plugin_hook_transient_failure'
          : [401, 403, 404].includes(response.status)
            ? 'plugin_hook_provider_rejected'
            : 'plugin_hook_rejected'
      );
    }
    await response.body?.cancel();
  }
}
