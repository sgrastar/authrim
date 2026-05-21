import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isInternalUrl,
  readResponseTextPreview,
  readResponseTextWithLimit,
  safeFetch,
  safeFetchJson,
  safeFetchText,
} from '../url-security';

describe('url-security response limits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('limits streamed text responses without Content-Length', async () => {
    const response = new Response('x'.repeat(12), { status: 200 });

    await expect(readResponseTextWithLimit(response, 8)).rejects.toThrow(
      'Response body exceeds limit'
    );
  });

  it('uses size-limited parsing for JSON responses without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ value: 'x'.repeat(32) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(
      safeFetchJson('https://example.com/metadata.json', { maxResponseSize: 16 })
    ).rejects.toThrow('Response body exceeds limit');
  });

  it('uses size-limited parsing for text responses without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<xml>' + 'x'.repeat(32) + '</xml>', {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        })
      )
    );

    await expect(
      safeFetchText('https://example.com/metadata.xml', { maxResponseSize: 16 })
    ).rejects.toThrow('Response body exceeds limit');
  });

  it('can return a bounded text preview without buffering the full response', async () => {
    const response = new Response('x'.repeat(12), { status: 200 });

    await expect(readResponseTextPreview(response, 8)).resolves.toBe('x'.repeat(8));
  });

  it('does not follow redirects by default after SSRF validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://example.com/webhook')).resolves.toMatchObject({
      status: 302,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});

describe('url-security SSRF host classification', () => {
  it('blocks shared, documentation, multicast, and IPv4-mapped internal addresses', () => {
    expect(isInternalUrl('https://100.64.0.1/')).toBe(true);
    expect(isInternalUrl('https://168.63.129.16/')).toBe(true);
    expect(isInternalUrl('https://192.0.2.10/')).toBe(true);
    expect(isInternalUrl('https://224.0.0.1/')).toBe(true);
    expect(isInternalUrl('https://[::ffff:127.0.0.1]/')).toBe(true);
    expect(isInternalUrl('https://[::ffff:7f00:1]/')).toBe(true);
    expect(isInternalUrl('https://[fc00::1]/')).toBe(true);
    expect(isInternalUrl('https://localhost.localdomain/')).toBe(true);
    expect(isInternalUrl('https://service.internal/')).toBe(true);
    expect(isInternalUrl('https://service.local/')).toBe(true);
    expect(isInternalUrl('https://example.com/')).toBe(false);
  });
});
