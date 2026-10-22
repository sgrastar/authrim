import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGOUT_WEBHOOK_CONFIG } from '../../types/logout';
import { sendLogoutWebhookFanout } from '../logout-fanout';

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
