import { describe, expect, it } from 'vitest';

import {
  classifyHttpSinkStatus,
  computeHttpSinkRetryDelayMs,
  getHttpSinkBatchProfile,
  parseRetryAfterMs,
} from '../index';

describe('HTTP sink retry helpers', () => {
  it('classifies retryable and permanent HTTP status codes', () => {
    expect(classifyHttpSinkStatus(204)).toBe('success');
    expect(classifyHttpSinkStatus(302)).toBe('redirect');
    expect(classifyHttpSinkStatus(400)).toBe('permanent_failure');
    expect(classifyHttpSinkStatus(401)).toBe('permanent_failure');
    expect(classifyHttpSinkStatus(408)).toBe('permanent_failure');
    expect(classifyHttpSinkStatus(409)).toBe('permanent_failure');
    expect(classifyHttpSinkStatus(429)).toBe('retry');
    expect(classifyHttpSinkStatus(500)).toBe('retry');
    expect(classifyHttpSinkStatus(503)).toBe('retry');
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-05-19T00:00:00.000Z');

    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs('Tue, 19 May 2026 00:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfterMs('invalid', now)).toBeNull();
  });

  it('computes exponential backoff with bounded jitter', () => {
    expect(
      computeHttpSinkRetryDelayMs({
        attempt: 3,
        baseDelayMs: 1000,
        jitterRatio: 0,
      })
    ).toBe(4000);

    expect(
      computeHttpSinkRetryDelayMs({
        attempt: 2,
        baseDelayMs: 1000,
        jitterRatio: 0.5,
        random: () => 1,
      })
    ).toBe(3000);
  });

  it('honors Retry-After before exponential backoff', () => {
    expect(
      computeHttpSinkRetryDelayMs({
        attempt: 5,
        retryAfter: '10',
        maxDelayMs: 60_000,
      })
    ).toBe(10_000);
  });

  it('exposes the configured batch profiles', () => {
    expect(getHttpSinkBatchProfile('single')).toMatchObject({
      maxRecords: 1,
      sendsChunkReference: false,
    });
    expect(getHttpSinkBatchProfile('small_batch')).toMatchObject({
      maxRecords: 100,
      maxBytes: 512 * 1024,
    });
    expect(getHttpSinkBatchProfile('large_batch')).toMatchObject({
      maxRecords: 1000,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(getHttpSinkBatchProfile('chunk_reference')).toMatchObject({
      sendsChunkReference: true,
    });
  });
});
