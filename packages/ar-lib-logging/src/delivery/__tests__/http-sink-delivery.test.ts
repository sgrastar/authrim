import { describe, expect, it, vi } from 'vitest';

import { deliverHttpSinkBatch } from '../index';

describe('HTTP sink delivery service', () => {
  it('delivers successful HTTPS batches with auth headers', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 202 }));

    const result = await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/logs?stream=audit',
      body: '{"records":[]}',
      deliveryId: 'delivery-1',
      auth: {
        mode: 'bearer',
        bearerToken: 'token-123',
      },
      fetcher,
    });

    expect(result).toEqual({
      status: 'delivered',
      httpStatus: 202,
      redactedHeaders: {
        Authorization: '[redacted]',
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://collector.example/logs?stream=audit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-123',
        }),
        body: '{"records":[]}',
        redirect: 'manual',
      })
    );
  });

  it('rejects non-HTTPS URLs unless explicitly allowed', async () => {
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'http://collector.example/logs',
        body: '{}',
        fetcher: vi.fn(),
      })
    ).rejects.toThrow('http_sink_url_must_use_https');
  });

  it('blocks localhost and private address HTTP sink targets by default', async () => {
    for (const endpointUrl of [
      'https://localhost/logs',
      'https://127.0.0.1/logs',
      'https://10.0.0.10/logs',
      'https://172.16.0.1/logs',
      'https://192.168.1.1/logs',
      'https://100.64.0.1/logs',
      'https://192.0.2.1/logs',
      'https://198.51.100.1/logs',
      'https://203.0.113.1/logs',
      'https://168.63.129.16/logs',
      'https://[::1]/logs',
      'https://[::ffff:127.0.0.1]/logs',
      'https://metadata.google.internal/logs',
      'https://service.internal/logs',
      'https://service.local/logs',
      'https://localhost.localdomain/logs',
    ]) {
      await expect(
        deliverHttpSinkBatch({
          endpointUrl,
          body: '{}',
          fetcher: vi.fn(),
        })
      ).rejects.toThrow('http_sink_url_private_network_blocked');
    }
  });

  it('allows private targets only when explicitly enabled by the caller', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));

    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://127.0.0.1/logs',
        body: '{}',
        allowPrivateNetwork: true,
        fetcher,
      })
    ).resolves.toMatchObject({ status: 'delivered', httpStatus: 200 });
  });

  it('marks 429 and 5xx as retrying and honors Retry-After', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('', {
          status: 429,
          headers: {
            'Retry-After': '15',
          },
        })
    );

    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/logs',
        body: '{}',
        attempt: 3,
        fetcher,
      })
    ).resolves.toMatchObject({
      status: 'retrying',
      httpStatus: 429,
      retryDelayMs: 15_000,
    });
  });

  it('marks 3xx and 4xx failures as permanent by default', async () => {
    const redirectFetcher = vi.fn(async () => new Response('', { status: 302 }));
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/logs',
        body: '{}',
        fetcher: redirectFetcher,
      })
    ).resolves.toMatchObject({
      status: 'failed',
      httpStatus: 302,
    });
    expect(redirectFetcher).toHaveBeenCalledWith(
      'https://collector.example/logs',
      expect.objectContaining({ redirect: 'manual' })
    );

    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/logs',
        body: '{}',
        fetcher: vi.fn(async () => new Response('', { status: 401 })),
      })
    ).resolves.toMatchObject({
      status: 'failed',
      httpStatus: 401,
    });
  });

  it('builds HMAC signatures from the final request method, path, query, and body', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));

    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/logs?stream=audit',
      method: 'PUT',
      body: '{}',
      deliveryId: 'delivery-1',
      auth: {
        mode: 'hmac',
        hmac: {
          method: 'POST',
          path: '/ignored',
          body: 'ignored',
          secret: 'hmac-secret',
          now: new Date('2026-05-19T00:00:00.000Z'),
        },
      },
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://collector.example/logs?stream=audit',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'X-Authrim-Timestamp': '1779148800',
          'X-Authrim-Delivery': 'delivery-1',
          'X-Authrim-Signature-Version': 'v1',
          'X-Authrim-Signature-256': expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
        }),
      })
    );
  });
});
