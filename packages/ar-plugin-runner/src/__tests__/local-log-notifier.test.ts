import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinNotifierRegistry } from '../builtin-notifiers';
import { D1NotificationInstallationStore } from '../notification-installations';
import {
  LOCAL_LOG_NOTIFIER_ENV,
  LOCAL_LOG_NOTIFIER_PLUGIN_ID,
  isLocalLogNotifierEnabled,
} from '../local-log-notifier';
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
    notificationKind: 'auth.direct-email-code',
    expiresAt: 1_300,
    delivery: {
      channel: 'email',
      to: 'person@example.test',
      subject: 'Your code',
      body: 'Code: 123456',
    },
  },
};

const access: InProcessPluginAccess = {
  signal: new AbortController().signal,
  fetchExternal: vi.fn(),
  writeAccountMetadata: vi.fn(),
};

function envWith(value?: string): PluginRunnerEnv {
  return (value === undefined ? {} : { [LOCAL_LOG_NOTIFIER_ENV]: value }) as PluginRunnerEnv;
}

afterEach(() => vi.restoreAllMocks());

describe('local log notifier', () => {
  it('is absent from the registry unless the local deployment variable is exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const registry = createBuiltinNotifierRegistry(envWith(value));
      expect(registry.resolve(LOCAL_LOG_NOTIFIER_PLUGIN_ID, 'notifier.send')).toBeNull();
      expect(isLocalLogNotifierEnabled(envWith(value))).toBe(false);
    }
  });

  it('keeps the Cloudflare and Resend providers registered either way', () => {
    for (const value of [undefined, 'true']) {
      const registry = createBuiltinNotifierRegistry(envWith(value));
      expect(registry.resolve('notifier-resend', 'notifier.send')).not.toBeNull();
      expect(registry.resolve('notifier-cloudflare', 'notifier.send')).not.toBeNull();
    }
  });

  it('writes the delivery, including the code, to the log when enabled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = createBuiltinNotifierRegistry(envWith('true')).resolve(
      LOCAL_LOG_NOTIFIER_PLUGIN_ID,
      'notifier.send'
    );
    const result = await handler?.(invocation, access);

    expect(result?.providerMessageId).toMatch(/^local-log-/u);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line.startsWith('[LOCAL-NOTIFICATION] ')).toBe(true);
    expect(JSON.parse(line.slice('[LOCAL-NOTIFICATION] '.length))).toMatchObject({
      kind: 'auth.direct-email-code',
      tenantId: 'tenant-a',
      channel: 'email',
      to: 'person@example.test',
      body: 'Code: 123456',
    });
  });

  it('logs sms and push deliveries too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = createBuiltinNotifierRegistry(envWith('true')).resolve(
      LOCAL_LOG_NOTIFIER_PLUGIN_ID,
      'notifier.send'
    );
    await handler?.(
      {
        ...invocation,
        payload: {
          ...invocation.payload,
          delivery: { channel: 'sms', to: '+15550100', body: 'Code 654321' },
        },
      } as PluginHookExecutionInvocation,
      access
    );
    expect(String(log.mock.calls[0]?.[0])).toContain('"channel":"sms"');
  });

  it('cannot be installed through the installation API', async () => {
    const store = new D1NotificationInstallationStore({} as never);
    await expect(
      store.configure({
        installationId: 'installation-a',
        tenantId: 'tenant-a',
        pluginId: LOCAL_LOG_NOTIFIER_PLUGIN_ID,
        backendKind: 'in_process',
        enabled: true,
      })
    ).rejects.toThrow('plugin_notification_installation_input_invalid');
  });
});
