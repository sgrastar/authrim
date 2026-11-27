/**
 * Mutation-driven tests: Login UI edge context helpers and availability probing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  headerOrigin,
  loginUiEdgeAvailable,
  requestOriginVerified,
  type LoginUiEdgeBinding,
} from '../login-ui-edge';

afterEach(() => {
  vi.useRealTimers();
});

const edgeWith = (
  ping: () => Promise<string>
): LoginUiEdgeBinding & { ping: ReturnType<typeof vi.fn> } => ({
  ping: vi.fn(ping),
  handle: vi.fn(),
});

describe('requestOriginVerified by method', () => {
  const send = (method: string, origin?: string) =>
    requestOriginVerified(
      new Request('https://id.example/login', {
        method,
        headers: origin ? { Origin: origin } : {},
      })
    );

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not judge the safe method %s', (method) => {
    expect(send(method, 'https://evil.example')).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('judges %s by its Origin', (method) => {
    expect(send(method, 'https://id.example')).toBe(true);
    expect(send(method, 'https://evil.example')).toBe(false);
    expect(send(method)).toBe(false);
  });

  it('requires scheme and port to match too', () => {
    expect(send('POST', 'http://id.example')).toBe(false);
    expect(send('POST', 'https://id.example:8443')).toBe(false);
  });
});

describe('headerOrigin schemes', () => {
  it('accepts http and https only', () => {
    expect(headerOrigin('http://id.example:8080/x')).toBe('http://id.example:8080');
    expect(headerOrigin('https://id.example/x')).toBe('https://id.example');
    expect(headerOrigin('ftp://id.example/x')).toBeNull();
    expect(headerOrigin('')).toBeNull();
    expect(headerOrigin('null')).toBeNull();
  });
});

describe('loginUiEdgeAvailable probing', () => {
  it('only a literal "ok" answer counts as present', async () => {
    expect(await loginUiEdgeAvailable(edgeWith(async () => 'nope'))).toBe(false);
    expect(await loginUiEdgeAvailable(edgeWith(async () => 'ok'))).toBe(true);
  });

  it('leaves no timer behind once the ping answered', async () => {
    vi.useFakeTimers();
    const edge = edgeWith(async () => 'ok');
    expect(await loginUiEdgeAvailable(edge)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remembers a present entrypoint for ten minutes, not thirty seconds', async () => {
    vi.useFakeTimers();
    const edge = edgeWith(async () => 'ok');
    await loginUiEdgeAvailable(edge);
    vi.advanceTimersByTime(9 * 60_000 + 59_000);
    await loginUiEdgeAvailable(edge);
    expect(edge.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await loginUiEdgeAvailable(edge);
    expect(edge.ping).toHaveBeenCalledTimes(2);
  });

  it('remembers a missing entrypoint for thirty seconds only', async () => {
    vi.useFakeTimers();
    const edge = edgeWith(async () => 'missing');
    await loginUiEdgeAvailable(edge);
    vi.advanceTimersByTime(29_000);
    expect(await loginUiEdgeAvailable(edge)).toBe(false);
    expect(edge.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await loginUiEdgeAvailable(edge);
    expect(edge.ping).toHaveBeenCalledTimes(2);
  });
});
