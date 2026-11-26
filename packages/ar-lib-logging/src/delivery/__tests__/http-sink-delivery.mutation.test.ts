import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverHttpSinkBatch } from '../http-sink-delivery';

const ok = () =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));

async function reaches(endpointUrl: string): Promise<boolean> {
  const fetcher = ok();
  try {
    await deliverHttpSinkBatch({ endpointUrl, body: '{}', fetcher });
  } catch (error) {
    expect((error as Error).message).toBe('http_sink_url_private_network_blocked');
    expect(fetcher).not.toHaveBeenCalled();
    return false;
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
  return true;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('the private network block: host names', () => {
  it('blocks local and internal names, in any case and with a trailing dot', async () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'a.localhost',
      'a.b.LOCALHOST',
      'printer.local',
      'host.localdomain',
      'service.internal',
      'metadata.google.internal',
      'METADATA.GOOGLE.INTERNAL',
      'service.internal.',
    ]) {
      expect(await reaches(`https://${host}/logs`)).toBe(false);
    }
  });

  it('lets public names through, including ones that only look local', async () => {
    for (const host of [
      'collector.example',
      'localhost.example.com',
      'notlocalhost',
      'locally.example',
      'internal.example.com',
      'myinternal',
      'local.example.com',
    ]) {
      expect(await reaches(`https://${host}/logs`)).toBe(true);
    }
  });
});

describe('the private network block: IPv4', () => {
  it('blocks each reserved range at its first and last address', async () => {
    const blocked = [
      '0.0.0.0',
      '0.255.255.255',
      '10.0.0.0',
      '10.255.255.255',
      '127.0.0.1',
      '127.255.255.255',
      '100.64.0.0',
      '100.127.255.255',
      '168.63.129.16',
      '169.254.0.0',
      '169.254.255.255',
      '172.16.0.0',
      '172.31.255.255',
      '192.0.2.0',
      '192.0.2.255',
      '192.168.0.0',
      '192.168.255.255',
      '198.51.100.0',
      '198.51.100.255',
      '198.18.0.0',
      '198.19.255.255',
      '203.0.113.0',
      '203.0.113.255',
      '224.0.0.0',
      '239.255.255.255',
      '255.255.255.255',
    ];
    for (const address of blocked) {
      expect(await reaches(`https://${address}/logs`)).toBe(false);
    }
  });

  it('lets through the addresses just outside each range', async () => {
    const allowed = [
      '1.0.0.0',
      '8.8.8.8',
      '9.255.255.255',
      '11.0.0.0',
      '126.255.255.255',
      '128.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '100.0.0.1',
      '168.63.129.15',
      '168.63.129.17',
      '168.63.128.16',
      '168.63.130.16',
      '168.62.129.16',
      '168.64.129.16',
      '169.253.255.255',
      '169.255.0.0',
      '168.254.0.1',
      '172.15.255.255',
      '172.32.0.0',
      '192.1.0.0',
      '191.255.255.255',
      '192.167.255.255',
      '192.169.0.0',
      '198.50.255.255',
      '198.52.0.0',
      '198.17.255.255',
      '198.20.0.0',
      '203.1.0.0',
      '202.255.255.255',
      '204.0.0.0',
      '223.255.255.255',
    ];
    for (const address of allowed) {
      expect(await reaches(`https://${address}/logs`)).toBe(true);
    }
    // The second octet of a reserved range does not make an address reserved by itself.
    for (const address of [
      '8.0.0.1',
      '8.16.0.1',
      '8.20.0.1',
      '8.31.0.1',
      '8.18.0.1',
      '8.19.0.1',
      '8.51.0.1',
      '8.63.129.16',
      '8.64.0.1',
      '8.100.0.1',
      '8.127.0.1',
      '8.168.0.1',
      '8.254.0.1',
      '1.168.1.1',
    ]) {
      expect(await reaches(`https://${address}/logs`)).toBe(true);
    }
    expect(await reaches('https://10.0.0.1.example.com/logs')).toBe(true);
  });
});

describe('the private network block: IPv6', () => {
  it('blocks loopback, unspecified, unique local, link-local and multicast addresses', async () => {
    for (const host of [
      '[::1]',
      '[::]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[fe90::1]',
      '[fea0::1]',
      '[febf::1]',
      '[ff02::1]',
      '[ff00::]',
    ]) {
      expect(await reaches(`https://${host}/logs`)).toBe(false);
    }
  });

  it('lets through global unicast addresses', async () => {
    for (const host of ['[2001:db8::1]', '[2606:4700::1111]', '[fb00::1]', '[fec0::1]']) {
      expect(await reaches(`https://${host}/logs`)).toBe(true);
    }
  });

  it('judges an IPv4-mapped address by the IPv4 address inside it', async () => {
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:10.0.0.1]',
      '[::ffff:7f00:1]',
      '[::ffff:a00:1]',
      '[::ffff:c0a8:101]',
      '[::ffff:ac10:1]',
      '[::ffff:a9fe:a9fe]',
      '[::ffff:0:0]',
    ]) {
      expect(await reaches(`https://${host}/logs`)).toBe(false);
    }
    for (const host of [
      '[::ffff:8.8.8.8]',
      '[::ffff:808:808]',
      '[::ffff:808:404]',
      '[::ffff:5db8:d822]',
    ]) {
      expect(await reaches(`https://${host}/logs`)).toBe(true);
    }
  });
});

describe('the request that is sent', () => {
  it('posts JSON by default and sends exactly the headers it owns', async () => {
    const fetcher = ok();
    const result = await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/logs?stream=audit',
      body: '{"a":1}',
      fetcher,
    });
    expect(result).toStrictEqual({ status: 'delivered', httpStatus: 200, redactedHeaders: {} });
    expect(fetcher).toHaveBeenCalledWith('https://collector.example/logs?stream=audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
      redirect: 'manual',
    });
  });

  it('uses the given method, content type and delivery id', async () => {
    const fetcher = ok();
    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/logs',
      method: 'PUT',
      body: 'x',
      contentType: 'application/x-ndjson',
      deliveryId: 'del-1',
      fetcher,
    });
    expect(fetcher.mock.calls[0]?.[1]).toStrictEqual({
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-ndjson', 'X-Authrim-Delivery': 'del-1' },
      body: 'x',
      redirect: 'manual',
    });
  });

  it('only sends over HTTPS, unless HTTP is allowed for HTTP', async () => {
    const fetcher = ok();
    for (const endpointUrl of ['http://collector.example/x', 'ftp://collector.example/x']) {
      await expect(deliverHttpSinkBatch({ endpointUrl, body: '', fetcher })).rejects.toThrow(
        'http_sink_url_must_use_https'
      );
    }
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'ftp://collector.example/x',
        body: '',
        allowHttp: true,
        fetcher,
      })
    ).rejects.toThrow('http_sink_url_must_use_https');
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'http://collector.example/x',
        body: '',
        allowHttp: true,
        fetcher,
      })
    ).resolves.toMatchObject({ status: 'delivered' });
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/x',
        body: '',
        allowHttp: true,
        fetcher,
      })
    ).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('can reach a private target only when allowed, and still only over HTTPS', async () => {
    const fetcher = ok();
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://10.0.0.1/x',
        body: '',
        allowPrivateNetwork: false,
        fetcher,
      })
    ).rejects.toThrow('http_sink_url_private_network_blocked');
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'http://10.0.0.1/x',
        body: '',
        allowPrivateNetwork: true,
        fetcher,
      })
    ).rejects.toThrow('http_sink_url_must_use_https');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('authentication and the signature of the final request', () => {
  it('signs the method, path with query, body and time of the request being sent', async () => {
    const fetcher = ok();
    const now = new Date('2026-05-19T00:00:00.000Z');
    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook/a?x=1&y=2',
      method: 'PUT',
      body: '{"a":1}',
      deliveryId: 'req-delivery',
      auth: {
        mode: 'hmac',
        hmac: { method: 'GET', path: '/ignored', body: 'ignored', secret: 's3', now },
      },
      fetcher,
    });
    const canonical = ['1779148800', 'PUT', '/hook/a?x=1&y=2', await sha256Hex('{"a":1}')].join(
      '\n'
    );
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['X-Authrim-Signature-256']).toBe(`sha256=${await hmacHex('s3', canonical)}`);
    expect(headers['X-Authrim-Delivery']).toBe('req-delivery');
    expect(headers['X-Authrim-Timestamp']).toBe('1779148800');
  });

  it('keeps a delivery id the signature config names over the request one', async () => {
    const fetcher = ok();
    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook',
      body: '{}',
      deliveryId: 'request-id',
      auth: {
        mode: 'hmac',
        hmac: { method: 'POST', path: '/', body: '', secret: 's', deliveryId: 'config-id' },
      },
      fetcher,
    });
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['X-Authrim-Delivery']).toBe('request-id');
    const noRequestId = ok();
    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook',
      body: '{}',
      auth: {
        mode: 'hmac',
        hmac: { method: 'POST', path: '/', body: '', secret: 's', deliveryId: 'config-id' },
      },
      fetcher: noRequestId,
    });
    expect(
      (noRequestId.mock.calls[0]?.[1]?.headers as Record<string, string>)['X-Authrim-Delivery']
    ).toBe('config-id');
  });

  it('sends other auth modes as they are, redacting what is secret', async () => {
    const bearer = ok();
    const result = await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook',
      body: '{}',
      auth: { mode: 'bearer', bearerToken: 'tok' },
      fetcher: bearer,
    });
    expect(result.redactedHeaders).toStrictEqual({ Authorization: '[redacted]' });
    expect((bearer.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok'
    );
    const none = ok();
    await deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook',
      body: '{}',
      auth: { mode: 'none' },
      fetcher: none,
    });
    expect(none.mock.calls[0]?.[1]?.headers).toStrictEqual({ 'Content-Type': 'application/json' });
    const hmacWithoutConfig = ok();
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/hook',
        body: '{}',
        auth: { mode: 'hmac' },
        fetcher: hmacWithoutConfig,
      })
    ).rejects.toThrow('missing_hmac_config');
    const unknown = ok();
    await expect(
      deliverHttpSinkBatch({
        endpointUrl: 'https://collector.example/hook',
        body: '{}',
        auth: { mode: 'other' as never },
        fetcher: unknown,
      })
    ).rejects.toThrow('unsupported_http_sink_auth_mode:other');
    expect(unknown).not.toHaveBeenCalled();
  });
});

describe('what the response means', () => {
  const respond = async (
    status: number,
    headers: Record<string, string> = {},
    attempt?: number
  ) => {
    const fetcher = vi.fn(
      async () => ({ status, headers: new Headers(headers) }) as unknown as Response
    );
    return deliverHttpSinkBatch({
      endpointUrl: 'https://collector.example/hook',
      body: '{}',
      attempt,
      fetcher,
    });
  };

  it('delivers 2xx, retries 429 and 5xx, and fails the rest', async () => {
    for (const status of [200, 201, 204, 299]) {
      expect(await respond(status)).toStrictEqual({
        status: 'delivered',
        httpStatus: status,
        redactedHeaders: {},
      });
    }
    for (const status of [429, 500, 502, 599]) {
      expect(await respond(status)).toMatchObject({ status: 'retrying', httpStatus: status });
    }
    for (const status of [199, 300, 301, 302, 399, 400, 401, 404, 408]) {
      const failed = await respond(status);
      expect(failed).toStrictEqual({ status: 'failed', httpStatus: status, redactedHeaders: {} });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delays a retry by Retry-After, or else by the attempt with jitter', async () => {
    expect((await respond(503, { 'Retry-After': '7' })).retryDelayMs).toBe(7_000);
    const random = vi.spyOn(Math, 'random');
    for (const [sample, first, third] of [
      [0, 800, 3_200],
      [0.5, 1_000, 4_000],
      [1, 1_200, 4_800],
    ] as const) {
      random.mockReturnValue(sample);
      expect((await respond(503)).retryDelayMs).toBe(first);
      expect((await respond(503, {}, 3)).retryDelayMs).toBe(third);
    }
  });
});
