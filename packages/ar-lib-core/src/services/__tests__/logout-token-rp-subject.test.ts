/**
 * The logout token's sub is the sub the client's ID token carried (OIDC Back-Channel Logout 1.0
 * §2.6: the RP matches it against the ID token's sub), recorded with the session-client at
 * issuance: a client whose identity mapping issues a pairwise or persistent sub gets that sub,
 * never the user's internal id.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, generateKeyPair } from 'jose';
import { SessionClientStore } from '../../durable-objects/SessionClientStore';
import type { Env } from '../../types/env';
import type { BackchannelLogoutConfig } from '../../types/logout';
import type { SessionClient } from '../../repositories/core/session-client';
import {
  registerSessionClientInStore,
  resolveLogoutTargetsFromSessionClientStore,
} from '../session-client-store';
import { createBackchannelLogoutOrchestrator, processRetry } from '../backchannel-logout-sender';
import { deriveOidcSid } from '../../utils/session-helper';

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
    stores,
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

/** Hydrates every recorded client as a back-channel target. */
function backchannelRepository(candidateClientIds: string[] = []) {
  return {
    listLogoutCandidateClientIds: vi.fn(async () => candidateClientIds),
    hydrateLogoutTargetsFromSessionClients: vi.fn(async (clients: SessionClient[]) => ({
      backchannelClients: clients.map((client) => ({
        ...client,
        client_name: client.client_id,
        backchannel_logout_uri: `https://${client.client_id}.example.com/backchannel`,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: false,
      })),
      frontchannelClients: [],
      webhookClients: [],
    })),
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

const config: BackchannelLogoutConfig = {
  enabled: true,
  logout_token_exp_seconds: 120,
  include_sub_claim: true,
  include_sid_claim: false,
  request_timeout_ms: 5000,
  retry: { max_attempts: 0, initial_delay_ms: 1000, max_delay_ms: 1000, backoff_multiplier: 2 },
  on_final_failure: 'log_only',
};

describe('logout token sub per relying party', () => {
  const tenantId = 'tenant-a';
  const sessionId = 'g1:apac:0:session_subject';
  const issuer = 'https://op.example.com';
  const userId = 'user-internal-123';
  let privateKey: CryptoKey;
  let env: { SESSION_CLIENT_STORE: ReturnType<typeof createSessionClientNamespace> };
  let sent: Map<string, Record<string, unknown>>;

  beforeAll(async () => {
    ({ privateKey } = await generateKeyPair('RS256'));
  });

  beforeEach(() => {
    env = { SESSION_CLIENT_STORE: createSessionClientNamespace() };
    sent = new Map();
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get('logout_token')!;
      sent.set(new URL(String(input)).hostname.split('.')[0], decodeJwt(token));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
  });

  async function logout(
    sendConfig: BackchannelLogoutConfig = config,
    candidateClientIds: string[] = []
  ) {
    const targets = await resolveLogoutTargetsFromSessionClientStore(
      env as never,
      tenantId,
      sessionId,
      backchannelRepository(candidateClientIds) as never,
      issuer
    );
    const orchestrator = createBackchannelLogoutOrchestrator(createMemoryKV());
    const results = await orchestrator.sendToAll(
      targets!.backchannelClients,
      { issuer, userId, sessionId, privateKey, kid: 'kid-1' },
      sendConfig
    );
    expect(results.every((result) => result.success)).toBe(true);
  }

  it('gives each client the sub its ID token carried, not the internal id', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-a',
      oidc_sub: 'pairwise-sub-for-a',
    });
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-b',
      oidc_sid: 'sid-b',
      oidc_sub: 'pairwise-sub-for-b',
    });

    await logout();

    expect(sent.get('rp-a')).toMatchObject({ aud: 'rp-a', sub: 'pairwise-sub-for-a' });
    expect(sent.get('rp-b')).toMatchObject({ aud: 'rp-b', sub: 'pairwise-sub-for-b' });
    for (const claims of sent.values()) {
      expect(JSON.stringify(claims)).not.toContain(userId);
    }
  });

  it('keeps the recorded sub when the client registers again without an ID token', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-a',
      oidc_sub: 'pairwise-sub-for-a',
    });
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-a',
    });

    await logout();

    expect(sent.get('rp-a')).toMatchObject({ sub: 'pairwise-sub-for-a' });
  });

  it('sends only the sid when no sub was recorded for the client', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-a',
    });

    await logout();

    const claims = sent.get('rp-a')!;
    expect(claims.sid).toBe('sid-a');
    expect(claims).not.toHaveProperty('sub');
  });

  it('keeps the recorded sub through the repair of a record stored without its sid', async () => {
    // A record written before the sid was stored: the logout repairs it with the derived sid.
    await env.SESSION_CLIENT_STORE.get(
      env.SESSION_CLIENT_STORE.idFromName(`${tenantId}:${sessionId}`)
    ).registerClientRpc({
      tenantId,
      sessionId,
      clientId: 'rp-a',
      oidcSub: 'pairwise-sub-for-a',
    });

    await logout({ ...config, include_sid_claim: true });

    expect(sent.get('rp-a')).toMatchObject({
      sub: 'pairwise-sub-for-a',
      sid: await deriveOidcSid(sessionId, 'rp-a', issuer),
    });
  });

  it('keeps the recorded sub of a record found in the earlier code-flow layout', async () => {
    // Code-flow records were once stored in a store named from the derived sid.
    const legacySid = await deriveOidcSid(sessionId, 'rp-a', issuer);
    await env.SESSION_CLIENT_STORE.get(
      env.SESSION_CLIENT_STORE.idFromName(`${tenantId}:${legacySid}`)
    ).registerClientRpc({
      tenantId,
      sessionId: legacySid,
      clientId: 'rp-a',
      oidcSub: 'pairwise-sub-for-a',
    });

    await logout(config, ['rp-a']);

    expect(sent.get('rp-a')).toMatchObject({ sub: 'pairwise-sub-for-a' });
  });

  it("gives a queued retry the client's sub and sid, never the user's or session's own id", async () => {
    const retry = (target: { oidcSub?: string }) =>
      processRetry({
        clientId: 'rp-a',
        sessionId,
        userId,
        ...target,
        oidcSid: 'sid-a',
        issuer,
        attempt: 1,
        privateKey,
        kid: 'kid-1',
        config: { ...config, include_sid_claim: true, retry: { ...config.retry, max_attempts: 3 } },
        kv: createMemoryKV(),
        backchannelLogoutUri: 'https://rp-a.example.com/backchannel',
      });

    await expect(retry({ oidcSub: 'pairwise-sub-for-a' })).resolves.toMatchObject({
      success: true,
    });
    expect(sent.get('rp-a')).toMatchObject({ sub: 'pairwise-sub-for-a', sid: 'sid-a' });
    expect(JSON.stringify(sent.get('rp-a'))).not.toContain(userId);
    expect(JSON.stringify(sent.get('rp-a'))).not.toContain(sessionId);

    await retry({});
    expect(sent.get('rp-a')!.sid).toBe('sid-a');
    expect(sent.get('rp-a')).not.toHaveProperty('sub');
  });

  it('leaves sub out when the tenant turned the sub claim off', async () => {
    await registerSessionClientInStore(env as never, tenantId, {
      session_id: sessionId,
      client_id: 'rp-a',
      oidc_sid: 'sid-a',
      oidc_sub: 'pairwise-sub-for-a',
    });

    await logout({ ...config, include_sub_claim: false, include_sid_claim: true });

    const claims = sent.get('rp-a')!;
    expect(claims.sid).toBe('sid-a');
    expect(claims).not.toHaveProperty('sub');
  });
});
