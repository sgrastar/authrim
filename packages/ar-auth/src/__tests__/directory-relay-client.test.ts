import { describe, expect, it, vi } from 'vitest';
import { DirectoryPasswordRelayClient } from '../directory-relay-client';

function createRelayNamespace(response: Response | Response[]) {
  const responses = Array.isArray(response) ? [...response] : [response];
  const fallback = responses[responses.length - 1];
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    return next ?? fallback;
  });
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
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      timeoutMs: 1000,
    });

    const result = await client.verifyPassword({
      username: 'alice',
      password: 'password',
      requestId: 'req_123',
      attributeNames: ['mail'],
    });

    expect(result.result).toBe('success');
    expect(relay.idFromName).toHaveBeenCalledWith('tenant-a:wwcon_8K4M2Q9F7D3H6P1X');
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
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordRelayClient({
      relay,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
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

  it('retries one retryable relay error when a connector can still be authenticated', async () => {
    const relay = createRelayNamespace([
      Response.json(
        {
          error: {
            code: 'relay_connection_closed',
            retryable: true,
          },
        },
        { status: 503 }
      ),
      Response.json({
        request_id: 'req_123',
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      }),
    ]);
    const client = new DirectoryPasswordRelayClient({
      relay,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      timeoutMs: 1000,
    });

    const result = await client.verifyPassword({
      username: 'alice',
      password: 'password',
      requestId: 'req_123',
    });

    expect(result.result).toBe('failure');
    expect(relay._fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry relay overload responses', async () => {
    const relay = createRelayNamespace(
      Response.json(
        {
          error: {
            code: 'relay_overloaded',
            retryable: true,
          },
        },
        { status: 429 }
      )
    );
    const client = new DirectoryPasswordRelayClient({
      relay,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
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
        code: 'relay_overloaded',
      },
    });
    expect(relay._fetch).toHaveBeenCalledTimes(1);
  });
});
