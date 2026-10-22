import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClientStore } from '../../durable-objects/SessionClientStore';
import type { Env } from '../../types/env';
import { deriveOidcSid } from '../../utils/session-helper';
import {
  purgeEndedSessionsFromSessionClientStore,
  registerSessionClientInStore,
  resolveLegacyLogoutTargetsFromOidcSidStore,
  listSessionClientsFromStore,
  resolveLogoutTargetsFromSessionClientStore,
  resolveSessionIdFromOidcSidStore,
} from '../session-client-store';

class MemoryDurableObjectState implements Partial<DurableObjectState> {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  readonly storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> =>
        Promise.resolve(this.values.get(key) as T | undefined),
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        if (typeof keyOrEntries === 'string') {
          this.values.set(keyOrEntries, value);
        } else {
          for (const [key, entry] of Object.entries(keyOrEntries)) this.values.set(key, entry);
        }
        return Promise.resolve();
      },
      delete: (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (typeof keyOrKeys === 'string') return Promise.resolve(this.values.delete(keyOrKeys));
        let deleted = 0;
        for (const key of keyOrKeys) if (this.values.delete(key)) deleted++;
        return Promise.resolve(deleted);
      },
      deleteAll: (): Promise<void> => {
        this.values.clear();
        return Promise.resolve();
      },
      list: <T>(options?: DurableObjectListOptions): Promise<Map<string, T>> => {
        const prefix = options?.prefix ?? '';
        return Promise.resolve(
          new Map(
            [...this.values.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][]
          )
        );
      },
      setAlarm: (scheduledTime: number): Promise<void> => {
        this.alarmAt = scheduledTime;
        return Promise.resolve();
      },
      deleteAlarm: (): Promise<void> => {
        this.alarmAt = null;
        return Promise.resolve();
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

function durableObjectId(name: string): DurableObjectId {
  return {
    name,
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
  } as DurableObjectId;
}

function createSessionClientNamespace() {
  const stores = new Map<string, SessionClientStore>();
  const states = new Map<string, MemoryDurableObjectState>();
  const getStore = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      const state = new MemoryDurableObjectState();
      store = new SessionClientStore(state as unknown as DurableObjectState, {} as Env);
      stores.set(name, store);
      states.set(name, state);
    }
    return store;
  };
  const getState = (name: string) => {
    getStore(name);
    return states.get(name)!;
  };

  return {
    idFromName: vi.fn((name: string) => durableObjectId(name)),
    get: vi.fn((id: DurableObjectId) => getStore(id.toString())),
    getStore,
    getState,
  };
}

function repository(clientIds: string[]) {
  return {
    listLogoutCandidateClientIds: vi.fn(async () => clientIds),
    hydrateLogoutTargetsFromSessionClients: vi.fn(async (clients) => ({
      backchannelClients: [],
      frontchannelClients: clients.map((client: Record<string, unknown>) => ({
        ...client,
        client_name: 'Legacy RP',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://rp.example.com/logout',
        frontchannel_logout_session_required: true,
      })),
      webhookClients: [],
    })),
  };
}

describe('SessionClientStore legacy SID migration', () => {
  const tenantId = 'tenant-a';
  const issuer = 'https://op.example.com';
  const rawSessionId = 'g1:apac:0:session_legacy123';
  const clientId = 'legacy-rp';
  let namespace: ReturnType<typeof createSessionClientNamespace>;
  let env: { SESSION_CLIENT_STORE: ReturnType<typeof createSessionClientNamespace> };

  beforeEach(() => {
    namespace = createSessionClientNamespace();
    env = { SESSION_CLIENT_STORE: namespace };
  });

  it('read-repairs a legacy hybrid record without exposing the raw session ID', async () => {
    await namespace.getStore(`${tenantId}:${rawSessionId}`).registerClientRpc({
      tenantId,
      sessionId: rawSessionId,
      clientId,
      now: 100,
    });
    const repo = repository([clientId]);
    const expectedSid = await deriveOidcSid(rawSessionId, clientId, issuer);

    const targets = await resolveLogoutTargetsFromSessionClientStore(
      env as never,
      tenantId,
      rawSessionId,
      repo as never,
      issuer
    );

    expect(targets?.frontchannelClients).toEqual([
      expect.objectContaining({
        client_id: clientId,
        session_id: rawSessionId,
        oidc_sid: expectedSid,
      }),
    ]);
    await expect(
      resolveSessionIdFromOidcSidStore(env as never, tenantId, expectedSid)
    ).resolves.toBe(rawSessionId);
  });

  it('discovers and migrates the predeployment code-flow DO layout', async () => {
    const oidcSid = await deriveOidcSid(rawSessionId, clientId, issuer);
    await namespace.getStore(`${tenantId}:${oidcSid}`).registerClientRpc({
      tenantId,
      sessionId: oidcSid,
      clientId,
      now: 100,
    });
    const repo = repository([clientId]);

    const targets = await resolveLogoutTargetsFromSessionClientStore(
      env as never,
      tenantId,
      rawSessionId,
      repo as never,
      issuer
    );

    expect(targets?.frontchannelClients).toEqual([
      expect.objectContaining({
        client_id: clientId,
        session_id: rawSessionId,
        oidc_sid: oidcSid,
      }),
    ]);
    await expect(resolveSessionIdFromOidcSidStore(env as never, tenantId, oidcSid)).resolves.toBe(
      rawSessionId
    );
    await expect(
      namespace
        .getStore(`${tenantId}:${rawSessionId}`)
        .listClientsRpc({ tenantId, sessionId: rawSessionId })
    ).resolves.toEqual([
      expect.objectContaining({ client_id: clientId, session_id: rawSessionId, oidc_sid: oidcSid }),
    ]);
  });

  it('recovers the RP notification target from a validated legacy sid hint', async () => {
    const oidcSid = await deriveOidcSid(rawSessionId, clientId, issuer);
    await namespace.getStore(`${tenantId}:${oidcSid}`).registerClientRpc({
      tenantId,
      sessionId: oidcSid,
      clientId,
      now: 100,
    });

    const targets = await resolveLegacyLogoutTargetsFromOidcSidStore(
      env as never,
      tenantId,
      oidcSid,
      clientId,
      repository([clientId]) as never
    );

    expect(targets?.frontchannelClients).toEqual([
      expect.objectContaining({ client_id: clientId, oidc_sid: oidcSid }),
    ]);
    expect(JSON.stringify(targets)).not.toContain(rawSessionId);
  });
});

describe('purgeEndedSessionsFromSessionClientStore', () => {
  const tenantId = 'tenant-a';
  const sessionId = 'g1:apac:0:session_ended123';
  let namespace: ReturnType<typeof createSessionClientNamespace>;
  let env: { SESSION_CLIENT_STORE: ReturnType<typeof createSessionClientNamespace> };

  beforeEach(() => {
    namespace = createSessionClientNamespace();
    env = { SESSION_CLIENT_STORE: namespace };
  });

  async function register(session: string, clientId: string, oidcSid: string) {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: session,
      client_id: clientId,
      oidc_sid: oidcSid,
    });
  }

  it("removes the session's records and the aliases pointing at it", async () => {
    await register(sessionId, 'rp-a', 'sid-a');
    await register(sessionId, 'rp-b', 'sid-b');

    await purgeEndedSessionsFromSessionClientStore(env as never, tenantId, [sessionId]);

    expect(namespace.getState(`${tenantId}:${sessionId}`).values.size).toBe(0);
    expect(namespace.getState(`${tenantId}:oidc-sid:sid-a`).values.size).toBe(0);
    expect(namespace.getState(`${tenantId}:oidc-sid:sid-b`).values.size).toBe(0);
    await expect(listSessionClientsFromStore(env as never, tenantId, sessionId)).resolves.toEqual(
      []
    );
    await expect(resolveSessionIdFromOidcSidStore(env as never, tenantId, 'sid-a')).resolves.toBe(
      null
    );
  });

  it('leaves other sessions alone', async () => {
    const otherSessionId = 'g1:apac:0:session_other456';
    await register(sessionId, 'rp-a', 'sid-a');
    await register(otherSessionId, 'rp-a', 'sid-other');

    await purgeEndedSessionsFromSessionClientStore(env as never, tenantId, [sessionId]);

    await expect(
      listSessionClientsFromStore(env as never, tenantId, otherSessionId)
    ).resolves.toEqual([expect.objectContaining({ client_id: 'rp-a', oidc_sid: 'sid-other' })]);
    await expect(
      resolveSessionIdFromOidcSidStore(env as never, tenantId, 'sid-other')
    ).resolves.toBe(otherSessionId);
  });

  it('goes on with the other sessions when one removal fails, and never throws', async () => {
    const otherSessionId = 'g1:apac:0:session_other456';
    await register(sessionId, 'rp-a', 'sid-a');
    await register(otherSessionId, 'rp-b', 'sid-b');
    vi.spyOn(namespace.getStore(`${tenantId}:${sessionId}`), 'deleteSessionRpc').mockRejectedValue(
      new Error('storage unavailable')
    );

    await expect(
      purgeEndedSessionsFromSessionClientStore(env as never, tenantId, [sessionId, otherSessionId])
    ).resolves.toBeUndefined();

    expect(namespace.getState(`${tenantId}:${otherSessionId}`).values.size).toBe(0);
    // The failed one keeps its records and expiry: the alarm removes them later.
    expect(namespace.getState(`${tenantId}:${sessionId}`).alarmAt).not.toBeNull();
  });

  it('does nothing without the binding', async () => {
    await expect(
      purgeEndedSessionsFromSessionClientStore({} as never, tenantId, [sessionId])
    ).resolves.toBeUndefined();
  });
});
