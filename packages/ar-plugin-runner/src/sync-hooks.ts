import type { Fetcher, WorkerLoader } from '@cloudflare/workers-types';
import { readBoundedResponseBody } from './bounded-response';
import type { PluginWorkerCodeResolver } from './dynamic-worker-code';
import type { PluginInstallationResolver } from './dynamic-worker-backend';
import type { PluginHostInterfaceEnvFactory } from './dynamic-worker-backend';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SAFE_SCRIPT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_REASON = /^[a-z][a-z0-9_:-]{0,127}$/u;

export interface HumanVerificationHookInput {
  tenantId: string;
  pluginInstallationId: string;
  requestId: string;
  action: 'login' | 'signup' | 'reauth';
  responseToken: string;
  remoteIp?: string;
}

export interface PolicyDecisionHookInput {
  tenantId: string;
  pluginInstallationId: string;
  requestId: string;
  subjectId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  attributes: Record<string, string | number | boolean>;
}

export interface FlowHookInput {
  tenantId: string;
  pluginInstallationId: string;
  requestId: string;
  flowId: string;
  hookName: string;
  accountId?: string;
  stateVersion: number;
}

export interface DecisionHookResult {
  decision: 'allow' | 'deny';
  reasonCode: string;
}

export interface FlowHookResult {
  decision: 'continue' | 'deny';
  reasonCode: string;
}

export type SyncHookGroup = 'human-verification' | 'policy-decision' | 'flow-hook';

export type SyncHookTarget =
  | { backendKind: 'dynamic_worker'; scriptName: string; timeoutMs: number }
  | { backendKind: 'in_process'; pluginId: string; timeoutMs: number };

export interface SyncHookBackend {
  invoke<T extends DecisionHookResult | FlowHookResult>(input: {
    group: SyncHookGroup;
    target: SyncHookTarget;
    payload: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput;
  }): Promise<T>;
}

export function capabilityFor(
  group: SyncHookGroup,
  payload: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput
): string {
  if (group === 'human-verification') return 'human_verification.verify';
  if (group === 'policy-decision') return 'policy.decision';
  return `flow.${(payload as FlowHookInput).hookName}`;
}

export function validateSyncHookResult<T extends DecisionHookResult | FlowHookResult>(
  value: unknown,
  group: SyncHookGroup
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin_sync_response_invalid');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).sort().join(',') !== 'decision,reasonCode' ||
    typeof result.reasonCode !== 'string' ||
    !SAFE_REASON.test(result.reasonCode)
  ) {
    throw new Error('plugin_sync_response_invalid');
  }
  const decisions = group === 'flow-hook' ? ['continue', 'deny'] : ['allow', 'deny'];
  if (typeof result.decision !== 'string' || !decisions.includes(result.decision)) {
    throw new Error('plugin_sync_response_invalid');
  }
  return result as unknown as T;
}

function parseResult<T extends DecisionHookResult | FlowHookResult>(
  bytes: ArrayBuffer,
  group: SyncHookGroup
): T {
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('plugin_sync_response_too_large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('plugin_sync_response_invalid');
  }
  return validateSyncHookResult<T>(parsed, group);
}

export class DynamicWorkerSyncHookBackend implements SyncHookBackend {
  constructor(
    private readonly loader: WorkerLoader | undefined,
    private readonly installations: PluginInstallationResolver,
    private readonly code: PluginWorkerCodeResolver,
    private readonly outbound: (context: {
      contractVersion: 1;
      tenantId: string;
      pluginInstallationId: string;
      capability: string;
      requestId: string;
    }) => Fetcher,
    private readonly hostInterfaces?: PluginHostInterfaceEnvFactory
  ) {}

  async invoke<T extends DecisionHookResult | FlowHookResult>(input: {
    group: SyncHookGroup;
    target: SyncHookTarget;
    payload: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput;
  }): Promise<T> {
    if (!this.loader) {
      throw new Error('plugin_sync_rejected');
    }
    if (
      input.target.backendKind !== 'dynamic_worker' ||
      !SAFE_SCRIPT.test(input.target.scriptName) ||
      !Number.isSafeInteger(input.target.timeoutMs) ||
      input.target.timeoutMs < 1 ||
      input.target.timeoutMs > 30_000
    ) {
      throw new Error('plugin_sync_target_invalid');
    }
    const body = JSON.stringify(input.payload);
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new Error('plugin_sync_request_too_large');
    }
    let response: Response;
    try {
      const capability = capabilityFor(input.group, input.payload);
      const target = await this.installations.resolve({
        tenantId: input.payload.tenantId,
        pluginInstallationId: input.payload.pluginInstallationId,
        capability,
      });
      if (!target || target.scriptName !== input.target.scriptName) {
        throw new Error('plugin_sync_target_invalid');
      }
      const scopeKey = JSON.stringify([
        input.payload.tenantId,
        input.payload.pluginInstallationId,
        capability,
        target.codeSha256,
      ]);
      const workerId = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scopeKey))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
      const context = {
        contractVersion: 1 as const,
        tenantId: input.payload.tenantId,
        pluginInstallationId: input.payload.pluginInstallationId,
        capability,
        requestId: `scope:${workerId}`,
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
        .fetch(`https://authrim.invalid/internal/plugin-sync/${input.group}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Authrim-Plugin-Contract': `${input.group}-v1`,
          },
          body,
          signal: AbortSignal.timeout(input.target.timeoutMs),
          redirect: 'manual',
        });
    } catch {
      throw new Error('plugin_sync_transient_failure');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(
        response.status === 429 || response.status >= 500
          ? 'plugin_sync_transient_failure'
          : 'plugin_sync_rejected'
      );
    }
    let responseBody: ArrayBuffer;
    try {
      responseBody = await readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        'plugin_sync_response_too_large'
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'plugin_sync_response_too_large') {
        throw error;
      }
      throw new Error('plugin_sync_transient_failure');
    }
    return parseResult<T>(responseBody, input.group);
  }
}
