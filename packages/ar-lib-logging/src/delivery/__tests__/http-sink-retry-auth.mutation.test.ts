import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHttpSinkAuthHeaders } from '../http-sink-auth';
import {
  HTTP_SINK_BATCH_PROFILES,
  classifyHttpSinkStatus,
  computeHttpSinkRetryDelayMs,
  getHttpSinkBatchProfile,
  parseRetryAfterMs,
} from '../http-sink-retry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('batch profiles', () => {
  it('give each profile its limits', () => {
    expect(HTTP_SINK_BATCH_PROFILES).toStrictEqual({
      single: {
        name: 'single',
        maxRecords: 1,
        maxBytes: 524_288,
        flushIntervalMs: 5000,
        sendsChunkReference: false,
      },
      small_batch: {
        name: 'small_batch',
        maxRecords: 100,
        maxBytes: 524_288,
        flushIntervalMs: 10_000,
        sendsChunkReference: false,
      },
      large_batch: {
        name: 'large_batch',
        maxRecords: 1000,
        maxBytes: 4_194_304,
        flushIntervalMs: 30_000,
        sendsChunkReference: false,
      },
      chunk_reference: {
        name: 'chunk_reference',
        maxRecords: 1000,
        maxBytes: 262_144,
        flushIntervalMs: 30_000,
        sendsChunkReference: true,
      },
    });
  });

  it('default to the small batch, also for a name that is not one', () => {
    expect(getHttpSinkBatchProfile()).toBe(HTTP_SINK_BATCH_PROFILES.small_batch);
    expect(getHttpSinkBatchProfile('single')).toBe(HTTP_SINK_BATCH_PROFILES.single);
    expect(getHttpSinkBatchProfile('nope' as never)).toBe(HTTP_SINK_BATCH_PROFILES.small_batch);
  });
});

describe('classifyHttpSinkStatus', () => {
  it('splits statuses at their class boundaries', () => {
    const expected: Array<[number, string]> = [
      [100, 'permanent_failure'],
      [199, 'permanent_failure'],
      [200, 'success'],
      [299, 'success'],
      [300, 'redirect'],
      [399, 'redirect'],
      [400, 'permanent_failure'],
      [428, 'permanent_failure'],
      [429, 'retry'],
      [430, 'permanent_failure'],
      [499, 'permanent_failure'],
      [500, 'retry'],
      [599, 'retry'],
    ];
    for (const [status, kind] of expected) expect(classifyHttpSinkStatus(status)).toBe(kind);
  });
});

describe('parseRetryAfterMs', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('reads a whole number of seconds, and nothing else that merely starts with one', () => {
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('15')).toBe(15_000);
    expect(parseRetryAfterMs(' 15 ')).toBe(15_000);
    expect(parseRetryAfterMs('15 seconds', now)).toBeNull();
  });

  it('reads an HTTP date as the time until then, and never less than zero', () => {
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('has nothing for an empty or unreadable value', () => {
    for (const value of [undefined, null, '', 'soon', 'not a date']) {
      expect(parseRetryAfterMs(value, now)).toBeNull();
    }
  });
});

describe('computeHttpSinkRetryDelayMs', () => {
  const noJitter = { random: () => 0.5 };

  it('doubles the delay with each attempt, up to the maximum', () => {
    const delay = (attempt: number, extra: Record<string, unknown> = {}) =>
      computeHttpSinkRetryDelayMs({ attempt, ...noJitter, ...extra });
    expect(delay(1)).toBe(1000);
    expect(delay(2)).toBe(2000);
    expect(delay(3)).toBe(4000);
    expect(delay(8)).toBe(128_000);
    expect(delay(9)).toBe(256_000);
    expect(delay(10)).toBe(300_000);
    expect(delay(50)).toBe(300_000);
    expect(delay(3, { baseDelayMs: 100 })).toBe(400);
    expect(delay(3, { baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });

  it('counts attempts below one, and fractions of one, as the first', () => {
    for (const attempt of [0, -3, 0.5, 1.9]) {
      expect(computeHttpSinkRetryDelayMs({ attempt, ...noJitter })).toBe(1000);
    }
    expect(computeHttpSinkRetryDelayMs({ attempt: 2.9, ...noJitter })).toBe(2000);
  });

  it('spreads the delay by the jitter ratio around the exponential value', () => {
    const delay = (random: number, jitterRatio?: number) =>
      computeHttpSinkRetryDelayMs({ attempt: 2, random: () => random, jitterRatio });
    expect(delay(0)).toBe(1600);
    expect(delay(1)).toBe(2400);
    expect(delay(0.5)).toBe(2000);
    expect(delay(0, 0.5)).toBe(1000);
    expect(delay(1, 0.5)).toBe(3000);
    expect(delay(1, 0)).toBe(2000);
    expect(delay(0, 5)).toBe(0);
    expect(delay(1, 5)).toBe(4000);
    expect(delay(1, -1)).toBe(2000);
  });

  it('never exceeds the maximum, even with jitter, and never goes below zero', () => {
    expect(computeHttpSinkRetryDelayMs({ attempt: 10, random: () => 1 })).toBe(300_000);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1, random: () => 0, jitterRatio: 1 })).toBe(0);
    expect(computeHttpSinkRetryDelayMs({ attempt: 9, random: () => 1, maxDelayMs: 1000 })).toBe(
      1000
    );
  });

  it('uses Retry-After over the schedule, capped at the maximum', () => {
    expect(computeHttpSinkRetryDelayMs({ attempt: 1, retryAfter: '7', ...noJitter })).toBe(7000);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1, retryAfter: '0', ...noJitter })).toBe(0);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1, retryAfter: '99999', ...noJitter })).toBe(
      300_000
    );
    expect(computeHttpSinkRetryDelayMs({ attempt: 1, retryAfter: '99999', maxDelayMs: 5000 })).toBe(
      5000
    );
    expect(computeHttpSinkRetryDelayMs({ attempt: 3, retryAfter: 'garbage', ...noJitter })).toBe(
      4000
    );
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(
      computeHttpSinkRetryDelayMs({ attempt: 1, retryAfter: 'Thu, 01 Jan 2026 00:00:30 GMT', now })
    ).toBe(30_000);
  });

  it('works with the default random source', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1 })).toBe(800);
    random.mockReturnValue(0.5);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1 })).toBe(1000);
    random.mockReturnValue(1);
    expect(computeHttpSinkRetryDelayMs({ attempt: 1 })).toBe(1200);
    expect(random).toHaveBeenCalledTimes(3);
  });
});

describe('buildHttpSinkAuthHeaders', () => {
  it('adds nothing for no auth', async () => {
    expect(await buildHttpSinkAuthHeaders({ mode: 'none' })).toStrictEqual({
      headers: {},
      redactedHeaders: {},
    });
  });

  it('rejects an unknown mode instead of sending without auth', async () => {
    await expect(buildHttpSinkAuthHeaders({ mode: 'other' as never })).rejects.toThrow(
      'unsupported_http_sink_auth_mode:other'
    );
  });

  it('sends a bearer token and redacts it', async () => {
    expect(await buildHttpSinkAuthHeaders({ mode: 'bearer', bearerToken: 'tok' })).toStrictEqual({
      headers: { Authorization: 'Bearer tok' },
      redactedHeaders: { Authorization: '[redacted]' },
    });
    for (const bearerToken of [undefined, '']) {
      await expect(buildHttpSinkAuthHeaders({ mode: 'bearer', bearerToken })).rejects.toThrow(
        'missing_bearer_token'
      );
    }
  });

  it('sends an API key under its header, with or without a prefix, and redacts it', async () => {
    expect(
      await buildHttpSinkAuthHeaders({
        mode: 'api_key',
        apiKey: { headerName: 'X-Key', value: 'v' },
      })
    ).toStrictEqual({ headers: { 'X-Key': 'v' }, redactedHeaders: { 'X-Key': '[redacted]' } });
    expect(
      await buildHttpSinkAuthHeaders({
        mode: 'api_key',
        apiKey: { headerName: 'X-Plain', value: 'v', prefix: 'Key' },
      })
    ).toStrictEqual({
      headers: { 'X-Plain': 'Key v' },
      redactedHeaders: { 'X-Plain': '[redacted]' },
    });
    expect(
      await buildHttpSinkAuthHeaders({
        mode: 'api_key',
        apiKey: { headerName: 'X-Plain', value: 'v', prefix: '' },
      })
    ).toMatchObject({ headers: { 'X-Plain': 'v' } });
    await expect(buildHttpSinkAuthHeaders({ mode: 'api_key' })).rejects.toThrow('missing_api_key');
  });

  it('sends custom headers, redacting the secret and the sensitive ones', async () => {
    const result = await buildHttpSinkAuthHeaders({
      mode: 'custom_headers',
      customHeaders: [
        { name: 'X-Tenant', value: 'acme' },
        { name: 'X-Marked', value: 'a', secret: true },
        { name: 'X-Not-Marked', value: 'b', secret: false },
        { name: 'Cookie', value: 'c' },
        { name: 'X-Auth-Token', value: 'd' },
        { name: 'X_Client_Secret', value: 'e' },
        { name: 'X-Api-Key', value: 'f' },
        { name: 'X_ApiKey', value: 'g' },
        { name: 'Proxy-Authorization', value: 'h' },
      ],
    });
    expect(result.headers).toMatchObject({ 'X-Tenant': 'acme', 'X-Marked': 'a', Cookie: 'c' });
    expect(result.redactedHeaders).toStrictEqual({
      'X-Tenant': 'acme',
      'X-Marked': '[redacted]',
      'X-Not-Marked': 'b',
      Cookie: '[redacted]',
      'X-Auth-Token': '[redacted]',
      X_Client_Secret: '[redacted]',
      'X-Api-Key': '[redacted]',
      X_ApiKey: '[redacted]',
      'Proxy-Authorization': '[redacted]',
    });
  });

  it('refuses a header name or value that could split a request', async () => {
    for (const name of ['', 'bad name', 'bad:name', 'x\ny', 'é']) {
      await expect(
        buildHttpSinkAuthHeaders({ mode: 'custom_headers', customHeaders: [{ name, value: 'v' }] })
      ).rejects.toThrow(`invalid_http_header_name:${name}`);
    }
    for (const value of ['a\nb', 'a\rb', 'a\r\nb']) {
      await expect(
        buildHttpSinkAuthHeaders({
          mode: 'custom_headers',
          customHeaders: [{ name: 'X-A', value }],
        })
      ).rejects.toThrow('invalid_http_header_value');
      await expect(
        buildHttpSinkAuthHeaders({ mode: 'bearer', bearerToken: value })
      ).rejects.toThrow('invalid_http_header_value');
    }
    await expect(
      buildHttpSinkAuthHeaders({
        mode: 'custom_headers',
        customHeaders: [{ name: "X-A!#$%&'*+.^_`|~-1", value: 'v' }],
      })
    ).resolves.toBeDefined();
  });

  it('signs with the secret, redacting the signature header only', async () => {
    const result = await buildHttpSinkAuthHeaders({
      mode: 'hmac',
      hmac: {
        method: 'POST',
        path: '/x',
        body: 'b',
        secret: 's',
        deliveryId: 'del',
        now: new Date('2026-05-19T00:00:00.000Z'),
      },
    });
    expect(Object.keys(result.headers).sort()).toEqual([
      'X-Authrim-Delivery',
      'X-Authrim-Signature-256',
      'X-Authrim-Signature-Version',
      'X-Authrim-Timestamp',
    ]);
    expect(result.redactedHeaders).toMatchObject({
      'X-Authrim-Delivery': 'del',
      'X-Authrim-Signature-256': '[redacted]',
      'X-Authrim-Timestamp': '1779148800',
    });
    await expect(buildHttpSinkAuthHeaders({ mode: 'hmac' })).rejects.toThrow('missing_hmac_config');
  });
});
