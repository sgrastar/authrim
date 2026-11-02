import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile, summarizeProbes } from './metrics.mjs';

test('includes queries spanning the export, separates controls and counts timeout failures', () => {
  const sample = (target, startedMs, finishedMs, ok = true) => ({
    target,
    operation: 'read',
    startedMs,
    finishedMs,
    ok,
    elapsedMs: finishedMs - startedMs,
    timeout: !ok,
  });
  const result = summarizeProbes(
    [
      sample('source', 90, 150),
      sample('source', 160, 220, false),
      sample('control', 110, 115),
      sample('source', 201, 210),
      sample('source', 1, 2),
    ],
    100,
    200
  );
  assert.equal(result['source/read'].requests, 2);
  assert.equal(result['source/read'].failures, 1);
  assert.equal(result['source/read'].timeouts, 1);
  assert.equal(result['source/read'].maxMs, 60);
  assert.equal(result['control/read'].maxMs, 5);
});

test('nearest-rank percentiles and empty data', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([3, 1, 2], 95), 3);
});
