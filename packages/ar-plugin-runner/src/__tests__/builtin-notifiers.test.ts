import { describe, expect, it, vi } from 'vitest';
import { createBuiltinNotifierRegistry } from '../builtin-notifiers';
import type { InProcessPluginAccess } from '../backend-router';
import type { PluginHookExecutionInvocation, PluginRunnerEnv } from '../types';

const invocation: PluginHookExecutionInvocation = {
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
    notificationKind: 'auth.email_otp',
    expiresAt: 1_300,
    delivery: {
      channel: 'email',
      to: 'person@example.test',
      subject: 'Sign-in code',
      body: '<p>Code: 123456</p>',
      replyTo: 'reply@example.test',
    },
  },
};

function access(fetchExternal: InProcessPluginAccess['fetchExternal']): InProcessPluginAccess {
  return {
    signal: new AbortController().signal,
    fetchExternal,
    writeAccountMetadata: vi.fn(),
  };
}

describe('built-in notifier registry', () => {
  it('sends a scoped Resend request through the host gateway without a credential value', async () => {
    const fetchExternal = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.resend.com/emails');
      expect(request.headers.get('Authorization')).toBeNull();
      expect(request.headers.get('Idempotency-Key')).toBe('challenge-a/email');
      await expect(request.json()).resolves.toEqual({
        from: '"Authrim" <noreply@example.test>',
        to: ['person@example.test'],
        subject: 'Sign-in code',
        html: '<p>Code: 123456</p>',
        reply_to: 'reply@example.test',
      });
      return new Response('{"id":"message-a"}', { status: 202 });
    });
    const handler = createBuiltinNotifierRegistry({
      EMAIL_FROM: 'noreply@example.test',
      EMAIL_FROM_NAME: 'Authrim',
    } as PluginRunnerEnv).resolve('notifier-resend', 'notifier.send');

    await expect(handler?.(invocation, access(fetchExternal))).resolves.toEqual({
      providerMessageId: 'message-a',
    });
    expect(fetchExternal).toHaveBeenCalledTimes(1);
  });

  it('classifies Resend rate limits as transient and validation errors as permanent', async () => {
    const handler = createBuiltinNotifierRegistry({
      EMAIL_FROM: 'noreply@example.test',
    } as PluginRunnerEnv).resolve('notifier-resend', 'notifier.send');
    await expect(
      handler?.(
        invocation,
        access(async () => new Response(null, { status: 429 }))
      )
    ).rejects.toThrow('plugin_in_process_transient_failure');
    await expect(
      handler?.(
        invocation,
        access(async () => new Response(null, { status: 400 }))
      )
    ).rejects.toThrow('plugin_in_process_message_rejected');
    await expect(
      handler?.(
        invocation,
        access(async () => new Response(null, { status: 401 }))
      )
    ).rejects.toThrow('plugin_in_process_provider_rejected');
  });

  it('uses only the Runner Cloudflare Email binding for the built-in Cloudflare provider', async () => {
    const send = vi.fn(async () => ({ messageId: 'message-a' }));
    const handler = createBuiltinNotifierRegistry({
      EMAIL: { send },
      EMAIL_FROM: 'noreply@example.test',
    } as unknown as PluginRunnerEnv).resolve('notifier-cloudflare', 'notifier.send');
    const fetchExternal = vi.fn();

    await expect(handler?.(invocation, access(fetchExternal))).resolves.toEqual({
      providerMessageId: 'message-a',
    });
    expect(send).toHaveBeenCalledWith({
      to: 'person@example.test',
      from: 'noreply@example.test',
      subject: 'Sign-in code',
      html: '<p>Code: 123456</p>',
      replyTo: 'reply@example.test',
    });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('rejects non-notification and non-email invocations', async () => {
    const handler = createBuiltinNotifierRegistry({
      EMAIL_FROM: 'noreply@example.test',
    } as PluginRunnerEnv).resolve('notifier-resend', 'notifier.send');
    await expect(
      handler?.(
        {
          ...invocation,
          payload: {
            tenantId: 'tenant-a',
            accountId: 'account-a',
            eventType: 'account.created',
            eventVersion: 1,
          },
        },
        access(vi.fn())
      )
    ).rejects.toThrow('plugin_in_process_message_rejected');
  });

  it('rejects invalid email fields and unsafe configured sender names before egress', async () => {
    const fetchExternal = vi.fn();
    if (!('delivery' in invocation.payload)) throw new Error('invalid_test_fixture');
    const notificationPayload = invocation.payload;
    const invalidPayloadHandler = createBuiltinNotifierRegistry({
      EMAIL_FROM: 'noreply@example.test',
    } as PluginRunnerEnv).resolve('notifier-resend', 'notifier.send');
    await expect(
      invalidPayloadHandler?.(
        {
          ...invocation,
          payload: {
            ...notificationPayload,
            delivery: {
              ...notificationPayload.delivery,
              subject: 'subject\r\nBcc: attacker@example.test',
            },
          },
        },
        access(fetchExternal)
      )
    ).rejects.toThrow('plugin_in_process_message_rejected');

    const invalidNameHandler = createBuiltinNotifierRegistry({
      EMAIL_FROM: 'noreply@example.test',
      EMAIL_FROM_NAME: 'Authrim\r\nBcc: attacker@example.test',
    } as PluginRunnerEnv).resolve('notifier-resend', 'notifier.send');
    await expect(invalidNameHandler?.(invocation, access(fetchExternal))).rejects.toThrow(
      'plugin_in_process_provider_rejected'
    );
    expect(fetchExternal).not.toHaveBeenCalled();
  });
});
