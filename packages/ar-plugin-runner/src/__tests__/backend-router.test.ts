import { describe, expect, it, vi } from 'vitest';
import {
  PluginHookBackendRouter,
  StaticInProcessPluginRegistry,
  type InProcessPluginHookHandler,
} from '../backend-router';
import type { PluginHookInvocation, PluginRunnerEnv } from '../types';

const invocation: PluginHookInvocation = {
  pluginInstallationId: 'installation-a',
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
};

const notificationInvocation: PluginHookInvocation = {
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

function environment(): PluginRunnerEnv {
  return {} as PluginRunnerEnv;
}

describe('PluginHookBackendRouter', () => {
  it('routes Dynamic Worker installations through the shared capability interface', async () => {
    const dynamicInvoke = vi.fn(async () => undefined);
    const router = new PluginHookBackendRouter(
      environment(),
      {
        resolveBackend: async () => ({
          pluginId: 'plugin-a',
          backendKind: 'dynamic_worker',
          timeoutMs: 1_000,
        }),
      } as never,
      { invoke: dynamicInvoke },
      new StaticInProcessPluginRegistry()
    );

    await expect(router.invoke(invocation)).resolves.toBeUndefined();
    expect(dynamicInvoke).toHaveBeenCalledWith(invocation);
  });

  it('gives an in-process handler only bounded host-owned access', async () => {
    const implementation: InProcessPluginHookHandler = async (_input, access) => {
      expect(access.signal).toBeInstanceOf(AbortSignal);
      expect(typeof access.fetchExternal).toBe('function');
      expect(typeof access.writeAccountMetadata).toBe('function');
      expect(Object.keys(access).sort()).toEqual([
        'fetchExternal',
        'signal',
        'writeAccountMetadata',
      ]);
    };
    const handler = vi.fn(implementation);
    const router = new PluginHookBackendRouter(
      environment(),
      {
        resolveBackend: async () => ({
          pluginId: 'builtin-a',
          backendKind: 'in_process',
          timeoutMs: 1_000,
        }),
      } as never,
      { invoke: vi.fn() },
      new StaticInProcessPluginRegistry(new Map([['builtin-a:notifier.send', handler]]))
    );

    await expect(router.invoke(invocation)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith(invocation, expect.any(Object));
  });

  it('rejects an unregistered in-process capability without dynamic fallback', async () => {
    const dynamicInvoke = vi.fn();
    const router = new PluginHookBackendRouter(
      environment(),
      {
        resolveBackend: async () => ({
          pluginId: 'builtin-a',
          backendKind: 'in_process',
          timeoutMs: 1_000,
        }),
      } as never,
      { invoke: dynamicInvoke },
      new StaticInProcessPluginRegistry()
    );

    await expect(router.invoke(invocation)).rejects.toThrow('plugin_hook_provider_rejected');
    expect(dynamicInvoke).not.toHaveBeenCalled();
  });

  it('authorizes before decrypting and passes only a scoped notification payload', async () => {
    const dynamicInvoke = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({
      state: 'pending' as const,
      intentId: 'intent-a',
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      notificationKind: 'auth.email_otp',
      idempotencyKey: 'challenge-a/email',
      expiresAt: 1_300,
      payload: {
        channel: 'email' as const,
        to: 'person@example.test',
        subject: 'Sign-in code',
        body: 'Code: 123456',
      },
    }));
    const resolveBackend = vi.fn(async () => ({
      pluginId: 'plugin-a',
      backendKind: 'dynamic_worker' as const,
      timeoutMs: 1_000,
    }));
    const router = new PluginHookBackendRouter(
      environment(),
      { resolveBackend } as never,
      { invoke: dynamicInvoke },
      new StaticInProcessPluginRegistry(),
      undefined,
      { load, complete, failPermanent: vi.fn() } as never,
      () => 1_100
    );

    await expect(router.invoke(notificationInvocation)).resolves.toBeUndefined();
    expect(resolveBackend.mock.invocationCallOrder[0]).toBeLessThan(
      load.mock.invocationCallOrder[0]
    );
    expect(dynamicInvoke).toHaveBeenCalledWith({
      ...notificationInvocation,
      payload: {
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        eventType: 'notification.delivery.requested',
        eventVersion: 1,
        notificationKind: 'auth.email_otp',
        expiresAt: 1_300,
        delivery: {
          channel: 'email',
          to: 'person@example.test',
          subject: 'Sign-in code',
          body: 'Code: 123456',
        },
      },
    });
    expect(complete).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      pluginInstallationId: 'installation-a',
      providerMessageId: undefined,
      now: 1_100,
    });
  });

  it('leaves terminal intent handling to the fenced outbox state machine', async () => {
    const failPermanent = vi.fn(async () => undefined);
    const store = {
      load: vi.fn(async () => ({
        state: 'pending' as const,
        intentId: 'intent-a',
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        notificationKind: 'auth.email_otp',
        idempotencyKey: 'challenge-a/email',
        expiresAt: 1_300,
        payload: { channel: 'email' as const, to: 'person@example.test', body: 'secret' },
      })),
      complete: vi.fn(),
      failPermanent,
    };
    const router = (message: string) =>
      new PluginHookBackendRouter(
        environment(),
        {
          resolveBackend: async () => ({
            pluginId: 'plugin-a',
            backendKind: 'dynamic_worker',
            timeoutMs: 1_000,
          }),
        } as never,
        { invoke: async () => Promise.reject(new Error(message)) },
        new StaticInProcessPluginRegistry(),
        undefined,
        store as never,
        () => 1_100
      );

    await expect(
      router('plugin_hook_provider_rejected').invoke(notificationInvocation)
    ).rejects.toThrow('plugin_hook_provider_rejected');
    expect(failPermanent).not.toHaveBeenCalled();
    await expect(
      router('plugin_hook_transient_failure').invoke(notificationInvocation)
    ).rejects.toThrow('plugin_hook_transient_failure');
    expect(failPermanent).not.toHaveBeenCalled();
  });

  it('retries after provider acceptance when delivered-state persistence fails', async () => {
    const dynamicInvoke = vi.fn(async () => undefined);
    const failPermanent = vi.fn();
    const router = new PluginHookBackendRouter(
      environment(),
      {
        resolveBackend: async () => ({
          pluginId: 'plugin-a',
          backendKind: 'dynamic_worker',
          timeoutMs: 1_000,
        }),
      } as never,
      { invoke: dynamicInvoke },
      new StaticInProcessPluginRegistry(),
      undefined,
      {
        load: async () => ({
          state: 'pending' as const,
          intentId: 'intent-a',
          tenantId: 'tenant-a',
          pluginInstallationId: 'installation-a',
          notificationKind: 'auth.email_otp',
          idempotencyKey: 'challenge-a/email',
          expiresAt: 1_300,
          payload: { channel: 'email' as const, to: 'person@example.test', body: 'secret' },
        }),
        complete: async () => Promise.reject(new Error('d1_unavailable')),
        failPermanent,
      } as never,
      () => 1_100
    );

    await expect(router.invoke(notificationInvocation)).rejects.toThrow(
      'plugin_hook_transient_failure'
    );
    expect(dynamicInvoke).toHaveBeenCalledOnce();
    expect(failPermanent).not.toHaveBeenCalled();
  });

  it('does not decrypt a notification for an unavailable installation', async () => {
    const load = vi.fn();
    const router = new PluginHookBackendRouter(
      environment(),
      { resolveBackend: async () => null } as never,
      { invoke: vi.fn() },
      new StaticInProcessPluginRegistry(),
      undefined,
      { load } as never
    );

    await expect(router.invoke(notificationInvocation)).rejects.toThrow(
      'plugin_hook_provider_rejected'
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('retries an installation lookup storage failure without decrypting the notification', async () => {
    const load = vi.fn();
    const router = new PluginHookBackendRouter(
      environment(),
      { resolveBackend: async () => Promise.reject(new Error('d1_unavailable')) } as never,
      { invoke: vi.fn() },
      new StaticInProcessPluginRegistry(),
      undefined,
      { load } as never
    );

    await expect(router.invoke(notificationInvocation)).rejects.toThrow(
      'plugin_hook_transient_failure'
    );
    expect(load).not.toHaveBeenCalled();
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
  ])('preserves safe notification diagnostics for %s', async (sourceCode, expectedCode) => {
    const router = new PluginHookBackendRouter(
      environment(),
      {
        resolveBackend: async () => ({
          pluginId: 'plugin-a',
          backendKind: 'dynamic_worker',
          timeoutMs: 1_000,
        }),
      } as never,
      { invoke: vi.fn() },
      new StaticInProcessPluginRegistry(),
      undefined,
      { load: async () => Promise.reject(new Error(sourceCode)) } as never,
      () => 1_100
    );

    await expect(router.invoke(notificationInvocation)).rejects.toThrow(expectedCode);
  });
});
