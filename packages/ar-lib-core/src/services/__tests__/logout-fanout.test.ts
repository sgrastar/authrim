import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGOUT_WEBHOOK_CONFIG } from '../../types/logout';
import {
  sendBackchannelLogoutFanout,
  sendLogoutWebhookFanout,
  type LogoutIncomplete,
} from '../logout-fanout';
import { DEFAULT_LOGOUT_CONFIG } from '../../types/logout';

describe('logout fan-out summary', () => {
  it('counts a session whose sending broke off, apart from failed sends', async () => {
    // The pending-lock read throws for one session: its client gets no result at all.
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key.includes('session-broken')) throw new Error('kv unavailable');
        return null;
      }),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const webhookClient = (sessionId: string) => ({
      id: `sc-${sessionId}`,
      session_id: sessionId,
      client_id: `client-${sessionId}`,
      client_name: null,
      logout_webhook_uri: 'https://rp.example.com/logout-webhook',
      logout_webhook_secret_encrypted: 'encrypted-secret',
    });

    const summary = await sendLogoutWebhookFanout(
      { SETTINGS: kv, RP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) } as never,
      {
        issuer: 'https://op.example.com',
        config: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG, enabled: true },
        sessions: ['session-ok', 'session-broken'].map((sessionId) => ({
          sessionId,
          userId: 'user-1',
          backchannelClients: [],
          webhookClients: [webhookClient(sessionId)],
        })),
      }
    );

    // The other session's client is told; the broken one is neither told nor a failed send.
    expect(summary).toEqual({ succeeded: 1, failed: 0, sessionErrors: 1 });
  });
});

describe('logout fan-out that broke off before sending', () => {
  const backchannelClient = { client_id: 'rp-a' } as never;
  const webhookClient = {
    id: 'sc-1',
    session_id: 's',
    client_id: 'rp-c',
    client_name: null,
    logout_webhook_uri: 'https://rp.example.com/logout-webhook',
    logout_webhook_secret_encrypted: 'secret',
  };
  const sessions = (kind: 'backchannel' | 'webhook') => [
    {
      sessionId: 'session-with-clients',
      userId: 'user-1',
      backchannelClients: kind === 'backchannel' ? [backchannelClient] : [],
      webhookClients: kind === 'webhook' ? [webhookClient] : [],
    },
    { sessionId: 'session-without', userId: 'user-1', backchannelClients: [], webhookClients: [] },
  ];

  it('names the sessions with back-channel clients when there is no signing key', async () => {
    const reported: LogoutIncomplete[] = [];
    const keyManager = { getAllPublicKeysRpc: vi.fn(async () => []) };
    const summary = await sendBackchannelLogoutFanout(
      {
        KEY_MANAGER: { idFromName: () => 'id', get: () => keyManager },
        SETTINGS: {},
      } as never,
      {
        tenantId: 'tenant-a',
        issuer: 'https://op.example.com',
        sessions: sessions('backchannel'),
        config: { ...DEFAULT_LOGOUT_CONFIG.backchannel, enabled: true },
        onIncomplete: (incomplete) => reported.push(incomplete),
      }
    );
    expect(summary).toBeNull();
    expect(reported).toEqual([
      {
        kind: 'backchannel',
        sessionIds: ['session-with-clients'],
        reason: 'signing_key_unavailable',
      },
    ]);
  });

  it('names nothing when the notice is disabled or there is nobody to tell', async () => {
    const reported: LogoutIncomplete[] = [];
    await sendBackchannelLogoutFanout({} as never, {
      tenantId: 'tenant-a',
      issuer: 'https://op.example.com',
      sessions: sessions('backchannel'),
      config: { ...DEFAULT_LOGOUT_CONFIG.backchannel, enabled: false },
      onIncomplete: (incomplete) => reported.push(incomplete),
    });
    await sendLogoutWebhookFanout({} as never, {
      issuer: 'https://op.example.com',
      sessions: sessions('backchannel'),
      config: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG, enabled: true },
      onIncomplete: (incomplete) => reported.push(incomplete),
    });
    expect(reported).toEqual([]);
  });

  it('names the sessions with webhook clients when there is no key to decrypt the secrets', async () => {
    const reported: LogoutIncomplete[] = [];
    const summary = await sendLogoutWebhookFanout({ SETTINGS: {} } as never, {
      issuer: 'https://op.example.com',
      sessions: sessions('webhook'),
      config: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG, enabled: true },
      onIncomplete: (incomplete) => reported.push(incomplete),
    });
    expect(summary).toBeNull();
    expect(reported).toEqual([
      {
        kind: 'webhook',
        sessionIds: ['session-with-clients'],
        reason: 'webhook_key_unavailable',
      },
    ]);
  });

  it('names the session whose sending broke off, and only that one', async () => {
    const reported: LogoutIncomplete[] = [];
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key.includes('session-broken')) throw new Error('kv unavailable');
        return null;
      }),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const session = (sessionId: string) => ({
      sessionId,
      userId: 'user-1',
      backchannelClients: [],
      webhookClients: [{ ...webhookClient, session_id: sessionId, client_id: `c-${sessionId}` }],
    });
    await sendLogoutWebhookFanout(
      { SETTINGS: kv, RP_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) } as never,
      {
        issuer: 'https://op.example.com',
        sessions: [session('session-ok'), session('session-broken')],
        config: { ...DEFAULT_LOGOUT_WEBHOOK_CONFIG, enabled: true },
        onIncomplete: (incomplete) => reported.push(incomplete),
      }
    );
    expect(reported).toEqual([
      { kind: 'webhook', sessionIds: ['session-broken'], reason: 'send_failed' },
    ]);
  });
});
