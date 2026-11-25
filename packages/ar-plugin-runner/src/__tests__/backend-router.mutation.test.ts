import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginHookBackendRouter,
  StaticInProcessPluginRegistry,
  type InProcessPluginHookHandler,
} from '../backend-router';
import type { PluginHookInvocation, PluginRunnerEnv } from '../types';
import { callsTo, must, outcomes, rejectOpaque, resetKit } from './helpers/mock-kit';

vi.mock('../outbound-gateway', async () => ({
  PluginOutboundGateway: (await import('./helpers/mock-kit')).mockClass('PluginOutboundGateway', [
    'fetch',
  ]),
}));
vi.mock('../account-metadata', async () => ({
  PluginAccountMetadataService: (await import('./helpers/mock-kit')).mockClass(
    'PluginAccountMetadataService',
    ['write']
  ),
}));

const ENV = { MARKER: 'env' } as unknown as PluginRunnerEnv;
const ACCOUNT: PluginHookInvocation = {
  pluginInstallationId: 'installation-a',
  tenantId: 'tenant-a',
  capability: 'hook.account.lifecycle',
  eventType: 'account.created',
  eventVersion: 1,
  idempotencyKey: 'event-a',
  payload: {
    tenantId: 'tenant-a',
    accountId: 'account-a',
    eventType: 'account.created',
    eventVersion: 1,
  },
};
const NOTIFICATION: PluginHookInvocation = {
  pluginInstallationId: 'installation-a',
  tenantId: 'tenant-a',
  capability: 'notifier.send',
  eventType: 'notification.delivery.requested',
  eventVersion: 1,
  idempotencyKey: 'challenge-a/email',
  payload: {
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    eventType: 'notification.delivery.requested',
    eventVersion: 1,
  },
};
const DELIVERY = { channel: 'email', to: 'person@example.test', body: 'code' };
const LOADED = {
  state: 'pending' as const,
  intentId: 'intent-a',
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  notificationKind: 'auth.email_otp',
  idempotencyKey: 'challenge-a/email',
  payload: DELIVERY,
  expiresAt: 900,
};
const DYNAMIC = { pluginId: 'plugin-a', backendKind: 'dynamic_worker' as const, timeoutMs: 1_000 };
const IN_PROCESS = { pluginId: 'builtin-a', backendKind: 'in_process' as const, timeoutMs: 1_000 };
const SCOPE = {
  bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
  dataRole: 'tenant_core/users' as const,
  residencyPartition: 'jp',
};

function build(
  over: {
    target?: unknown;
    resolve?: () => Promise<unknown>;
    handler?: InProcessPluginHookHandler | null;
    intents?: boolean;
    load?: () => Promise<unknown>;
    complete?: () => Promise<void>;
    now?: () => number;
    scope?: typeof SCOPE;
    dynamic?: () => Promise<void>;
  } = {}
) {
  const dynamicInvoke = vi.fn(over.dynamic ?? (async () => undefined));
  const intents = {
    load: vi.fn(over.load ?? (async () => LOADED)),
    complete: vi.fn(over.complete ?? (async () => undefined)),
  };
  const registry = new StaticInProcessPluginRegistry(
    over.handler === null || over.handler === undefined
      ? new Map()
      : new Map([
          ['builtin-a:notifier.send', over.handler],
          ['builtin-a:hook.account.lifecycle', over.handler],
        ])
  );
  const router = new PluginHookBackendRouter(
    ENV,
    {
      resolveBackend: vi.fn(
        over.resolve ?? (async () => (over.target === undefined ? DYNAMIC : over.target))
      ),
    } as never,
    { invoke: dynamicInvoke },
    registry,
    over.scope,
    over.intents === false ? undefined : (intents as never),
    over.now ?? (() => 500)
  );
  return { router, dynamicInvoke, intents };
}

beforeEach(() => {
  resetKit();
});

describe('backend resolution', () => {
  it('resolves the installation named by the invocation', async () => {
    const resolveBackend = vi.fn(async () => DYNAMIC);
    const router = new PluginHookBackendRouter(
      ENV,
      { resolveBackend } as never,
      { invoke: async () => undefined },
      new StaticInProcessPluginRegistry()
    );
    await router.invoke(ACCOUNT);
    expect(resolveBackend).toHaveBeenCalledWith(ACCOUNT);
  });
  it.each([
    ['plugin_installation_lookup_invalid', 'plugin_hook_rejected'],
    ['plugin_installation_timeout_invalid', 'plugin_hook_provider_rejected'],
    ['plugin_installation_lookup_failed', 'plugin_hook_transient_failure'],
    ['d1 down', 'plugin_hook_transient_failure'],
  ])('maps the lookup failure %s to %s', async (message, code) => {
    const { router, dynamicInvoke } = build({ resolve: () => Promise.reject(new Error(message)) });
    await expect(router.invoke(ACCOUNT)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    expect(dynamicInvoke).not.toHaveBeenCalled();
  });
  it('treats a non-Error lookup failure as transient', async () => {
    const { router } = build({ resolve: () => rejectOpaque('plugin_installation_lookup_invalid') });
    await expect(router.invoke(ACCOUNT)).rejects.toThrow(/^plugin_hook_transient_failure$/u);
  });
  it('rejects an invocation whose installation is not resolvable', async () => {
    const { router } = build({ target: null });
    await expect(router.invoke(ACCOUNT)).rejects.toThrow(/^plugin_hook_provider_rejected$/u);
  });
  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    'refuses a clock value of %s as transient',
    async (now) => {
      const { router, dynamicInvoke } = build({ now: () => now });
      await expect(router.invoke(ACCOUNT)).rejects.toThrow(/^plugin_hook_transient_failure$/u);
      expect(dynamicInvoke).not.toHaveBeenCalled();
    }
  );
  it('accepts a clock value of one', async () => {
    const { router } = build({ now: () => 1 });
    await expect(router.invoke(ACCOUNT)).resolves.toBeUndefined();
  });
  it('defaults the clock to seconds since the epoch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_444_900);
    try {
      const router = new PluginHookBackendRouter(
        ENV,
        { resolveBackend: async () => DYNAMIC } as never,
        { invoke: async () => undefined },
        new StaticInProcessPluginRegistry(),
        undefined,
        { load: vi.fn(async () => LOADED), complete: vi.fn(async () => undefined) } as never
      );
      const complete = vi.fn(async () => undefined);
      (
        router as unknown as { notificationIntents: { complete: unknown } }
      ).notificationIntents.complete = complete;
      await router.invoke(NOTIFICATION);
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ now: 1_700_000_444 }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('account events', () => {
  it('hands the dynamic backend the invocation unchanged and never touches notification state', async () => {
    const { router, dynamicInvoke, intents } = build();
    await router.invoke(ACCOUNT);
    expect(dynamicInvoke).toHaveBeenCalledWith(ACCOUNT);
    expect(intents.load).not.toHaveBeenCalled();
    expect(intents.complete).not.toHaveBeenCalled();
  });
  it('rejects a payload that names no account', async () => {
    const { router, dynamicInvoke } = build();
    await expect(router.invoke({ ...ACCOUNT, payload: NOTIFICATION.payload })).rejects.toThrow(
      /^plugin_hook_rejected$/u
    );
    expect(dynamicInvoke).not.toHaveBeenCalled();
  });
  it.each([
    ['another capability', { capability: 'hook.other' }],
    ['another event type', { eventType: 'account.created' }],
  ])(
    'does not treat an intent payload with %s as a notification reference',
    async (_label, over) => {
      const { router, intents } = build();
      await expect(router.invoke({ ...NOTIFICATION, ...over })).rejects.toThrow(
        /^plugin_hook_rejected$/u
      );
      expect(intents.load).not.toHaveBeenCalled();
    }
  );
  it('runs a notifier capability event of another type as an account event', async () => {
    const { router, dynamicInvoke, intents } = build();
    await router.invoke({ ...ACCOUNT, capability: 'notifier.send' });
    expect(dynamicInvoke).toHaveBeenCalledOnce();
    expect(intents.complete).not.toHaveBeenCalled();
  });
});

describe('notification references', () => {
  it('rejects a reference when no intent store is available', async () => {
    const { router, dynamicInvoke } = build({ intents: false });
    await expect(router.invoke(NOTIFICATION)).rejects.toThrow(/^plugin_hook_rejected$/u);
    expect(dynamicInvoke).not.toHaveBeenCalled();
  });
  it('loads the intent, executes with its decrypted payload and completes it', async () => {
    const { router, dynamicInvoke, intents } = build();
    await router.invoke(NOTIFICATION);
    expect(intents.load).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      reference: NOTIFICATION.payload,
      now: 500,
    });
    expect(dynamicInvoke).toHaveBeenCalledWith({
      ...NOTIFICATION,
      payload: {
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        eventType: 'notification.delivery.requested',
        eventVersion: 1,
        notificationKind: 'auth.email_otp',
        expiresAt: 900,
        delivery: DELIVERY,
      },
    });
    expect(intents.complete).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'installation-a',
      providerMessageId: undefined,
      now: 500,
    });
  });
  it('does nothing further for an intent that is already delivered', async () => {
    const { router, dynamicInvoke, intents } = build({
      load: async () => ({ ...LOADED, state: 'delivered' }),
    });
    await expect(router.invoke(NOTIFICATION)).resolves.toBeUndefined();
    expect(dynamicInvoke).not.toHaveBeenCalled();
    expect(intents.complete).not.toHaveBeenCalled();
  });
  it.each([
    ['notification_intent_key_unavailable', 'plugin_notification_key_unavailable'],
    ['notification_intent_key_unwrap_failed', 'plugin_notification_key_unwrap_failed'],
    [
      'notification_intent_payload_authentication_failed',
      'plugin_notification_payload_authentication_failed',
    ],
    ['notification_intent_decryption_failed', 'plugin_notification_decryption_failed'],
    ['notification_intent_envelope_invalid', 'plugin_notification_envelope_invalid'],
    ['notification_intent_payload_invalid', 'plugin_notification_payload_invalid'],
    ['notification_intent_unavailable', 'plugin_hook_rejected'],
    ['notification_intent_terminal', 'plugin_hook_rejected'],
    ['notification_intent_expired', 'plugin_hook_rejected'],
    ['notification_intent_row_invalid', 'plugin_hook_rejected'],
    ['notification_intent_delivery_input_invalid', 'plugin_hook_rejected'],
    ['notification_intent_wipe_stale', 'plugin_hook_transient_failure'],
    ['d1 down', 'plugin_hook_transient_failure'],
  ])('maps the load failure %s to %s', async (message, code) => {
    const { router, dynamicInvoke } = build({ load: () => Promise.reject(new Error(message)) });
    await expect(router.invoke(NOTIFICATION)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    expect(dynamicInvoke).not.toHaveBeenCalled();
  });
  it('treats a non-Error load failure as transient', async () => {
    const { router } = build({ load: () => rejectOpaque('notification_intent_expired') });
    await expect(router.invoke(NOTIFICATION)).rejects.toThrow(/^plugin_hook_transient_failure$/u);
  });
  it('records the provider message id the backend returned', async () => {
    const { router, intents } = build({
      dynamic: (async () => ({ providerMessageId: 'msg-9' })) as never,
    });
    await router.invoke(NOTIFICATION);
    expect(intents.complete).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'msg-9' })
    );
  });
  it('reports a completion failure as transient after the delivery ran', async () => {
    const { router, dynamicInvoke } = build({ complete: () => Promise.reject(new Error('stale')) });
    await expect(router.invoke(NOTIFICATION)).rejects.toThrow(/^plugin_hook_transient_failure$/u);
    expect(dynamicInvoke).toHaveBeenCalledOnce();
  });
  it('does not complete the intent when delivery failed', async () => {
    const { router, intents } = build({ dynamic: () => Promise.reject(new Error('boom')) });
    await expect(router.invoke(NOTIFICATION)).rejects.toThrow('boom');
    expect(intents.complete).not.toHaveBeenCalled();
  });
});

describe('built-in handlers', () => {
  const run = (
    handler: InProcessPluginHookHandler | null,
    invocation = ACCOUNT,
    over: Parameters<typeof build>[0] = {}
  ) => build({ target: IN_PROCESS, handler, ...over }).router.invoke(invocation);
  it('refuses a plugin without a registered handler', async () => {
    await expect(run(null)).rejects.toThrow(/^plugin_hook_provider_rejected$/u);
  });
  it('looks the handler up by plugin and capability', async () => {
    const handler = vi.fn<InProcessPluginHookHandler>(async () => undefined);
    await run(handler);
    expect(handler).toHaveBeenCalledOnce();
    const [execution, access] = must(handler.mock.calls[0]);
    expect(execution).toEqual(ACCOUNT);
    expect(Object.keys(access).sort()).toEqual(['fetchExternal', 'signal', 'writeAccountMetadata']);
  });
  it('gives notifier handlers the decrypted execution payload and records the result', async () => {
    const handler = vi.fn<InProcessPluginHookHandler>(async () => ({ providerMessageId: 'm-1' }));
    const { router, intents } = build({ target: IN_PROCESS, handler });
    await router.invoke(NOTIFICATION);
    expect(must(handler.mock.calls[0])[0].payload).toMatchObject({
      delivery: DELIVERY,
      notificationKind: 'auth.email_otp',
    });
    expect(intents.complete).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'm-1' })
    );
  });
  it.each([
    ['plugin_in_process_message_rejected', 'plugin_hook_rejected'],
    ['plugin_in_process_provider_rejected', 'plugin_hook_provider_rejected'],
    ['plugin_in_process_transient_failure', 'plugin_hook_transient_failure'],
    ['anything else', 'plugin_hook_transient_failure'],
  ])('maps the handler failure %s to %s', async (message, code) => {
    await expect(run(async () => Promise.reject(new Error(message)))).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
  });
  it('treats a non-Error handler failure as transient', async () => {
    await expect(run(() => rejectOpaque('plugin_in_process_message_rejected'))).rejects.toThrow(
      /^plugin_hook_transient_failure$/u
    );
  });
  it('turns a handler that outlives its timeout into a transient failure and signals abort', async () => {
    let signal: AbortSignal | undefined;
    const handler: InProcessPluginHookHandler = (_input, access) => {
      signal = access.signal;
      return new Promise(() => undefined);
    };
    const { router } = build({ target: { ...IN_PROCESS, timeoutMs: 5 }, handler });
    await expect(router.invoke(ACCOUNT)).rejects.toThrow(/^plugin_hook_transient_failure$/u);
    expect(signal?.aborted).toBe(true);
  });
  it('hands the handler a signal that is not yet aborted', async () => {
    let aborted: boolean | undefined;
    await run(async (_input, access) => {
      aborted = access.signal.aborted;
    });
    expect(aborted).toBe(false);
  });
  describe('host-owned access', () => {
    const capture = async (over: Parameters<typeof build>[0] = {}, invocation = ACCOUNT) => {
      let captured: Parameters<InProcessPluginHookHandler>[1] | undefined;
      await run(
        async (_input, access) => {
          captured = access;
        },
        invocation,
        over
      );
      return must(captured);
    };
    it('forwards external fetches through the egress gateway scoped to this invocation', async () => {
      outcomes.set('PluginOutboundGateway.fetch', new Response('ok'));
      const access = await capture({ scope: SCOPE });
      const request = new Request('https://api.example.com/x');
      await expect(access.fetchExternal(request)).resolves.toBeInstanceOf(Response);
      expect(callsTo('PluginOutboundGateway.new')).toEqual([
        [
          {
            MARKER: 'env',
            AUTHRIM_PLUGIN_EGRESS_CONTEXT: {
              contractVersion: 1,
              tenantId: 'tenant-a',
              pluginInstallationId: 'installation-a',
              capability: 'hook.account.lifecycle',
              requestId: 'event-a',
              executionScope: { ...SCOPE, accountId: 'account-a' },
            },
          },
        ],
      ]);
      expect(callsTo('PluginOutboundGateway.fetch')).toEqual([[request]]);
    });
    it('omits the execution scope when the router has none and the account when the payload has none', async () => {
      const access = await capture({});
      await access.fetchExternal(new Request('https://api.example.com/x'));
      const context = (
        must(callsTo('PluginOutboundGateway.new')[0])[0] as {
          AUTHRIM_PLUGIN_EGRESS_CONTEXT: object;
        }
      ).AUTHRIM_PLUGIN_EGRESS_CONTEXT;
      expect(context).toEqual({
        contractVersion: 1,
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        capability: 'hook.account.lifecycle',
        requestId: 'event-a',
      });
      expect(Object.keys(context)).not.toContain('executionScope');
      resetKit();
      const notification = await capture({ scope: SCOPE }, NOTIFICATION);
      await notification.fetchExternal(new Request('https://api.example.com/x'));
      const scoped = (
        must(callsTo('PluginOutboundGateway.new')[0])[0] as {
          AUTHRIM_PLUGIN_EGRESS_CONTEXT: { executionScope: object; requestId: string };
        }
      ).AUTHRIM_PLUGIN_EGRESS_CONTEXT;
      expect(scoped.executionScope).toEqual(SCOPE);
      expect(scoped.requestId).toBe('challenge-a/email');
    });
    it('writes account metadata through the metadata service with the same context', async () => {
      const access = await capture({ scope: SCOPE });
      const input = {
        operationId: 'op',
        accountId: 'account-a',
        metadataKey: 'k',
        value: 1,
        expectedVersion: null,
      };
      await expect(access.writeAccountMetadata(input)).resolves.toBe(
        'PluginAccountMetadataService.write:result'
      );
      expect(callsTo('PluginAccountMetadataService.new')).toEqual([[{ MARKER: 'env' }]]);
      expect(callsTo('PluginAccountMetadataService.write')).toEqual([
        [
          {
            contractVersion: 1,
            tenantId: 'tenant-a',
            pluginInstallationId: 'installation-a',
            capability: 'hook.account.lifecycle',
            requestId: 'event-a',
            executionScope: { ...SCOPE, accountId: 'account-a' },
          },
          input,
        ],
      ]);
    });
  });
});

describe('static registry', () => {
  it('resolves by exact plugin and capability and defaults to nothing', () => {
    const handler: InProcessPluginHookHandler = async () => undefined;
    const registry = new StaticInProcessPluginRegistry(new Map([['plugin-a:cap.one', handler]]));
    expect(registry.resolve('plugin-a', 'cap.one')).toBe(handler);
    expect(registry.resolve('plugin-a', 'cap.two')).toBeNull();
    expect(registry.resolve('plugin-b', 'cap.one')).toBeNull();
    expect(new StaticInProcessPluginRegistry().resolve('plugin-a', 'cap.one')).toBeNull();
  });
});
