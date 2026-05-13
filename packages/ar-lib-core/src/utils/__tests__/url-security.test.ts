import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  readResponseTextPreview,
  readResponseTextWithLimit,
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
});
