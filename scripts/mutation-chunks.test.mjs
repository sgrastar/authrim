import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, parseArgs } from './mutation-chunks.mjs';

const f = (path, size) => ({ path, size });

test('planChunks keeps path order and fills chunks up to the byte limit', () => {
  const chunks = planChunks([f('src/b.ts', 60), f('src/a.ts', 50), f('src/c.ts', 40)], 100);
  assert.deepEqual(
    chunks.map((c) => c.files),
    [['src/a.ts'], ['src/b.ts', 'src/c.ts']]
  );
  assert.deepEqual(
    chunks.map((c) => c.bytes),
    [50, 100]
  );
});

test('planChunks gives an oversized file its own chunk and handles no files', () => {
  assert.deepEqual(
    planChunks([f('a.ts', 10), f('big.ts', 500), f('z.ts', 10)], 100).map((c) => c.files),
    [['a.ts'], ['big.ts'], ['z.ts']]
  );
  assert.deepEqual(planChunks([], 100), []);
});

test('parseArgs reads options and passes extra mutator arguments through', () => {
  const opts = parseArgs(['ar-x', '--chunk', '2,5', '--time-budget', '60', '--', '-j', '2']);
  assert.equal(opts.pkg, 'ar-x');
  assert.deepEqual(opts.only, [2, 5]);
  assert.deepEqual(opts.extra, ['-j', '2', '--time-budget', '60']);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['p', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['p', '--chunk', '0']), /bad --chunk/);
});

test('parseArgs rejects arguments that would change a chunk or its report', () => {
  for (const flag of ['--include', '--exclude', '--report-dir', '--reporter']) {
    assert.throws(() => parseArgs(['p', '--', flag, 'x']), /cannot be passed through/);
  }
  assert.throws(() => parseArgs(['p', '--chunk']), /needs a value/);
});
