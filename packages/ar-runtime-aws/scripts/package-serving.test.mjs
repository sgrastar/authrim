import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packageServingArtifact,
  parseServingPackageArguments,
  validateServingCaBundle,
} from './package-serving.mjs';

const execute = promisify(execFile);
let directory;
let caPath;
let ca;
let leaf;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'authrim-serving-package-test-'));
  for (const [name, isCa] of [
    ['root', 'TRUE'],
    ['leaf', 'FALSE'],
  ]) {
    const config = join(directory, `${name}.cnf`);
    await writeFile(
      config,
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=Authrim Synthetic ${name}\n[extensions]\nbasicConstraints=critical,CA:${isCa}\n`
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
      join(directory, `${name}-private.pem`),
      '-out',
      join(directory, `${name}.pem`),
    ]);
  }
  caPath = join(directory, 'root.pem');
  ca = await readFile(caPath, 'utf8');
  leaf = await readFile(join(directory, 'leaf.pem'), 'utf8');
  for (const file of [
    'lambda.mjs',
    'lambda-api.mjs',
    'browser-sp.mjs',
    'db-bootstrap.mjs',
    'synthetic-backup-cli.mjs',
    'lambda.mjs.map',
    'secrets.json',
  ])
    await writeFile(
      join(directory, file),
      file.endsWith('.mjs') ? 'export const handler = () => 200;\n' : 'must-not-be-packaged'
    );
});

test('API-only packaging uses its own bundle but preserves the Lambda handler filename', async () => {
  const apiSource = 'export const handler = () => "API_ONLY_SENTINEL";\n';
  await writeFile(join(directory, 'lambda-api.mjs'), apiSource);
  const receipt = await packageServingArtifact({ entry: 'lambda', outputDirectory: directory, caBundlePath: caPath, loginUi: 'none' });
  assert.equal(receipt.handler, 'lambda.handler');
  assert.deepEqual(receipt.files, ['certs/rds-ca.pem', 'lambda.mjs']);
  const content = await execute('unzip', ['-p', join(directory, 'lambda.zip'), 'lambda.mjs']);
  assert.equal(content.stdout, apiSource);
  assert.equal(receipt.loginUi, 'none');
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('serving packaging requires an explicit CA bundle and rejects extra CLI options', () => {
  assert.equal(parseServingPackageArguments(['--ca-bundle', caPath]).caBundlePath, caPath);
  for (const args of [
    [],
    ['--ca-bundle'],
    ['--ca-bundle', ''],
    ['--ca-bundle', caPath, '--include', 'secrets.json'],
  ])
    assert.throws(() => parseServingPackageArguments(args), /--ca-bundle/u);
});

test('only current, self-signed CA certificates are accepted, without trailing key material', () => {
  assert.doesNotThrow(() => validateServingCaBundle(ca));
  for (const rejected of [
    '',
    'not a certificate',
    leaf,
    `${ca}\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----`,
    `${ca}\nextra text`,
  ])
    assert.throws(() => validateServingCaBundle(rejected), /aws_serving_ca_bundle_invalid/u);
});

for (const entry of ['lambda', 'browser-sp']) {
  test(`${entry} ZIP contains only its entry and the verified CA, with matching hashes and reproducible bytes`, async () => {
    const receipt = await packageServingArtifact({
      entry,
      outputDirectory: directory,
      caBundlePath: caPath,
    });
    const archivePath = join(directory, `${entry}.zip`);
    const archive = await readFile(archivePath);
    const listing = (await execute('unzip', ['-Z', '-1', archivePath])).stdout.trim().split('\n');
    assert.deepEqual(listing, [`${entry}.mjs`, 'certs/rds-ca.pem'].sort());
    assert.equal((await execute('unzip', ['-p', archivePath, 'certs/rds-ca.pem'])).stdout, ca);
    assert.deepEqual(receipt.files, listing);
    assert.equal(receipt.caBundleSha256, createHash('sha256').update(ca).digest('hex'));
    assert.equal(receipt.sha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(receipt.size, archive.length);
    assert.equal(receipt.handler, `${entry}.handler`);
    assert.equal(receipt.runtime, 'nodejs24.x');
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, `${entry}-artifact.json`), 'utf8')),
      receipt
    );
    const repeated = await packageServingArtifact({
      entry,
      outputDirectory: directory,
      caBundlePath: caPath,
    });
    assert.equal(repeated.sha256, receipt.sha256);
    assert.deepEqual(await readFile(archivePath), archive);
  });
}

test('unapproved entries cannot be packaged', async () => {
  await assert.rejects(
    packageServingArtifact({
      entry: 'db-bootstrap',
      outputDirectory: directory,
      caBundlePath: caPath,
    }),
    /aws_serving_entry_invalid/u
  );
});
