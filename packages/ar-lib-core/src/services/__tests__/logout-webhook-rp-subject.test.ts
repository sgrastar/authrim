/**
 * The logout webhook's sub is the sub the client's ID token carried, as the logout token's is
 * (recorded with the session-client at issuance), never the user's internal id. A client without a
 * recorded sub gets no sub, and a notice then names the session by its sid.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClientStore } from '../../durable-objects/SessionClientStore';
import type { Env } from '../../types/env';
import { DEFAULT_LOGOUT_WEBHOOK_CONFIG, type LogoutWebhookConfig } from '../../types/logout';
import { SessionClientRepository } from '../../repositories/core/session-client';
import {
  registerSessionClientInStore,
  resolveLogoutTargetsFromSessionClientStore,
} from '../session-client-store';
import { sendLogoutWebhookFanout } from '../logout-fanout';

class MemoryDurableObjectState implements Partial<DurableObjectState> {
  private readonly values = new Map<string, unknown>();
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
      list: <T>(options?: DurableObjectListOptions): Promise<Map<string, T>> => {
        const prefix = options?.prefix ?? '';
        return Promise.resolve(
          new Map(
            [...this.values.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][]
          )
        );
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
        closure(this.storage),
      // The store's expiry: registrations set an alarm.
      setAlarm: (): Promise<void> => Promise.resolve(),
      deleteAlarm: (): Promise<void> => Promise.resolve(),
      deleteAll: (): Promise<void> => {
        this.values.clear();
        return Promise.resolve();
      },
    } as unknown as DurableObjectStorage;
  }
}

function createSessionClientNamespace() {
  const stores = new Map<string, SessionClientStore>();
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = id.toString();
      let store = stores.get(name);
      if (!store) {
        store = new SessionClientStore(
          new MemoryDurableObjectState() as unknown as DurableObjectState,
          {} as Env
        );
        stores.set(name, store);
      }
      return store;
    },
  };
}

function createMemoryKV(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
    delete: vi.fn(async (key: string) => void values.delete(key)),
  } as unknown as KVNamespace;
}

/** The webhook registration of every client (oauth_clients), as the repository reads it. */
function repositoryWithWebhooks(clientIds: string[]) {
  const adapter = {
    query: vi.fn(async (sql: string) =>
      sql.includes('FROM oauth_clients') && sql.includes('client_name')
        ? clientIds.map((clientId) => ({
            client_id: clientId,
            client_name: clientId,
            backchannel_logout_uri: null,
            backchannel_logout_session_required: 0,
            frontchannel_logout_uri: null,
            frontchannel_logout_session_required: 0,
            logout_webhook_uri: `https://${clientId}.example.com/logout-webhook`,
            logout_webhook_secret_encrypted: 'webhook-secret',
          }))
        : clientIds.map((client_id) => ({ client_id }))
    ),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  return new SessionClientRepository(adapter as never, 'tenant-a');
}

describe('logout webhook sub per relying party', () => {
  const tenantId = 'tenant-a';
  const sessionId = 'g1:apac:0:session_webhook';
  const issuer = 'https://op.example.com';
  const userId = 'user-internal-123';
  let env: { SESSION_CLIENT_STORE: ReturnType<typeof createSessionClientNamespace> };
  let sent: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    env = { SESSION_CLIENT_STORE: createSessionClientNamespace() };
    sent = new Map();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.set(
        new URL(String(input)).hostname.split('.')[0],
        JSON.parse(String(init?.body)) as Record<string, unknown>
      );
      return new Response(null, { status: 200 });
    }) as typeof fetch;
  });

  async function logout(config: Partial<LogoutWebhookConfig> = {}, clientIds = ['rp-a', 'rp-b']) {
    const targets = await resolveLogoutTargetsFromSessionClientStore(
      env as never,
      tenantId,
      sessionId,
      repositoryWithWebhooks(clientIds),
      issuer
    );
    const summary = await sendLogoutWebhookFanout(
      { SETTINGS: createMemoryKV(), RP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) } as never,
      {
        issuer,
        config: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG, enabled: true, ...config },
        sessions: [
          {
            sessionId,
            userId,
            backchannelClients: [],
            webhookClients: targets!.webhookClients,
          },
        ],
      }
    );
    expect(summary).toMatchObject({ failed: 0, sessionErrors: 0 });
  }

  it('gives each client the sub its ID token carried, not the internal id', async () => {
    for (const [clientId, sub] of [
      ['rp-a', 'pairwise-sub-for-a'],
      ['rp-b', 'pairwise-sub-for-b'],
    ]) {
      await registerSessionClientInStore(env as never, tenantId, {
        session_id: sessionId,
        client_id: clientId,
        oidc_sid: `sid-${clientId}`,
        oidc_sub: sub,
      });
    }

    await logout();

    expect(sent.get('rp-a')).toMatchObject({
      client_id: 'rp-a',
      sub: 'pairwise-sub-for-a',
      sid: 'sid-rp-a',
      issuer,
    });
    expect(sent.get('rp-b')).toMatchObject({ sub: 'pairwise-sub-for-b', sid: 'sid-rp-b' });
    expect(sent.size).toBe(2);
    for (const payload of sent.values()) {
      expect(JSON.stringify(payload)).not.toContain(userId);
    }
  });

  it('sends no sub for a client with no recorded sub, only its sid', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-rp-a',
    });

    await logout({}, ['rp-a']);

    const payload = sent.get('rp-a')!;
    expect(payload).not.toHaveProperty('sub');
    expect(payload.sid).toBe('sid-rp-a');
    expect(JSON.stringify(payload)).not.toContain(userId);
  });

  it('names the session by its sid even when the tenant turned the sid claim off, if there is no sub', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-rp-a',
    });

    await logout({ include_sid_claim: false }, ['rp-a']);

    expect(sent.get('rp-a')).toMatchObject({ sid: 'sid-rp-a' });
    expect(sent.get('rp-a')).not.toHaveProperty('sub');
  });

  it('leaves sub out when the tenant turned the sub claim off', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-rp-a',
      oidc_sub: 'pairwise-sub-for-a',
    });

    await logout({ include_sub_claim: false }, ['rp-a']);

    expect(sent.get('rp-a')).toMatchObject({ sid: 'sid-rp-a' });
    expect(sent.get('rp-a')).not.toHaveProperty('sub');
  });

  it('leaves sid out when the tenant turned it off and the client has a sub', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-rp-a',
      oidc_sub: 'pairwise-sub-for-a',
    });

    await logout({ include_sid_claim: false }, ['rp-a']);

    expect(sent.get('rp-a')).toMatchObject({ sub: 'pairwise-sub-for-a' });
    expect(sent.get('rp-a')).not.toHaveProperty('sid');
  });
});
