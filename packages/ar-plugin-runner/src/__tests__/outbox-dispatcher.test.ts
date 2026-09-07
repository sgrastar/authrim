import { describe, expect, it, vi } from 'vitest';
import {
  PluginHookOutboxDispatcher,
  type ClaimedPluginHook,
  type PluginHookOutboxStore,
} from '../outbox';

function claim(attemptNo = 1): ClaimedPluginHook {
  return {
    outboxId: 'outbox-a',
    attemptNo,
    claimOwner: 'runner-a',
    claimToken: 'claim-a',
    leaseUntil: 130,
    createdAt: 1,
    providerStartedAt: 1,
    invocation: {
      pluginInstallationId: 'plugin-a',
      tenantId: 'tenant-a',
      capability: 'notifier.send',
      eventType: 'account.created',
      eventVersion: 1,
      idempotencyKey: 'event-a',
      payload: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        eventType: 'account.created',
        eventVersion: 1,
      },
    },
  };
}

function policy(
  overrides: Partial<{
    maxAttempts: number;
    retryBudgetSeconds: number;
    concurrencyCap: number;
    ratePerMinute: number;
  }> = {}
) {
  return {
    resolveDispatchPolicy: async () => ({
      pluginId: 'plugin-a',
      maxAttempts: 5,
      retryBudgetSeconds: 1_000,
      concurrencyCap: 2,
      ratePerMinute: 30,
      ...overrides,
    }),
  };
}

function limiter(allowed = true) {
  return {
    acquire: vi.fn(async () =>
      allowed
        ? {
            leaseId: 'dispatch-a',
            installationId: 'plugin-a',
            tenantId: 'tenant-a',
            capability: 'notifier.send',
            destinationHost: '',
          }
        : null
    ),
    release: vi.fn(async () => undefined),
  };
}

function store(value: ClaimedPluginHook | null) {
  const claimReference: PluginHookOutboxStore['claimReference'] = async () =>
    value ? { state: 'claimed', claim: value } : { state: 'pending' };
  return {
    claimNext: vi.fn(async () => value),
    claimReference: vi.fn(claimReference),
    succeed: vi.fn(async () => undefined),
    fail: vi.fn(
      async (
        _claim: ClaimedPluginHook,
        input: { now: number; errorCode: string; retryable: boolean; maxAttempts: number }
      ) => (input.retryable ? ('waiting_retry' as const) : ('dead_letter' as const))
    ),
  } satisfies PluginHookOutboxStore;
}

describe('PluginHookOutboxDispatcher', () => {
  it('completes an invoked hook with the exact claim', async () => {
    const outbox = store(claim());
    const invoke = vi.fn(async () => undefined);
    const dispatcher = new PluginHookOutboxDispatcher(outbox, { invoke }, policy(), limiter());

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'succeeded'
    );
    expect(invoke).toHaveBeenCalledWith(claim().invocation);
    expect(outbox.succeed).toHaveBeenCalledWith(claim(), 100);
  });

  it('preserves a persisted success when bounded limiter cleanup fails', async () => {
    const outbox = store(claim());
    const dispatchLimiter = limiter();
    dispatchLimiter.release.mockRejectedValueOnce(new Error('d1_unavailable'));
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: vi.fn(async () => undefined) },
      policy(),
      dispatchLimiter
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'succeeded'
    );
    expect(outbox.succeed).toHaveBeenCalledWith(claim(), 100);
  });

  it('does not dead-letter after provider success when outbox completion is uncertain', async () => {
    const outbox = store(claim());
    outbox.succeed.mockRejectedValueOnce(new Error('d1_response_lost'));
    const dispatchLimiter = limiter();
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: vi.fn(async () => undefined) },
      policy(),
      dispatchLimiter
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).rejects.toThrow(
      'plugin_outbox_completion_failed'
    );
    expect(outbox.fail).not.toHaveBeenCalled();
    expect(dispatchLimiter.release).toHaveBeenCalledOnce();
  });

  it('retries only normalized transient failures', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: async () => Promise.reject(new Error('plugin_hook_transient_failure')) },
      policy(),
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'waiting_retry'
    );
    expect(outbox.fail).toHaveBeenCalledWith(
      claim(),
      expect.objectContaining({ retryable: true, maxAttempts: 5 })
    );
  });

  it('dead-letters permanent plugin rejection without persisting provider text', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: async () => Promise.reject(new Error('secret provider detail')) },
      policy(),
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'dead_letter'
    );
    expect(outbox.fail).toHaveBeenCalledWith(claim(), {
      now: 100,
      errorCode: 'plugin_hook_rejected',
      retryable: false,
      maxAttempts: 5,
      failureScope: 'message',
    });
  });

  it.each([
    'plugin_notification_key_unavailable',
    'plugin_notification_key_unwrap_failed',
    'plugin_notification_payload_authentication_failed',
    'plugin_notification_decryption_failed',
    'plugin_notification_envelope_invalid',
    'plugin_notification_payload_invalid',
  ])('persists the safe notification diagnostic %s', async (errorCode) => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: async () => Promise.reject(new Error(errorCode)) },
      policy(),
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'dead_letter'
    );
    expect(outbox.fail).toHaveBeenCalledWith(claim(), {
      now: 100,
      errorCode,
      retryable: false,
      maxAttempts: 5,
      failureScope: 'message',
    });
  });

  it('marks an explicit provider rejection as failover eligible', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: async () => Promise.reject(new Error('plugin_hook_provider_rejected')) },
      policy(),
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'dead_letter'
    );
    expect(outbox.fail).toHaveBeenCalledWith(claim(), {
      now: 100,
      errorCode: 'plugin_hook_provider_rejected',
      retryable: false,
      maxAttempts: 5,
      failureScope: 'provider',
    });
  });

  it('retries an unclassified policy storage failure', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: vi.fn() },
      { resolveDispatchPolicy: async () => Promise.reject(new Error('d1_unavailable')) },
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'waiting_retry'
    );
    expect(outbox.fail).toHaveBeenCalledWith(claim(), {
      now: 100,
      errorCode: 'plugin_policy_lookup_failed',
      retryable: true,
      maxAttempts: 12,
      failureScope: 'platform',
    });
  });

  it('dead-letters a known unavailable policy without retrying', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: vi.fn() },
      {
        resolveDispatchPolicy: async () => Promise.reject(new Error('plugin_policy_unavailable')),
      },
      limiter()
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'dead_letter'
    );
    expect(outbox.fail).toHaveBeenCalledWith(claim(), {
      now: 100,
      errorCode: 'plugin_policy_unavailable',
      retryable: false,
      maxAttempts: 1,
      failureScope: 'provider',
    });
  });

  it('does not invoke a backend when no due row exists', async () => {
    const outbox = store(null);
    const invoke = vi.fn(async () => undefined);
    const dispatcher = new PluginHookOutboxDispatcher(outbox, { invoke }, policy(), limiter());

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe('idle');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('dead-letters before dispatch after the capability retry budget expires', async () => {
    const outbox = store(claim());
    const invoke = vi.fn(async () => undefined);
    const dispatchLimiter = limiter();
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke },
      policy({ retryBudgetSeconds: 99 }),
      dispatchLimiter
    );

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'dead_letter'
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatchLimiter.acquire).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(
      claim(),
      expect.objectContaining({ errorCode: 'plugin_retry_budget_exhausted', retryable: false })
    );
  });

  it('retries without dispatch when the platform limiter denies the attempt', async () => {
    const outbox = store(claim());
    const invoke = vi.fn(async () => undefined);
    const dispatcher = new PluginHookOutboxDispatcher(outbox, { invoke }, policy(), limiter(false));

    await expect(dispatcher.processOne({ ownerId: 'runner-a', now: 100 })).resolves.toBe(
      'waiting_retry'
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(
      claim(),
      expect.objectContaining({ errorCode: 'plugin_dispatch_limited', retryable: true })
    );
  });

  it('maps immediate notification dispatch to the fixed three-state contract', async () => {
    const outbox = store(claim());
    const dispatcher = new PluginHookOutboxDispatcher(
      outbox,
      { invoke: async () => undefined },
      policy(),
      limiter()
    );
    await expect(
      dispatcher.processReference({
        ownerId: 'immediate-a',
        now: 100,
        outboxId: 'outbox-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'plugin-a',
        intentId: 'intent-a',
      })
    ).resolves.toBe('delivered');

    outbox.claimReference.mockResolvedValue({ state: 'permanent_failure' });
    await expect(
      dispatcher.processReference({
        ownerId: 'immediate-b',
        now: 101,
        outboxId: 'outbox-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'plugin-a',
        intentId: 'intent-a',
      })
    ).resolves.toBe('permanent_failure');
  });
});
