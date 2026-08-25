import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '../core/http-limits.js';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the request timeout active when an external cancellation signal is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: globalThis.RequestInfo | URL, init?: globalThis.RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        });
      })
    );

    await expect(
      fetchWithTimeout(
        'https://api.example.com/health',
        { signal: new AbortController().signal },
        5
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('also honors caller cancellation before the timeout', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: globalThis.RequestInfo | URL, init?: globalThis.RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true }
          );
        });
      })
    );

    const request = fetchWithTimeout(
      'https://api.example.com/health',
      { signal: controller.signal },
      10_000
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
