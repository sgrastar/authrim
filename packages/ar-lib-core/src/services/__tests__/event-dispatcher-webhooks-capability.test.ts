/**
 * The platform `webhooks` capability at the event dispatcher: nothing is delivered while it is
 * off, delivery is unchanged while it is on, and an unreadable switch keeps delivering.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  createEventDispatcher,
  resetWebhookSkipLogForTests,
  type EventDispatcherConfig,
} from '../event-dispatcher';

vi.mock('../../utils/audit-log', () => ({ writeLegacyAuditLog: vi.fn(async () => undefined) }));

const webhook = {
  id: 'wh_1',
  tenantId: 'tenant_default',
  url: 'https://example.com/webhook',
  secretEncrypted: 'encrypted_secret',
  timeoutMs: 10000,
  events: ['auth.*'],
  active: true,
};

function settingsKv(state: boolean | 'down'): KVNamespace {
  return {
    get: vi.fn(async (key: string) => {
      if (key !== 'settings:platform:tenant-capabilities') return null;
      if (state === 'down') throw new Error('kv down');
      return JSON.stringify({ 'tenant_capabilities.webhooks': state });
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function publishWith(state: boolean | 'down') {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const findByEventType = vi.fn(async () => [webhook]);
  const config = {
    env: { SETTINGS: settingsKv(state) } as unknown as Env,
    adapter: {
      query: vi.fn(async () => []),
      queryOne: vi.fn(async () => null),
      execute: vi.fn(async () => ({ rowsAffected: 1, success: true })),
    } as unknown as DatabaseAdapter,
    kv: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    webhookRegistry: {
      findByEventType,
      recordSuccess: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
    } as unknown as EventDispatcherConfig['webhookRegistry'],
    handlerRegistry: {
      getHandlers: vi.fn(() => []),
    } as unknown as EventDispatcherConfig['handlerRegistry'],
    hookRegistry: {
      getBeforeHooks: vi.fn(() => []),
      getAfterHooks: vi.fn(() => []),
    } as unknown as EventDispatcherConfig['hookRegistry'],
    decryptSecret: vi.fn(async (secret: string) => secret.replace('encrypted_', '')),
  } satisfies EventDispatcherConfig;
  const dispatcher = createEventDispatcher(config);
  return {
    fetchMock,
    findByEventType,
    result: dispatcher.publish({
      type: 'auth.login.succeeded',
      tenantId: 'tenant_default',
      data: { userId: 'user_123' },
    }),
  };
}

describe('the platform webhooks capability', () => {
  it('sends nothing while off, and does not even look up the webhooks', async () => {
    const { fetchMock, findByEventType, result } = publishWith(false);
    const published = await result;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findByEventType).not.toHaveBeenCalled();
    expect(published.delivery.webhooks).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it('sends while on', async () => {
    const { fetchMock, result } = publishWith(true);
    const published = await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(published.delivery.webhooks.sent).toBe(1);
  });

  it('keeps sending (the earlier behaviour) when the switch cannot be read', async () => {
    const { fetchMock, result } = publishWith('down');
    const published = await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(published.delivery.webhooks.sent).toBe(1);
  });
});

describe('a skipped inline delivery is observable without an audit record per event', () => {
  it('logs at most once a minute, with the count since the previous line', async () => {
    resetWebhookSkipLogForTests();
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'info').mockImplementation(capture),
    ];
    for (let index = 0; index < 4; index += 1) {
      await publishWith(false).result;
    }
    for (const spy of spies) spy.mockRestore();
    const skippedLines = lines.filter((line) => line.includes('Webhook deliveries skipped'));
    expect(skippedLines).toHaveLength(1);
    expect(skippedLines[0]).toContain('webhooks');
  });
});
