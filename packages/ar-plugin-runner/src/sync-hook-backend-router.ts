import {
  capabilityFor,
  type DecisionHookResult,
  type FlowHookResult,
  type HumanVerificationHookInput,
  type PolicyDecisionHookInput,
  type FlowHookInput,
  type SyncHookBackend,
  type SyncHookGroup,
  type SyncHookTarget,
  validateSyncHookResult,
} from './sync-hooks';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export type InProcessSyncHookHandler = (
  payload: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput,
  signal: AbortSignal
) => Promise<unknown>;

export interface InProcessSyncHookRegistry {
  resolve(pluginId: string, capability: string): InProcessSyncHookHandler | null;
}

export class StaticInProcessSyncHookRegistry implements InProcessSyncHookRegistry {
  constructor(
    private readonly handlers: ReadonlyMap<string, InProcessSyncHookHandler> = new Map()
  ) {}

  resolve(pluginId: string, capability: string): InProcessSyncHookHandler | null {
    return this.handlers.get(`${pluginId}:${capability}`) ?? null;
  }
}

export class SyncHookBackendRouter implements SyncHookBackend {
  constructor(
    private readonly dynamicBackend: SyncHookBackend,
    private readonly inProcessRegistry: InProcessSyncHookRegistry
  ) {}

  async invoke<T extends DecisionHookResult | FlowHookResult>(input: {
    group: SyncHookGroup;
    target: SyncHookTarget;
    payload: HumanVerificationHookInput | PolicyDecisionHookInput | FlowHookInput;
  }): Promise<T> {
    if (input.target.backendKind === 'dynamic_worker') {
      return this.dynamicBackend.invoke<T>(input);
    }
    if (
      !SAFE_ID.test(input.target.pluginId) ||
      !Number.isSafeInteger(input.target.timeoutMs) ||
      input.target.timeoutMs < 1 ||
      input.target.timeoutMs > 30_000
    ) {
      throw new Error('plugin_sync_target_invalid');
    }
    const handler = this.inProcessRegistry.resolve(
      input.target.pluginId,
      capabilityFor(input.group, input.payload)
    );
    if (!handler) throw new Error('plugin_sync_rejected');

    const signal = AbortSignal.timeout(input.target.timeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('plugin_sync_transient_failure')), {
        once: true,
      });
    });
    let result: unknown;
    try {
      result = await Promise.race([handler(input.payload, signal), timeout]);
    } catch (error) {
      if (error instanceof Error && error.message === 'plugin_sync_rejected') throw error;
      throw new Error('plugin_sync_transient_failure');
    }
    return validateSyncHookResult<T>(result, input.group);
  }
}
