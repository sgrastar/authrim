import { describe, expect, it } from 'vitest';
import { runConcurrentStage, summarizeLatency } from '../core/generated-load-abuse.js';

describe('generated-load-abuse', () => {
  it('summarizeLatency calculates percentiles', () => {
    const summary = summarizeLatency([10, 20, 30, 40, 50]);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(50);
    expect(summary.avg).toBe(30);
    expect(summary.p50).toBe(30);
    expect(summary.p95).toBe(50);
    expect(summary.p99).toBe(50);
  });

  it('runConcurrentStage aggregates successes and failures', async () => {
    let callCount = 0;
    const result = await runConcurrentStage({
      id: 'sample',
      title: 'sample stage',
      concurrency: 2,
      iterationsPerWorker: 3,
      request: async () => {
        callCount += 1;
        if (callCount % 4 === 0) {
          return {
            ok: false,
            status: 429,
            failureSample: 'rate_limited',
          };
        }
        return {
          ok: true,
          status: 200,
        };
      },
    });

    expect(result.totalRequests).toBe(6);
    expect(result.successCount).toBe(5);
    expect(result.failureCount).toBe(1);
    expect(result.statusCounts['200']).toBe(5);
    expect(result.statusCounts['429']).toBe(1);
    expect(result.failureSamples).toContain('rate_limited');
  });
});
