import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { SessionClientRepository } from '../core/session-client';

describe('SessionClientRepository logout lookups', () => {
  let adapter: DatabaseAdapter;
  let repository: SessionClientRepository;
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryMock = vi.fn();
    adapter = {
      query: queryMock,
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    } as unknown as DatabaseAdapter;
    repository = new SessionClientRepository(adapter, 'tenant-a');
  });

  it('maps backchannel logout rows into typed client records', async () => {
    queryMock.mockResolvedValue([
      {
        id: 'row-1',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-123',
        first_token_at: 100,
        last_token_at: 200,
        last_seen_at: null,
        client_name: 'Backchannel Client',
        backchannel_logout_uri: 'https://client.example.com/backchannel',
        backchannel_logout_session_required: 1,
        frontchannel_logout_uri: 'https://client.example.com/frontchannel',
        frontchannel_logout_session_required: 0,
      },
    ]);

    const result = await repository.findBackchannelLogoutClients('session-123');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('c.backchannel_logout_uri IS NOT NULL'),
      ['tenant-a', 'session-123']
    );
    expect(result).toEqual([
      {
        id: 'row-1',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-123',
        first_token_at: 100,
        last_token_at: 200,
        last_seen_at: null,
        client_name: 'Backchannel Client',
        backchannel_logout_uri: 'https://client.example.com/backchannel',
        backchannel_logout_session_required: true,
        frontchannel_logout_uri: 'https://client.example.com/frontchannel',
        frontchannel_logout_session_required: false,
      },
    ]);
  });

  it('maps frontchannel logout rows into typed client records', async () => {
    queryMock.mockResolvedValue([
      {
        id: 'row-2',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-456',
        first_token_at: 300,
        last_token_at: 400,
        last_seen_at: 450,
        client_name: 'Frontchannel Client',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: 0,
        frontchannel_logout_uri: 'https://client.example.com/logout',
        frontchannel_logout_session_required: 1,
      },
    ]);

    const result = await repository.findFrontchannelLogoutClients('session-123');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('c.frontchannel_logout_uri IS NOT NULL'),
      ['tenant-a', 'session-123']
    );
    expect(result).toEqual([
      {
        id: 'row-2',
        tenant_id: 'tenant-a',
        session_id: 'session-123',
        client_id: 'client-456',
        first_token_at: 300,
        last_token_at: 400,
        last_seen_at: 450,
        client_name: 'Frontchannel Client',
        backchannel_logout_uri: null,
        backchannel_logout_session_required: false,
        frontchannel_logout_uri: 'https://client.example.com/logout',
        frontchannel_logout_session_required: true,
      },
    ]);
  });

  it('returns webhook clients with the exact payload used by webhook dispatch', async () => {
    queryMock.mockResolvedValue([
      {
        id: 'row-3',
        session_id: 'session-123',
        client_id: 'client-789',
        client_name: 'Webhook Client',
        logout_webhook_uri: 'https://client.example.com/hooks/logout',
        logout_webhook_secret_encrypted: 'encrypted-secret',
      },
    ]);

    const result = await repository.findWebhookClients('session-123');

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('c.logout_webhook_uri IS NOT NULL'),
      ['tenant-a', 'session-123']
    );
    expect(result).toEqual([
      {
        id: 'row-3',
        session_id: 'session-123',
        client_id: 'client-789',
        client_name: 'Webhook Client',
        logout_webhook_uri: 'https://client.example.com/hooks/logout',
        logout_webhook_secret_encrypted: 'encrypted-secret',
      },
    ]);
  });
});
