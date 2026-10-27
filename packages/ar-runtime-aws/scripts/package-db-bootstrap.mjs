import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--ca-bundle') {
  throw new Error('usage: package-db-bootstrap.mjs --ca-bundle <AWS RDS root CA bundle>');
}
const ca = await readFile(resolve(args[1]), 'utf8');
const pemCertificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu);
if (!pemCertificates?.length) throw new Error('aws_db_bootstrap_ca_bundle_invalid');
for (const pem of pemCertificates) {
  const cert = new X509Certificate(pem);
  if (!cert.ca || cert.subject !== cert.issuer || Date.parse(cert.validTo) <= Date.now()) {
    throw new Error('aws_db_bootstrap_ca_bundle_invalid');
  }
}
const output = join(root, 'dist');
const temporary = await mkdtemp(join(tmpdir(), 'authrim-db-bootstrap-package-'));
try {
  const files = [];
  const add = async (source, target) => {
    const path = join(temporary, target);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(source, path);
    await utimes(path, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    files.push(target);
  };
  await add(join(output, 'db-bootstrap.mjs'), 'db-bootstrap.mjs');
  await add(resolve(args[1]), 'certs/rds-ca.pem');
  for (const name of (await readdir(join(root, 'src/storage'))).sort()) {
    if (name.endsWith('.sql')) await add(join(root, 'src/storage', name), `storage/${name}`);
  }
  for (const family of ['core', 'pii']) {
    const folder = resolve(root, '../../migrations', family, 'postgresql');
    const names = (await readdir(folder))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    if (!names.length) throw new Error('aws_db_bootstrap_migrations_missing');
    for (const name of names) {
      await add(join(folder, name), `migrations/${family}/postgresql/${name}`);
    }
  }
  files.sort();
  let uncompressedSize = 0;
  for (const file of files) uncompressedSize += (await stat(join(temporary, file))).size;
  if (uncompressedSize > 64 * 1024 * 1024) throw new Error('aws_db_bootstrap_artifact_too_large');
  await execute('zip', ['-X', '-q', join(temporary, 'db-bootstrap.zip'), ...files], {
    cwd: temporary,
  });
  const archive = await readFile(join(temporary, 'db-bootstrap.zip'));
  const receipt = {
    formatVersion: 1,
    handler: 'db-bootstrap.handler',
    runtime: 'nodejs24.x',
    file: 'db-bootstrap.zip',
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
    uncompressedSize,
    caBundleSha256: createHash('sha256').update(ca).digest('hex'),
    files,
  };
  await copyFile(join(temporary, 'db-bootstrap.zip'), join(output, 'db-bootstrap.zip'));
  await writeFile(
    join(output, 'db-bootstrap-artifact.json'),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
