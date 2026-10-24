import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const yamlDirectory = await realpath(join(projectRoot, 'node_modules/yaml'));
const validLockfile = {
  lockfileVersion: '9.0',
  packages: { 'example-dependency@1.0.0': {} },
  snapshots: { 'example-dependency@1.0.0': {} },
};

async function withFixture(lockfile, installExtractor, run) {
  const root = await mkdtemp(join(tmpdir(), 'authrim-archive-guard-test-'));
  try {
    const scripts = join(root, 'scripts');
    const modules = join(root, 'node_modules');
    await mkdir(scripts);
    await mkdir(modules);
    await copyFile(
      join(projectRoot, 'scripts/check-extract-zip-patch.mjs'),
      join(scripts, 'check-extract-zip-patch.mjs')
    );
    await symlink(yamlDirectory, join(modules, 'yaml'), 'junction');
    // JSON is valid YAML and keeps the lockfile fixtures independent of a serializer.
    await writeFile(
      join(root, 'pnpm-lock.yaml'),
      typeof lockfile === 'string' ? lockfile : JSON.stringify(lockfile)
    );

    const extractor = join(modules, 'extract-zip/index.cjs');
    if (installExtractor) {
      await mkdir(dirname(extractor));
      await writeFile(
        join(dirname(extractor), 'package.json'),
        JSON.stringify({ name: 'extract-zip', main: 'index.cjs' })
      );
      // Resolve successfully without extracting or writing any archive entries.
      await writeFile(extractor, 'module.exports = async () => {};\n');
    }
    await run({ root, extractor });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runChecker(root, args = []) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/check-extract-zip-patch.mjs'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      timeout: 10_000,
    }
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
  return result;
}

test('accepts a valid nonempty v9 lockfile without extract-zip installed or locked', async () => {
  await withFixture(validLockfile, false, ({ root }) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /extract-zip is absent from the dependency lockfile/);
  });
});

for (const { name, lockfile, message } of [
  {
    name: 'unsupported lockfile version',
    lockfile: { ...validLockfile, lockfileVersion: '8.0' },
    message: /Unsupported dependency lockfile/,
  },
  {
    name: 'missing packages',
    lockfile: { ...validLockfile, packages: undefined },
    message: /Dependency lockfile must contain packages/,
  },
  {
    name: 'empty snapshots',
    lockfile: { ...validLockfile, snapshots: {} },
    message: /Dependency lockfile must contain snapshots/,
  },
  {
    name: 'malformed YAML',
    lockfile: 'lockfileVersion: "9.0"\npackages: [\n',
    message: /YAMLParseError/,
  },
]) {
  test(`rejects ${name}`, async () => {
    await withFixture(lockfile, false, ({ root }) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
    });
  });
}

test('checks malicious archive rejection when an extractor is explicitly selected', async () => {
  await withFixture(validLockfile, true, ({ root, extractor }) => {
    const result = runChecker(root, [extractor]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Missing expected rejection/);
    assert.doesNotMatch(result.stdout, /absent from the dependency lockfile/);
  });
});

for (const section of ['packages', 'snapshots']) {
  test(`checks the extractor when extract-zip is locked in ${section}`, async () => {
    const lockfile = { ...validLockfile, [section]: { 'extract-zip@2.0.1': {} } };
    await withFixture(lockfile, true, ({ root }) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Missing expected rejection/);
      assert.doesNotMatch(result.stdout, /absent from the dependency lockfile/);
    });
  });
}
