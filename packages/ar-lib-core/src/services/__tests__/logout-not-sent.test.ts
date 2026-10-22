/**
 * A downstream logout that could not be sent at all (no issuer to sign with) is made visible: a
 * failure record with the reason `issuer_unresolved` for each app that was not told, which
 * /api/admin/logout-failures lists, and an audit entry per user with the path and the counts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/audit-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/audit-log')>()),
  createAuditLog: auditMock,
}));

import { LogoutKVHelpers } from '../backchannel-logout-sender';
import { reportLogoutNotSent, type LogoutFanoutSession } from '../logout-fanout';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
    })),
  };
}

const client = (clientId: string) => ({ client_id: clientId }) as never;

const sessions: LogoutFanoutSession[] = [
  {
    sessionId: 'session-1',
    userId: 'user-1',
    backchannelClients: [client('rp-a'), client('rp-b')],
    webhookClients: [client('rp-c')],
  },
  {
    sessionId: 'session-2',
    userId: 'user-1',
    backchannelClients: [client('rp-a')],
    webhookClients: [],
  },
  {
    sessionId: 'session-3',
    userId: 'user-2',
    backchannelClients: [],
    webhookClients: [client('rp-c')],
  },
];

describe('reportLogoutNotSent', () => {
  let kv: ReturnType<typeof memoryKv>;
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
    kv = memoryKv();
  });
  const report = (overrides: Partial<Parameters<typeof reportLogoutNotSent>[1]> = {}) =>
    reportLogoutNotSent({ SETTINGS: kv } as never, {
      tenantId: 'tenant-a',
      trigger: 'user_logout',
      sessions,
      backchannelEnabled: true,
      webhookEnabled: true,
      ...overrides,
    });

  it('leaves a failure record for each app that was not told, listed by the admin API', async () => {
    const summary = await report();

    expect(summary).toEqual({ sessions: 3, clients: 3 });
    expect((await LogoutKVHelpers.listFailures(kv as never)).sort()).toEqual([
      'rp-a',
      'rp-b',
      'rp-c',
    ]);
    expect(await LogoutKVHelpers.getFailure(kv as never, 'rp-b')).toMatchObject({
      error: 'issuer_unresolved',
      timestamp: expect.any(Number),
    });
  });

  it('records the path and the counts in the audit log, once per user, with no value or id of an app', async () => {
    await report({ metadata: { provider_id: 'provider-1', upstream_flow_id: 'flow-1' } });

    const entries = auditMock.mock.calls.map(([, entry]) => entry);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => [entry.userId, JSON.parse(entry.metadata)])).toEqual([
      [
        'user-1',
        {
          trigger: 'user_logout',
          error_code: 'issuer_unresolved',
          session_count: 2,
          client_count: 3,
          provider_id: 'provider-1',
          upstream_flow_id: 'flow-1',
        },
      ],
      [
        'user-2',
        expect.objectContaining({
          session_count: 1,
          client_count: 1,
          error_code: 'issuer_unresolved',
        }),
      ],
    ]);
    expect(entries[0]).toMatchObject({
      tenantId: 'tenant-a',
      action: 'user.downstream_logout_failed',
      severity: 'warning',
    });
    for (const entry of entries) {
      for (const clientId of ['rp-a', 'rp-b', 'rp-c']) {
        expect(entry.metadata).not.toContain(clientId);
      }
      expect(entry.metadata).not.toContain('session-');
    }
  });

  it('leaves out the kind of notice the tenant has turned off', async () => {
    const summary = await report({ webhookEnabled: false });
    expect(summary).toEqual({ sessions: 2, clients: 2 });
    expect((await LogoutKVHelpers.listFailures(kv as never)).sort()).toEqual(['rp-a', 'rp-b']);

    kv.store.clear();
    expect(await report({ backchannelEnabled: false, webhookEnabled: false })).toEqual({
      sessions: 0,
      clients: 0,
    });
    expect(kv.store.size).toBe(0);
  });

  it('does not throw when the record or the audit entry cannot be written', async () => {
    kv.put.mockRejectedValue(new Error('kv down'));
    auditMock.mockRejectedValue(new Error('audit down'));
    await expect(report()).resolves.toEqual({ sessions: 3, clients: 3 });
  });
});
