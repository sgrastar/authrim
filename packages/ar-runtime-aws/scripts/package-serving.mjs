import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const execute = promisify(execFile);
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const ZIP_TIME = new Date('2000-01-01T00:00:00Z');

export function parseServingPackageArguments(args) {
  if (args.length !== 2 || args[0] !== '--ca-bundle' || !args[1]) {
    throw new Error('usage: package-serving --ca-bundle <AWS RDS root CA bundle>');
  }
  return { caBundlePath: resolve(args[1]) };
}

/** Supplied CA roots are explicit operator input; never fetch trust material while packaging. */
export function validateServingCaBundle(ca) {
  try {
    if (typeof ca !== 'string' || ca.length > 1024 * 1024) throw new Error();
    const certificates = ca.match(PEM);
    if (!certificates?.length || ca.replace(PEM, '').trim()) throw new Error();
    for (const pem of certificates) {
      const cert = new X509Certificate(pem);
      if (
        !cert.ca ||
        cert.subject !== cert.issuer ||
        !cert.verify(cert.publicKey) ||
        Date.parse(cert.validFrom) > Date.now() ||
        Date.parse(cert.validTo) <= Date.now()
      )
        throw new Error();
    }
  } catch {
    throw new Error('aws_serving_ca_bundle_invalid');
  }
}

/** The explicit allow-list prevents SQL, source maps, fixture data and keys entering serving ZIPs. */
export async function packageServingArtifact({ entry, outputDirectory, caBundlePath }) {
  if (!['lambda', 'browser-sp'].includes(entry)) throw new Error('aws_serving_entry_invalid');
  const ca = await readFile(caBundlePath, 'utf8');
  validateServingCaBundle(ca);
  const temporary = await mkdtemp(join(tmpdir(), 'authrim-serving-package-'));
  try {
    const files = [`${entry}.mjs`, 'certs/rds-ca.pem'].sort();
    for (const file of files) {
      const destination = join(temporary, file);
      await mkdir(dirname(destination), { recursive: true });
      if (file === 'certs/rds-ca.pem') await writeFile(destination, ca);
      else await copyFile(join(outputDirectory, file), destination);
      await utimes(destination, ZIP_TIME, ZIP_TIME);
    }
    let uncompressedSize = 0;
    for (const file of files) uncompressedSize += (await stat(join(temporary, file))).size;
    if (uncompressedSize > 64 * 1024 * 1024) throw new Error('aws_lambda_artifact_too_large');
    const zip = join(temporary, `${entry}.zip`);
    await execute('zip', ['-X', '-q', zip, ...files], { cwd: temporary });
    const archive = await readFile(zip);
    const receipt = {
      formatVersion: 1,
      handler: `${entry}.handler`,
      runtime: 'nodejs24.x',
      file: `${entry}.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.length,
      uncompressedSize,
      caBundleSha256: createHash('sha256').update(ca).digest('hex'),
      files,
    };
    await copyFile(zip, join(outputDirectory, `${entry}.zip`));
    await writeFile(
      join(outputDirectory, `${entry}-artifact.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
