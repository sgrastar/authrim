import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryPasswordClient,
  buildDirectoryPasswordCanonicalRequest,
  signDirectoryPasswordCanonicalRequest,
} from '../directory-password';

const config = {
  endpoint: 'https://wordwarden.example.com',
  tenantId: 'tenant-a',
  connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
  keyId: 'kid-active',
  secret: 'active-secret',
  timeoutMs: 1000,
};

describe('DirectoryPasswordClient', () => {
  it('signs and sends verify-password requests', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      const body = init?.body as string;
      const canonical = await buildDirectoryPasswordCanonicalRequest({
        method: 'POST',
        url: new URL('https://wordwarden.example.com/v1/auth/verify-password'),
        body,
        headers,
        signedHeaders: headers.get('X-Authrim-Signed-Headers')!.split(';'),
        timestamp: headers.get('X-Authrim-Timestamp')!,
        nonce: headers.get('X-Authrim-Nonce')!,
      });
      const expectedSignature = await signDirectoryPasswordCanonicalRequest(
        canonical,
        config.secret
      );

      expect(headers.get('X-Authrim-Connector-Id')).toBe(config.connectorId);
      expect(headers.get('X-Authrim-Key-Id')).toBe(config.keyId);
      expect(headers.get('X-Authrim-Request-Id')).toBe('req_123');
      expect(headers.get('X-Authrim-Signature')).toBe(expectedSignature);
      expect(JSON.parse(body)).toEqual({
        request_id: 'req_123',
        tenant_id: config.tenantId,
        connector_id: config.connectorId,
        username: 'alice',
        password: 'password',
        attribute_names: ['uid', 'mail'],
      });

      return Response.json({
        request_id: 'req_123',
        tenant_id: config.tenantId,
        connector_id: config.connectorId,
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        attributes: {
          mail: ['alice@example.com'],
        },
        directory_status: 'ok',
      });
    });

    const client = new DirectoryPasswordClient(config, fetcher);
    const result = await client.verifyPassword({
      username: 'alice',
      password: 'password',
      attributeNames: ['uid', 'mail'],
      requestId: 'req_123',
      nonce: 'nonce_123',
      timestamp: new Date('2026-06-04T12:00:00Z'),
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://wordwarden.example.com/v1/auth/verify-password',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.result).toBe('success');
    if (result.result === 'success') {
      expect(result.subject.username).toBe('alice');
      expect(result.attributes?.mail).toEqual(['alice@example.com']);
    }
  });

  it('returns invalid credential verdicts as normal results', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        request_id: 'req_123',
        tenant_id: config.tenantId,
        connector_id: config.connectorId,
        result: 'failure',
        reason: 'invalid_credentials',
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    const result = await client.verifyPassword({
      username: 'alice',
      password: 'wrong',
      requestId: 'req_123',
      nonce: 'nonce_123',
      timestamp: new Date('2026-06-04T12:00:00Z'),
    });

    expect(result).toEqual({
      request_id: 'req_123',
      tenant_id: config.tenantId,
      connector_id: config.connectorId,
      result: 'failure',
      reason: 'invalid_credentials',
      directory_status: 'ok',
    });
  });

  it('returns policy-required verdicts as non-success results', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        request_id: 'req_123',
        tenant_id: config.tenantId,
        connector_id: config.connectorId,
        result: 'policy_required',
        reason: 'must_change_password',
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    const result = await client.verifyPassword({
      username: 'alice',
      password: 'password',
      requestId: 'req_123',
      nonce: 'nonce_123',
      timestamp: new Date('2026-06-04T12:00:00Z'),
    });

    expect(result).toEqual({
      request_id: 'req_123',
      tenant_id: config.tenantId,
      connector_id: config.connectorId,
      result: 'policy_required',
      reason: 'must_change_password',
      directory_status: 'ok',
    });
  });

  it('rejects mismatched tenant, connector, or request identifiers from successful responses', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        request_id: 'req_123',
        tenant_id: 'tenant-b',
        connector_id: config.connectorId,
        result: 'success',
        subject: {
          directory_id: 'uid=alice,ou=People,dc=example,dc=com',
          username: 'alice',
        },
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
        nonce: 'nonce_123',
        timestamp: new Date('2026-06-04T12:00:00Z'),
      })
    ).rejects.toMatchObject({
      details: {
        requestId: 'req_123',
        tenantId: config.tenantId,
        connectorId: config.connectorId,
        code: 'connector_response_mismatch',
        retryable: false,
        status: 502,
      },
    });
  });

  it('rejects unknown connector result values', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        request_id: 'req_123',
        tenant_id: config.tenantId,
        connector_id: config.connectorId,
        result: 'unexpected_success',
        directory_status: 'ok',
      })
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
        nonce: 'nonce_123',
        timestamp: new Date('2026-06-04T12:00:00Z'),
      })
    ).rejects.toMatchObject({
      details: {
        code: 'unexpected_connector_result',
        retryable: false,
      },
    });
  });

  it('maps retryable connector errors', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          request_id: 'req_123',
          tenant_id: config.tenantId,
          connector_id: config.connectorId,
          error: {
            code: 'directory_unavailable',
            retryable: true,
          },
        },
        { status: 503 }
      )
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
        nonce: 'nonce_123',
        timestamp: new Date('2026-06-04T12:00:00Z'),
      })
    ).rejects.toMatchObject({
      details: {
        requestId: 'req_123',
        tenantId: config.tenantId,
        connectorId: config.connectorId,
        code: 'directory_unavailable',
        retryable: true,
        status: 503,
      },
    });
  });

  it('rejects mismatched identifiers from connector error responses', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          request_id: 'req_123',
          tenant_id: 'tenant-b',
          connector_id: config.connectorId,
          error: {
            code: 'directory_unavailable',
            retryable: true,
          },
        },
        { status: 503 }
      )
    );
    const client = new DirectoryPasswordClient(config, fetcher);

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
        nonce: 'nonce_123',
        timestamp: new Date('2026-06-04T12:00:00Z'),
      })
    ).rejects.toMatchObject({
      details: {
        requestId: 'req_123',
        tenantId: config.tenantId,
        connectorId: config.connectorId,
        code: 'connector_error_response_mismatch',
        retryable: false,
        status: 503,
      },
    });
  });

  it('rejects non-HTTPS non-loopback connector endpoints before sending credentials', async () => {
    const fetcher = vi.fn();
    const client = new DirectoryPasswordClient(
      {
        ...config,
        endpoint: 'http://wordwarden.example.com',
      },
      fetcher
    );

    await expect(
      client.verifyPassword({
        username: 'alice',
        password: 'password',
        requestId: 'req_123',
        nonce: 'nonce_123',
        timestamp: new Date('2026-06-04T12:00:00Z'),
      })
    ).rejects.toMatchObject({
      details: {
        code: 'invalid_connector_endpoint',
        retryable: false,
        status: 0,
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('canonicalizes query parameters deterministically', async () => {
    const canonical = await buildDirectoryPasswordCanonicalRequest({
      method: 'POST',
      url: new URL('https://wordwarden.example.com/v1/auth/verify-password?b=2&a=2&a=1'),
      body: '{}',
      headers: new Headers({
        'Content-Type': 'application/json',
        'X-Authrim-Key-Id': 'kid-active',
      }),
      signedHeaders: ['x-authrim-key-id', 'content-type', 'content-type'],
      timestamp: '2026-06-04T12:00:00.000Z',
      nonce: 'nonce_123',
    });

    expect(canonical).toContain('\na=1&a=2&b=2\n');
    expect(canonical).toContain('\ncontent-type:application/json\nx-authrim-key-id:kid-active\n');
    expect(canonical).toContain('\ncontent-type;x-authrim-key-id\n');
  });
});
