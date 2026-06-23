import { describe, expect, it, vi } from 'vitest';
import { DirectoryPasswordRelayClient } from '../directory-relay-client';

function createRelayNamespace(response: Response) {
  const fetch = vi.fn(async () => response);
  return {
    idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
    get: vi.fn(() => ({ fetch }) as unknown as DurableObjectStub),
    _fetch: fetch,
  } as unknown as DurableObjectNamespace & { _fetch: ReturnType<typeof vi.fn> };
}

describe('DirectoryPasswordRelayClient', () => {
  it('sends verify-password requests through the relay Durable Object', async () => {
    const relay = createRelayNamespace(
      Response.json({
        request_id: 'req_123',
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordRelayClient({
      relay,
      tenantId: 'tenant-a',
      connectorId: 'ww_tenant_a',
      timeoutMs: 1000,
    });

    const result = await client.verifyPassword({
      username: 'alice',
      password: 'password',
      requestId: 'req_123',
      attributeNames: ['mail'],
    });

    expect(result.result).toBe('success');
    expect(relay.idFromName).toHaveBeenCalledWith('tenant-a:ww_tenant_a');
    expect(relay._fetch).toHaveBeenCalledWith(
      'https://directory-relay.internal/verify-password',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"password":"password"'),
      })
    );
  });

  it('rejects mismatched relay responses', async () => {
    const relay = createRelayNamespace(
      Response.json({
        request_id: 'req_123',
        tenant_id: 'tenant-b',
        connector_id: 'ww_tenant_a',
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordRelayClient({
      relay,
      tenantId: 'tenant-a',
      connectorId: 'ww_tenant_a',
      timeoutMs: 1000,
    });

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
      })
    ).rejects.toMatchObject({
      details: {
        code: 'connector_response_mismatch',
        retryable: false,
      },
    });
  });
});
