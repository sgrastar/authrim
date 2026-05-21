import { describe, expect, it } from 'vitest';

import { buildHttpSinkAuthHeaders } from '../index';

describe('HTTP sink auth headers', () => {
  it('builds and redacts bearer auth', async () => {
    await expect(
      buildHttpSinkAuthHeaders({
        mode: 'bearer',
        bearerToken: 'token-123',
      })
    ).resolves.toEqual({
      headers: {
        Authorization: 'Bearer token-123',
      },
      redactedHeaders: {
        Authorization: '[redacted]',
      },
    });
  });

  it('builds API key headers with optional prefixes', async () => {
    await expect(
      buildHttpSinkAuthHeaders({
        mode: 'api_key',
        apiKey: {
          headerName: 'X-Api-Key',
          value: 'key-123',
          prefix: 'Token',
        },
      })
    ).resolves.toEqual({
      headers: {
        'X-Api-Key': 'Token key-123',
      },
      redactedHeaders: {
        'X-Api-Key': '[redacted]',
      },
    });
  });

  it('keeps non-secret custom headers visible and redacts secret headers', async () => {
    await expect(
      buildHttpSinkAuthHeaders({
        mode: 'custom_headers',
        customHeaders: [
          { name: 'X-Dataset', value: 'audit' },
          { name: 'X-Collector-Token', value: 'secret', secret: true },
        ],
      })
    ).resolves.toEqual({
      headers: {
        'X-Dataset': 'audit',
        'X-Collector-Token': 'secret',
      },
      redactedHeaders: {
        'X-Dataset': 'audit',
        'X-Collector-Token': '[redacted]',
      },
    });
  });

  it('builds HMAC headers and redacts only the signature', async () => {
    const result = await buildHttpSinkAuthHeaders({
      mode: 'hmac',
      hmac: {
        method: 'POST',
        path: '/sink',
        body: '{}',
        secret: 'hmac-secret',
        deliveryId: 'delivery-1',
        now: new Date('2026-05-19T00:00:00.000Z'),
      },
    });

    expect(result.headers).toMatchObject({
      'X-Authrim-Timestamp': '1779148800',
      'X-Authrim-Delivery': 'delivery-1',
    });
    expect(result.headers['X-Authrim-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(result.redactedHeaders).toMatchObject({
      'X-Authrim-Timestamp': '1779148800',
      'X-Authrim-Delivery': 'delivery-1',
      'X-Authrim-Signature-256': '[redacted]',
    });
  });

  it('rejects invalid header names', async () => {
    await expect(
      buildHttpSinkAuthHeaders({
        mode: 'custom_headers',
        customHeaders: [{ name: 'Bad Header', value: 'value' }],
      })
    ).rejects.toThrow('invalid_http_header_name');
  });
});
