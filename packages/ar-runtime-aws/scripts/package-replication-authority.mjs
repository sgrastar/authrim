import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateServingCaBundle } from './package-serving.mjs';
import { readSetupFile } from './setup-execution-state.mjs';

const execute = promisify(execFile);
const ENTRY = 'replication-authority';
const ZIP_TIME = new Date('2000-01-01T00:00:00Z');

/** Dedicated allow-list: runtime and public CA only; never package schema initialization or credentials. */
export async function packageReplicationAuthority({ outputDirectory, caBundlePath }) {
  const ca = (await readSetupFile(caBundlePath, { maxBytes: 1024 * 1024 })).toString('utf8');
  validateServingCaBundle(ca);
  const bundle = await readSetupFile(join(outputDirectory, `${ENTRY}.mjs`), {
    maxBytes: 64 * 1024 * 1024,
  });
  if (bundle.length + Buffer.byteLength(ca) > 64 * 1024 * 1024)
    throw new Error('replication_authority_artifact_too_large');
  const temporary = await mkdtemp(join(tmpdir(), 'authrim-authority-package-'));
  try {
    await mkdir(join(temporary, 'certs'));
    await writeFile(join(temporary, `${ENTRY}.mjs`), bundle);
    await writeFile(join(temporary, 'certs/rds-ca.pem'), ca);
    const files = ['certs/rds-ca.pem', `${ENTRY}.mjs`];
    for (const file of files) await utimes(join(temporary, file), ZIP_TIME, ZIP_TIME);
    const archivePath = join(temporary, `${ENTRY}.zip`);
    await execute('zip', ['-X', '-q', archivePath, ...files], { cwd: temporary });
    const archive = await readFile(archivePath);
    const receipt = {
      formatVersion: 1,
      handler: `${ENTRY}.handler`,
      runtime: 'nodejs24.x',
      file: `${ENTRY}.zip`,
      files,
      size: archive.length,
      uncompressedSize: bundle.length + Buffer.byteLength(ca),
      sha256: createHash('sha256').update(archive).digest('hex'),
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      caBundleSha256: createHash('sha256').update(ca).digest('hex'),
    };
    await writeFile(join(outputDirectory, `${ENTRY}.zip`), archive);
    await writeFile(
      join(outputDirectory, `${ENTRY}-artifact.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parseReplicationPackageArguments(args) {
  if (args.length !== 2 || args[0] !== '--ca-bundle' || !args[1] || args[1].startsWith('--'))
    throw new Error('replication_authority_package_arguments_invalid');
  return { caBundlePath: resolve(args[1]) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageReplicationAuthority({
    outputDirectory: fileURLToPath(new URL('../dist/', import.meta.url)),
    ...parseReplicationPackageArguments(process.argv.slice(2)),
  })
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch(() => {
      process.stderr.write('replication_authority_package_failed\n');
      process.exitCode = 2;
    });
}
