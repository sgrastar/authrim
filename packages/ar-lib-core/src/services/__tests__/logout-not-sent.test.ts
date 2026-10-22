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
import {
  reportIncompleteLogouts,
  reportLogoutNotSent,
  reportLogoutTargetsUnavailable,
  type LogoutFanoutSession,
} from '../logout-fanout';

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

  it('records the path, the reason and the counts in one audit entry that names no user, app or session', async () => {
    await report({
      reason: 'signing_key_unavailable',
      metadata: { provider_id: 'provider-1', upstream_flow_id: 'flow-1' },
    });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entry = auditMock.mock.calls[0][1];
    expect(entry).toMatchObject({
      tenantId: 'tenant-a',
      action: 'user.downstream_logout_failed',
      severity: 'warning',
      // Attributed to the system: a user logout may only know the sub of an id_token_hint.
      userId: 'system',
      resourceId: 'user_logout',
    });
    expect(JSON.parse(entry.metadata)).toEqual({
      trigger: 'user_logout',
      error_code: 'signing_key_unavailable',
      session_count: 3,
      client_count: 3,
      provider_id: 'provider-1',
      upstream_flow_id: 'flow-1',
    });
    const recorded = JSON.stringify(entry);
    for (const secret of ['rp-a', 'rp-b', 'rp-c', 'session-', 'user-1', 'user-2']) {
      expect(recorded).not.toContain(secret);
    }
    expect(await LogoutKVHelpers.getFailure(kv as never, 'rp-a')).toMatchObject({
      error: 'signing_key_unavailable',
    });
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

describe('reportLogoutTargetsUnavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
  });

  it('records one audit entry with the path and the number of sessions, and no id', async () => {
    await reportLogoutTargetsUnavailable({} as never, {
      tenantId: 'tenant-a',
      trigger: 'user_logout',
      sessionCount: 2,
      metadata: { provider_id: 'provider-1' },
    });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entry = auditMock.mock.calls[0][1];
    expect(entry).toMatchObject({
      tenantId: 'tenant-a',
      action: 'user.downstream_logout_failed',
      severity: 'warning',
      userId: 'system',
      resourceId: 'user_logout',
    });
    expect(JSON.parse(entry.metadata)).toEqual({
      trigger: 'user_logout',
      error_code: 'logout_targets_unavailable',
      session_count: 2,
      client_count: null,
      provider_id: 'provider-1',
    });
  });

  it('writes nothing when no session is concerned, and does not throw when the audit fails', async () => {
    await reportLogoutTargetsUnavailable({} as never, {
      tenantId: 'tenant-a',
      trigger: 'user_logout',
      sessionCount: 0,
    });
    expect(auditMock).not.toHaveBeenCalled();

    auditMock.mockRejectedValue(new Error('audit down'));
    await expect(
      reportLogoutTargetsUnavailable({} as never, {
        tenantId: 'tenant-a',
        trigger: 'user_logout',
        sessionCount: 1,
      })
    ).resolves.toBeUndefined();
  });
});

describe('reportIncompleteLogouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockResolvedValue(undefined);
  });

  it('reports each kind of notice and reason for its own sessions and apps only', async () => {
    const kv = memoryKv();
    await reportIncompleteLogouts({ SETTINGS: kv } as never, {
      tenantId: 'tenant-a',
      trigger: 'upstream_backchannel_logout',
      sessions,
      incomplete: [
        { kind: 'backchannel', sessionIds: ['session-1'], reason: 'signing_key_unavailable' },
        { kind: 'webhook', sessionIds: ['session-3'], reason: 'send_failed' },
        { kind: 'webhook', sessionIds: ['session-3'], reason: 'send_failed' },
      ],
    });

    // session-1: its back-channel apps only (not its webhook app); session-3: its webhook app.
    expect(await LogoutKVHelpers.getFailure(kv as never, 'rp-a')).toMatchObject({
      error: 'signing_key_unavailable',
    });
    expect(await LogoutKVHelpers.getFailure(kv as never, 'rp-b')).toMatchObject({
      error: 'signing_key_unavailable',
    });
    expect(await LogoutKVHelpers.getFailure(kv as never, 'rp-c')).toMatchObject({
      error: 'send_failed',
    });
    expect(auditMock.mock.calls.map(([, entry]) => JSON.parse(entry.metadata))).toEqual([
      expect.objectContaining({
        error_code: 'signing_key_unavailable',
        session_count: 1,
        client_count: 2,
      }),
      expect.objectContaining({ error_code: 'send_failed', session_count: 1, client_count: 1 }),
    ]);
  });
});
