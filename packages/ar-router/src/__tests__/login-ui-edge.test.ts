import { describe, expect, it, vi } from 'vitest';
import {
  buildLoginUiEdgeContext,
  headerOrigin,
  EDGE_PING_TIMEOUT_MS,
  forgetLoginUiEdge,
  loginUiEdgeAvailable,
  requestOriginVerified,
} from '../login-ui-edge';

const post = (headers: Record<string, string>) =>
  new Request('https://id.example/login', { method: 'POST', headers });

describe('the Router → Login UI edge context', () => {
  it('verifies an unsafe request by its Origin only', () => {
    expect(requestOriginVerified(post({ Origin: 'https://id.example' }))).toBe(true);
    expect(requestOriginVerified(post({ Origin: 'https://rp.example' }))).toBe(false);
    expect(
      requestOriginVerified(post({ Origin: 'https://rp.example', Referer: 'https://id.example/' }))
    ).toBe(false);
    expect(requestOriginVerified(post({ Origin: 'null' }))).toBe(false);
    expect(requestOriginVerified(post({ Referer: 'https://id.example/login?x=1' }))).toBe(false);
    expect(requestOriginVerified(post({}))).toBe(false);
    expect(requestOriginVerified(new Request('https://id.example/login'))).toBeNull();
  });

  it('reads the IP from CF-Connecting-IP only and the public origin from the request URL', () => {
    expect(
      buildLoginUiEdgeContext(
        new Request('https://id.example/login', {
          headers: { 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '10.0.0.1' },
        })
      )
    ).toEqual({
      originVerified: null,
      clientIp: '203.0.113.1',
      publicOrigin: 'https://id.example',
    });
    expect(
      buildLoginUiEdgeContext(
        new Request('https://id.example/login', { headers: { 'X-Forwarded-For': '10.0.0.1' } })
      ).clientIp
    ).toBeNull();
  });

  it('reads only HTTP origins from header values', () => {
    expect(headerOrigin('https://id.example/a?b')).toBe('https://id.example');
    expect(headerOrigin('javascript:alert(1)')).toBeNull();
    expect(headerOrigin('not a url')).toBeNull();
    expect(headerOrigin(null)).toBeNull();
  });
});

describe('loginUiEdgeAvailable', () => {
  it('remembers the answer, and never shares a pending ping between requests', async () => {
    const edge = { ping: vi.fn(async () => 'ok'), handle: vi.fn() };
    // Before the first answer, each request asks for itself.
    const answers = await Promise.all([1, 2, 3].map(() => loginUiEdgeAvailable(edge)));
    expect(answers).toEqual([true, true, true]);
    expect(edge.ping).toHaveBeenCalledTimes(3);
    expect(await loginUiEdgeAvailable(edge)).toBe(true);
    expect(edge.ping).toHaveBeenCalledTimes(3);
  });

  it('asks again after a while when the entrypoint was missing', async () => {
    vi.useFakeTimers();
    try {
      let present = false;
      const edge = {
        ping: vi.fn(async () => {
          if (!present) throw new Error('missing');
          return 'ok';
        }),
        handle: vi.fn(),
      };
      expect(await loginUiEdgeAvailable(edge)).toBe(false);
      present = true;
      expect(await loginUiEdgeAvailable(edge)).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(await loginUiEdgeAvailable(edge)).toBe(true);
      expect(edge.ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loginUiEdgeAvailable when the entrypoint does not answer', () => {
  it('gives up after the timeout, and remembers the entrypoint as missing', async () => {
    vi.useFakeTimers();
    try {
      const edge = { ping: vi.fn(() => new Promise<string>(() => undefined)), handle: vi.fn() };
      const first = loginUiEdgeAvailable(edge);
      await vi.advanceTimersByTimeAsync(EDGE_PING_TIMEOUT_MS);
      expect(await first).toBe(false);
      // Answered at once, without waiting on the ping that never settled.
      expect(await loginUiEdgeAvailable(edge)).toBe(false);
      expect(edge.ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again once forgotten', async () => {
    const edge = { ping: vi.fn(async () => 'ok'), handle: vi.fn() };
    expect(await loginUiEdgeAvailable(edge)).toBe(true);
    forgetLoginUiEdge(edge);
    expect(await loginUiEdgeAvailable(edge)).toBe(true);
    expect(edge.ping).toHaveBeenCalledTimes(2);
  });
});
