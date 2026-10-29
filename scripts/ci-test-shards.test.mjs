import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkShards, filtersFor, SHARDS, testedPackages } from './ci-test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every package that has tests is in exactly one shard', async () => {
  assert.deepEqual(checkShards(await testedPackages(root)), []);
});

test('reports a package that no shard runs, one that two shards run, and an unknown one', () => {
  const shards = { a: ['@x/one', '@x/two'], b: ['@x/two', '@x/ghost'] };
  assert.deepEqual(checkShards(['@x/one', '@x/two', '@x/three'], shards, []), [
    '@x/two is in both "a" and "b"',
    '@x/three has tests but belongs to no shard',
    '@x/ghost is in a shard but has no test script',
  ]);
});

test('does not ask the UI packages to be in a shard', () => {
  assert.deepEqual(checkShards(['@x/ui'], {}, ['@x/ui']), []);
});

test('turns a shard into turbo filters', () => {
  assert.equal(filtersFor('management'), '--filter=@authrim/ar-management');
  assert.ok(filtersFor('auth').split(' ').length === SHARDS.auth.length);
  assert.throws(() => filtersFor('missing'), /Unknown shard/);
});
