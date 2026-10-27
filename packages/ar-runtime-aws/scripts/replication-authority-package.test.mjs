import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { promisify } from 'node:util';
import {
  packageReplicationAuthority,
  parseReplicationPackageArguments,
} from './package-replication-authority.mjs';

const execute = promisify(execFile);
let directory;
let caBundlePath;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'authrim-authority-package-test-'));
  caBundlePath = join(directory, 'ca.pem');
  const config = join(directory, 'ca.cnf');
  await writeFile(
    config,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Authrim Synthetic Root\n[extensions]\nbasicConstraints=critical,CA:TRUE\n'
  );
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    config,
    '-keyout',
    join(directory, 'private.pem'),
    '-out',
    caBundlePath,
  ]);
  for (const file of [
    'replication-authority.mjs',
    'authority-schema.sql',
    'secrets.json',
    'replication-authority.mjs.map',
  ])
    await writeFile(
      join(directory, file),
      file.endsWith('.mjs') ? 'export const handler = () => 200;\n' : 'not-for-runtime-package'
    );
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('authority package is reproducible and contains only runtime plus verified CA', async () => {
  const first = await packageReplicationAuthority({ outputDirectory: directory, caBundlePath });
  const bytes = await readFile(join(directory, first.file));
  assert.deepEqual(
    (await execute('unzip', ['-Z', '-1', join(directory, first.file)])).stdout.trim().split('\n'),
    first.files
  );
  assert.deepEqual(first.files, ['certs/rds-ca.pem', 'replication-authority.mjs']);
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.handler, 'replication-authority.handler');
  assert.deepEqual(
    await packageReplicationAuthority({ outputDirectory: directory, caBundlePath }),
    first
  );
});

test('authority packaging rejects invalid CA and executable symlinks', async () => {
  const invalid = join(directory, 'not-ca.pem');
  await writeFile(invalid, 'synthetic private value');
  await assert.rejects(
    packageReplicationAuthority({ outputDirectory: directory, caBundlePath: invalid })
  );
  const bundle = join(directory, 'replication-authority.mjs');
  await rm(bundle);
  await symlink(join(directory, 'secrets.json'), bundle);
  await assert.rejects(packageReplicationAuthority({ outputDirectory: directory, caBundlePath }));
});

test('authority package accepts only an explicit CA path with no include override', () => {
  assert.deepEqual(parseReplicationPackageArguments(['--ca-bundle', caBundlePath]), {
    caBundlePath,
  });
  for (const args of [
    [],
    ['--ca-bundle'],
    ['--ca-bundle', '--private'],
    ['--ca-bundle', caBundlePath, '--include', 'secrets.json'],
  ])
    assert.throws(() => parseReplicationPackageArguments(args));
});
