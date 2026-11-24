import { describe, expect, it, vi } from 'vitest';
import {
  PluginHookOutboxDispatcher,
  type ClaimedPluginHook,
  type PluginHookOutboxStore,
} from '../outbox';
import { rejectOpaque } from './helpers/mock-kit';

const CLAIM: ClaimedPluginHook = {
  outboxId: 'outbox-a',
  attemptNo: 2,
  claimOwner: 'runner-a',
  claimToken: 'claim-a',
  leaseUntil: 130,
  createdAt: 10,
  providerStartedAt: 100,
  invocation: {
    pluginInstallationId: 'plugin-a',
    tenantId: 'tenant-a',
    capability: 'notifier.send',
    eventType: 'notification.delivery.requested',
    eventVersion: 1,
    idempotencyKey: 'key-a',
    payload: {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      eventType: 'notification.delivery.requested',
      eventVersion: 1,
    },
  },
};
const POLICY = {
  pluginId: 'plugin-a',
  maxAttempts: 5,
  retryBudgetSeconds: 1_000,
  concurrencyCap: 2,
  ratePerMinute: 30,
};
const LEASE = {
  leaseId: 'lease-a',
  installationId: 'plugin-a',
  tenantId: 'tenant-a',
  capability: 'notifier.send',
  destinationHost: '',
};

function harness(
  over: {
    claim?: ClaimedPluginHook | null;
    policy?: () => Promise<typeof POLICY>;
    acquire?: () => Promise<typeof LEASE | null>;
    invoke?: () => Promise<void>;
    reference?: Awaited<ReturnType<PluginHookOutboxStore['claimReference']>>;
  } = {}
) {
  const store = {
    claimNext: vi.fn(async () => (over.claim === undefined ? CLAIM : over.claim)),
    claimReference: vi.fn(
      async () => over.reference ?? { state: 'claimed' as const, claim: CLAIM }
    ),
    succeed: vi.fn(async () => undefined),
    fail: vi.fn(async () => 'waiting_retry' as const),
  } satisfies PluginHookOutboxStore;
  const limiter = {
    acquire: vi.fn(over.acquire ?? (async () => LEASE)),
    release: vi.fn(async () => undefined),
  };
  const backend = { invoke: vi.fn(over.invoke ?? (async () => undefined)) };
  const policies = { resolveDispatchPolicy: vi.fn(over.policy ?? (async () => POLICY)) };
  return {
    store,
    limiter,
    backend,
    policies,
    dispatcher: new PluginHookOutboxDispatcher(store, backend, policies, limiter),
  };
}
const NOW = 150;
const run = (h: ReturnType<typeof harness>) =>
  h.dispatcher.processOne({ ownerId: 'runner-a', now: NOW });

describe('processOne', () => {
  it('is idle without a claim and touches nothing', async () => {
    const h = harness({ claim: null });
    await expect(run(h)).resolves.toBe('idle');
    expect(h.store.claimNext).toHaveBeenCalledWith({ ownerId: 'runner-a', now: NOW });
    expect(h.policies.resolveDispatchPolicy).not.toHaveBeenCalled();
    expect(h.limiter.acquire).not.toHaveBeenCalled();
  });
  it('resolves the policy for the claim and passes its limits to the limiter', async () => {
    const h = harness();
    await expect(run(h)).resolves.toBe('succeeded');
    expect(h.policies.resolveDispatchPolicy).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginInstallationId: 'plugin-a',
      capability: 'notifier.send',
    });
    expect(h.limiter.acquire).toHaveBeenCalledWith({
      installationId: 'plugin-a',
      tenantId: 'tenant-a',
      capability: 'notifier.send',
      concurrencyCap: 2,
      ratePerMinute: 30,
      now: NOW,
    });
    expect(h.backend.invoke).toHaveBeenCalledWith(CLAIM.invocation);
    expect(h.store.succeed).toHaveBeenCalledWith(CLAIM, NOW);
    expect(h.store.fail).not.toHaveBeenCalled();
    expect(h.limiter.release).toHaveBeenCalledWith(LEASE);
  });
});

describe('policy failures', () => {
  it('retries a gate that is not initialised as a platform failure', async () => {
    const h = harness({ policy: () => Promise.reject(new Error('plugin_gate_uninitialized')) });
    await expect(run(h)).resolves.toBe('waiting_retry');
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_gate_uninitialized',
      retryable: true,
      maxAttempts: 12,
      failureScope: 'platform',
    });
    expect(h.backend.invoke).not.toHaveBeenCalled();
    expect(h.limiter.acquire).not.toHaveBeenCalled();
  });
  it.each([
    'plugin_policy_unavailable',
    'plugin_policy_lookup_invalid',
    'plugin_policy_max_attempts_invalid',
    'plugin_policy_retry_budget_invalid',
    'plugin_policy_concurrency_invalid',
    'plugin_policy_rate_invalid',
  ])('treats %s as a permanent provider failure', async (message) => {
    const h = harness({ policy: () => Promise.reject(new Error(message)) });
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_policy_unavailable',
      retryable: false,
      maxAttempts: 1,
      failureScope: 'provider',
    });
  });
  it.each([
    ['an unknown error', () => Promise.reject(new Error('d1 exploded'))],
    ['a near-miss code', () => Promise.reject(new Error('plugin_policy_unavailable_x'))],
    ['a non-Error rejection', () => rejectOpaque('plugin_policy_unavailable')],
  ])('retries %s as a platform lookup failure', async (_label, policy) => {
    const h = harness({ policy: policy });
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_policy_lookup_failed',
      retryable: true,
      maxAttempts: 12,
      failureScope: 'platform',
    });
  });
  it('does not treat a non-Error rejection as an uninitialised gate', async () => {
    const h = harness({ policy: () => rejectOpaque('plugin_gate_uninitialized') });
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(
      CLAIM,
      expect.objectContaining({ errorCode: 'plugin_policy_lookup_failed' })
    );
  });
});

describe('retry budget', () => {
  it('dead-letters exactly when the budget is used up', async () => {
    const h = harness({
      policy: async () => ({ ...POLICY, retryBudgetSeconds: NOW - CLAIM.providerStartedAt }),
    });
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_retry_budget_exhausted',
      retryable: false,
      maxAttempts: POLICY.maxAttempts,
      failureScope: 'provider',
    });
    expect(h.limiter.acquire).not.toHaveBeenCalled();
    expect(h.backend.invoke).not.toHaveBeenCalled();
  });
  it('still dispatches one second before the budget ends', async () => {
    const h = harness({
      policy: async () => ({ ...POLICY, retryBudgetSeconds: NOW - CLAIM.providerStartedAt + 1 }),
    });
    await expect(run(h)).resolves.toBe('succeeded');
  });
  it('measures the budget from the provider start, not from creation', async () => {
    const h = harness({
      claim: { ...CLAIM, createdAt: 1, providerStartedAt: 140 },
      policy: async () => ({ ...POLICY, retryBudgetSeconds: 20 }),
    });
    await expect(run(h)).resolves.toBe('succeeded');
  });
});

describe('platform limiter', () => {
  it('retries when the limiter is unavailable', async () => {
    const h = harness({ acquire: () => Promise.reject(new Error('d1 down')) });
    await expect(run(h)).resolves.toBe('waiting_retry');
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_dispatch_limiter_unavailable',
      retryable: true,
      maxAttempts: POLICY.maxAttempts,
      failureScope: 'platform',
    });
    expect(h.limiter.release).not.toHaveBeenCalled();
  });
  it('retries when the platform limit is reached', async () => {
    const h = harness({ acquire: async () => null });
    await expect(run(h)).resolves.toBe('waiting_retry');
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: 'plugin_dispatch_limited',
      retryable: true,
      maxAttempts: POLICY.maxAttempts,
      failureScope: 'platform',
    });
    expect(h.backend.invoke).not.toHaveBeenCalled();
    expect(h.limiter.release).not.toHaveBeenCalled();
  });
});

describe('backend failures', () => {
  const failing = (error: unknown) =>
    harness({
      invoke: () => (error instanceof Error ? Promise.reject(error) : rejectOpaque(error)),
    });
  it.each([
    [
      'a transient failure',
      new Error('plugin_hook_transient_failure'),
      { errorCode: 'plugin_hook_transient_failure', retryable: true, failureScope: 'provider' },
    ],
    [
      'a provider rejection',
      new Error('plugin_hook_provider_rejected'),
      { errorCode: 'plugin_hook_provider_rejected', retryable: false, failureScope: 'provider' },
    ],
    [
      'an unknown error',
      new Error('something else'),
      { errorCode: 'plugin_hook_rejected', retryable: false, failureScope: 'message' },
    ],
    [
      'a near-miss transient code',
      new Error('plugin_hook_transient_failure_x'),
      { errorCode: 'plugin_hook_rejected', retryable: false, failureScope: 'message' },
    ],
    [
      'a non-Error rejection',
      'plugin_hook_transient_failure',
      { errorCode: 'plugin_hook_rejected', retryable: false, failureScope: 'message' },
    ],
  ])('normalises %s', async (_label, error, expected) => {
    const h = failing(error);
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      maxAttempts: POLICY.maxAttempts,
      ...expected,
    });
    expect(h.store.succeed).not.toHaveBeenCalled();
    expect(h.limiter.release).toHaveBeenCalledWith(LEASE);
  });
  it.each([
    'plugin_notification_key_unavailable',
    'plugin_notification_key_unwrap_failed',
    'plugin_notification_payload_authentication_failed',
    'plugin_notification_decryption_failed',
    'plugin_notification_envelope_invalid',
    'plugin_notification_payload_invalid',
  ])('keeps the notification error code %s as a message failure', async (message) => {
    const h = failing(new Error(message));
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(CLAIM, {
      now: NOW,
      errorCode: message,
      retryable: false,
      maxAttempts: POLICY.maxAttempts,
      failureScope: 'message',
    });
  });
  it('maps an unlisted notification code to the generic rejection', async () => {
    const h = failing(new Error('plugin_notification_other'));
    await run(h);
    expect(h.store.fail).toHaveBeenCalledWith(
      CLAIM,
      expect.objectContaining({ errorCode: 'plugin_hook_rejected' })
    );
  });
});

describe('completion', () => {
  it('surfaces an uncertain completion without recording a failure and still releases', async () => {
    const h = harness();
    h.store.succeed.mockRejectedValueOnce(new Error('d1 lost'));
    await expect(run(h)).rejects.toThrow(/^plugin_outbox_completion_failed$/u);
    expect(h.store.fail).not.toHaveBeenCalled();
    expect(h.limiter.release).toHaveBeenCalledTimes(1);
  });
  it('ignores a failing limiter release', async () => {
    const h = harness();
    h.limiter.release.mockRejectedValueOnce(new Error('d1 lost'));
    await expect(run(h)).resolves.toBe('succeeded');
  });
  it('releases the lease after a backend failure even when release fails', async () => {
    const h = harness({ invoke: () => Promise.reject(new Error('plugin_hook_transient_failure')) });
    h.limiter.release.mockRejectedValueOnce(new Error('d1 lost'));
    await expect(run(h)).resolves.toBe('waiting_retry');
  });
});

describe('processReference', () => {
  const REF = {
    ownerId: 'runner-a',
    now: NOW,
    outboxId: 'outbox-a',
    tenantId: 'tenant-a',
    pluginInstallationId: 'plugin-a',
    intentId: 'intent-a',
  };
  it.each(['pending', 'delivered', 'permanent_failure'] as const)(
    'returns the settled state %s without dispatching',
    async (state) => {
      const h = harness({ reference: { state } });
      await expect(h.dispatcher.processReference(REF)).resolves.toBe(state);
      expect(h.store.claimReference).toHaveBeenCalledWith(REF);
      expect(h.policies.resolveDispatchPolicy).not.toHaveBeenCalled();
    }
  );
  it('maps success to delivered', async () => {
    const h = harness();
    await expect(h.dispatcher.processReference(REF)).resolves.toBe('delivered');
    expect(h.store.succeed).toHaveBeenCalledWith(CLAIM, NOW);
  });
  it('maps a scheduled retry to pending', async () => {
    const h = harness({ invoke: () => Promise.reject(new Error('plugin_hook_transient_failure')) });
    await expect(h.dispatcher.processReference(REF)).resolves.toBe('pending');
  });
  it('maps a dead letter to permanent_failure', async () => {
    const h = harness({ invoke: () => Promise.reject(new Error('boom')) });
    h.store.fail.mockResolvedValueOnce('dead_letter' as never);
    await expect(h.dispatcher.processReference(REF)).resolves.toBe('permanent_failure');
  });
});
