import { Blob } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn<(hostname: string) => Promise<string[]>>(),
  resolve6: vi.fn<(hostname: string) => Promise<string[]>>(),
  setServers: vi.fn<(servers: string[]) => void>(),
  cancel: vi.fn<() => void>(),
  request: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('node:dns/promises', () => ({
  Resolver: class {
    setServers = mocks.setServers;
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
    cancel = mocks.cancel;
  },
}));
vi.mock('node:https', () => ({ request: mocks.request }));

import { fetchWithPublicDns, isDnsResolutionError } from '../core/public-dns-fetch.js';

class FakeResponse extends EventEmitter {
  headers: Record<string, string | string[]> = { 'content-type': 'text/plain' };
  statusCode = 200;
  statusMessage = 'OK';

  destroy(error: Error): void {
    this.emit('error', error);
  }
}

class FakeRequest extends EventEmitter {
  body: string | Uint8Array | undefined;
  timeoutMs = 0;
  timeoutCallback?: () => void;

  constructor(private readonly onEnd: () => void) {
    super();
  }

  setTimeout(timeoutMs: number, callback: () => void): void {
    this.timeoutMs = timeoutMs;
    this.timeoutCallback = callback;
  }

  end(body?: string | Uint8Array): void {
    this.body = body;
    this.onEnd();
  }

  destroy(error: Error): void {
    this.emit('error', error);
  }
}

function installResponse(
  input: {
    status?: number;
    headers?: Record<string, string | string[]>;
    chunks?: Buffer[];
  } = {}
): FakeRequest[] {
  const requests: FakeRequest[] = [];
  mocks.request.mockImplementation((...args) => {
    const respond = args[2] as (response: FakeResponse) => void;
    const request = new FakeRequest(() => {
      const response = new FakeResponse();
      response.statusCode = input.status ?? 200;
      response.headers = input.headers ?? response.headers;
      respond(response);
      for (const chunk of input.chunks ?? []) response.emit('data', chunk);
      response.emit('end');
    });
    requests.push(request);
    return request;
  });
  return requests;
}

describe('public DNS HTTPS fallback', () => {
  beforeEach(() => {
    mocks.resolve4.mockReset().mockResolvedValue(['203.0.113.7']);
    mocks.resolve6.mockReset().mockResolvedValue([]);
    mocks.setServers.mockReset();
    mocks.cancel.mockReset();
    mocks.request.mockReset();
  });

  it('recognizes direct and nested resolver errors without accepting unrelated failures', () => {
    expect(isDnsResolutionError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isDnsResolutionError({ cause: { code: 'EAI_AGAIN' } })).toBe(true);
    expect(isDnsResolutionError({ cause: { code: 'ECONNREFUSED' } })).toBe(false);
    expect(isDnsResolutionError(null)).toBe(false);
  });

  it('refuses cleartext requests before resolving a public address', async () => {
    await expect(fetchWithPublicDns('http://api.example.test/ready')).rejects.toThrow(
      'public_dns_fallback_requires_https'
    );
    expect(mocks.resolve4).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('uses the public IPv4 answer only for lookup and preserves the HTTPS URL, headers, and body', async () => {
    const requests = installResponse({
      headers: { 'set-cookie': ['a=1', 'b=2'], 'content-type': 'text/plain' },
      chunks: [Buffer.from('ready')],
    });
    const response = await fetchWithPublicDns(
      'https://api.example.test/ready',
      { method: 'POST', headers: { 'X-Request-ID': 'request-1' }, body: 'payload' },
      250
    );

    expect(mocks.setServers).toHaveBeenCalledWith(['1.1.1.1', '1.0.0.1']);
    expect(mocks.resolve4).toHaveBeenCalledWith('api.example.test');
    expect(mocks.resolve6).not.toHaveBeenCalled();
    const [url, options] = mocks.request.mock.calls[0] as [
      URL,
      {
        method: string;
        headers: Record<string, string>;
        lookup: (
          hostname: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void
        ) => void;
      },
    ];
    expect(url.href).toBe('https://api.example.test/ready');
    expect(options.method).toBe('POST');
    expect(options.headers['x-request-id']).toBe('request-1');
    const lookup = vi.fn();
    options.lookup('api.example.test', {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, '203.0.113.7', 4);
    options.lookup('api.example.test', { all: true }, lookup);
    expect(lookup).toHaveBeenLastCalledWith(null, [{ address: '203.0.113.7', family: 4 }]);
    expect(requests[0].body).toBe('payload');
    expect(requests[0].timeoutMs).toBe(250);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ready');
    expect(response.headers.get('set-cookie')).toContain('a=1');
    expect(response.headers.get('set-cookie')).toContain('b=2');
  });

  it('falls back to IPv6 and does not attach a body to a 204 response', async () => {
    mocks.resolve4.mockRejectedValue(new Error('IPv4 unavailable'));
    mocks.resolve6.mockResolvedValue(['invalid', '2001:db8::7']);
    installResponse({ status: 204, chunks: [Buffer.from('ignored')] });

    const response = await fetchWithPublicDns(new URL('https://api.example.test/ready'));
    expect(mocks.resolve6).toHaveBeenCalledWith('api.example.test');
    const options = mocks.request.mock.calls[0]?.[1] as {
      lookup: (
        hostname: string,
        options: { all?: boolean },
        callback: (...args: unknown[]) => void
      ) => void;
    };
    const lookup = vi.fn();
    options.lookup('api.example.test', {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, '2001:db8::7', 6);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it.each([
    [new URLSearchParams({ grant_type: 'client_credentials' }), 'grant_type=client_credentials'],
    [new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])],
    [new Uint8Array([4, 5, 6]).buffer, new Uint8Array([4, 5, 6])],
    [new Blob(['payload']), new Uint8Array(Buffer.from('payload'))],
  ])('serializes a supported request body without changing its bytes', async (body, expected) => {
    const requests = installResponse();
    await fetchWithPublicDns('https://api.example.test/token', { method: 'POST', body });
    expect(requests[0].body).toEqual(expected);
  });

  it('rejects unsupported streaming request bodies before opening HTTPS', async () => {
    await expect(
      fetchWithPublicDns('https://api.example.test/token', {
        method: 'POST',
        body: new ReadableStream() as unknown as globalThis.RequestInit['body'],
      })
    ).rejects.toThrow('public_dns_fallback_unsupported_request_body');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects oversized responses without returning truncated content', async () => {
    installResponse({ chunks: [Buffer.alloc(1024 * 1024 + 1)] });
    await expect(fetchWithPublicDns('https://api.example.test/ready')).rejects.toThrow(
      'public_dns_response_too_large'
    );
  });

  it('does not start DNS resolution when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithPublicDns('https://api.example.test/ready', { signal: controller.signal })
    ).rejects.toThrow('public_dns_fetch_aborted');
    expect(mocks.resolve4).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects DNS answers without a valid IPv4 or IPv6 address', async () => {
    mocks.resolve4.mockResolvedValue(['not an address']);
    mocks.resolve6.mockResolvedValue(['also invalid']);
    await expect(fetchWithPublicDns('https://api.example.test/ready')).rejects.toThrow(
      'public_dns_address_missing'
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('cancels the resolver and stops before HTTPS when aborted during DNS lookup', async () => {
    const controller = new AbortController();
    mocks.resolve4.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        })
    );
    const pending = fetchWithPublicDns('https://api.example.test/ready', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.resolve4).toHaveBeenCalled());
    controller.abort();

    await expect(pending).rejects.toThrow('public_dns_fetch_aborted');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.resolve6).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'abort'] as const)(
    'closes an in-flight HTTPS request on %s',
    async (mode) => {
      const controller = new AbortController();
      let request: FakeRequest | undefined;
      mocks.request.mockImplementation(() => {
        request = new FakeRequest(() => {});
        return request;
      });
      const pending = fetchWithPublicDns('https://api.example.test/ready', {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(request).toBeDefined());

      if (mode === 'timeout') request?.timeoutCallback?.();
      else controller.abort();

      await expect(pending).rejects.toThrow(
        mode === 'timeout' ? 'public_dns_fetch_timeout' : 'public_dns_fetch_aborted'
      );
      expect(mocks.cancel).not.toHaveBeenCalled();
    }
  );
});
