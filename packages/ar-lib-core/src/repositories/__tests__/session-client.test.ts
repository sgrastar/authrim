import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { SessionClientRepository } from '../core/session-client';

describe('SessionClientRepository logout target hydration', () => {
  let repository: SessionClientRepository;
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryMock = vi.fn();
    const adapter = {
      query: queryMock,
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    } as unknown as DatabaseAdapter;
    repository = new SessionClientRepository(adapter, 'tenant-a');
  });

  it('hydrates DO records from oauth_clients without reading a D1 session-client mirror', async () => {
    queryMock.mockResolvedValue([
      {
        client_id: 'client-back',
        client_name: 'Backchannel Client',
        backchannel_logout_uri: 'https://client.example.com/backchannel',
        backchannel_logout_session_required: 1,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: 0,
        logout_webhook_uri: null,
        logout_webhook_secret_encrypted: null,
      },
      {
        client_id: 'client-front',
        client_name: 'Frontchannel Client',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: 0,
        frontchannel_logout_uri: 'https://client.example.com/frontchannel',
        frontchannel_logout_session_required: 1,
        logout_webhook_uri: 'https://client.example.com/webhook',
        logout_webhook_secret_encrypted: 'encrypted-secret',
      },
    ]);

    const result = await repository.hydrateLogoutTargetsFromSessionClients([
      {
        id: 'row-back',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-back',
        first_token_at: 100,
        last_token_at: 200,
        last_seen_at: null,
      },
      {
        id: 'row-front',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-front',
        first_token_at: 101,
        last_token_at: 201,
        last_seen_at: 250,
      },
    ]);

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM oauth_clients'), [
      'tenant-a',
      'client-back',
      'client-front',
    ]);
    expect(queryMock.mock.calls[0][0]).not.toContain('session_clients');
    expect(result.backchannelClients).toHaveLength(1);
    expect(result.frontchannelClients).toHaveLength(1);
    expect(result.webhookClients).toEqual([
      {
        id: 'row-front',
        session_id: 'session-123',
        client_id: 'client-front',
        client_name: 'Frontchannel Client',
        logout_webhook_uri: 'https://client.example.com/webhook',
        logout_webhook_secret_encrypted: 'encrypted-secret',
      },
    ]);
  });

  it('does not hydrate records from another tenant', async () => {
    const result = await repository.hydrateLogoutTargetsFromSessionClients([
      {
        id: 'cross-tenant-row',
        tenant_id: 'tenant-b',
        session_id: 'session-123',
        client_id: 'client-back',
        first_token_at: 100,
        last_token_at: 200,
        last_seen_at: null,
      },
    ]);

    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      backchannelClients: [],
      frontchannelClients: [],
      webhookClients: [],
    });
  });
});
