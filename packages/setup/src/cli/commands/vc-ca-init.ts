import { X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { writePrivateFileAtomically } from '../../core/atomic-file.js';
import { AuthrimConfigSchema } from '../../core/config.js';
import { resolveDownstreamIntrospectionKeysDir } from '../../core/downstream-introspection-deploy.js';
import { ADMIN_UI_BFF_PRIVATE_KEY_FILE } from '../../core/admin-machine-access.js';
import {
  findAuthrimBaseDir,
  findLegacyConfigPath,
  getEnvironmentPaths,
  validateEnvName,
} from '../../core/paths.js';
import { SECRET_KEY_FILES } from '../../core/secrets.js';
import {
  DEFAULT_ISSUING_CA_YEARS,
  DEFAULT_ROOT_CA_YEARS,
  certificatePemToDer,
  generateVcCa,
  mergeIssuingCaFingerprints,
  sha256Hex,
  type VcCaMaterial,
} from '../../core/vc-issuing-ca.js';
import { getDeployKeysDirHint } from './deploy.js';

/** File names in the environment's keys directory. The first three are uploaded by deploy. */
export const VC_CA_FILES = {
  issuingPrivateKey: 'vc_issuing_ca_private.pem',
  issuingCertificate: 'vc_issuing_ca_certificate.b64.txt',
  issuingFingerprints: 'vc_x5c_issuing_ca_sha256.txt',
  rootCertificate: 'vc_root_ca_certificate.pem',
  rootPrivateKey: 'vc_root_ca_private.pem',
} as const;

export interface VcCaInitOptions {
  env?: string;
  keysDir?: string;
  /** Issue a new issuing CA under this existing root key (PKCS#8 PEM). */
  rootKey?: string;
  /** The certificate of that root; default: the one in the keys directory. */
  rootCertificate?: string;
  /** Where a newly created root private key is written. Default: the keys directory. */
  rootKeyOut?: string;
  organization?: string;
  rootCaYears?: string;
  issuingCaYears?: string;
  /** Replace an existing issuing CA (its files are kept as timestamped backups). Needs --root-key. */
  force?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** For tests: the directory commands are run from. */
  cwd?: string;
}

export interface VcCaInitResult {
  keysDir: string;
  createdRoot: boolean;
  /** Where the root private key was written, when a root was created. */
  rootKeyPath?: string;
  written: string[];
  backedUp: string[];
  fingerprints: string;
  material: Pick<
    VcCaMaterial,
    'rootCertificateSha256' | 'issuingCertificateSha256' | 'issuingNotAfter' | 'rootNotAfter'
  >;
}

function parseYears(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const years = Number(value);
  if (!Number.isFinite(years)) throw new Error(`vc_ca_${name}_invalid`);
  return years;
}

/**
 * The keys directory exactly as `deploy` finds it, so what is written here is what deploy reads:
 * an explicit `--keys-dir`, else the configured `keys.secretsPath`, else the environment's
 * external (`.authrim-keys/<env>`), internal or legacy directory.
 */
export async function resolveVcCaKeysDir(input: {
  env: string;
  keysDir?: string;
  cwd?: string;
}): Promise<string> {
  if (!validateEnvName(input.env)) throw new Error('vc_ca_environment_invalid');
  const cwd = input.cwd ?? process.cwd();
  const baseDir = findAuthrimBaseDir(cwd);
  let configuredKeysDir: string | undefined;
  // The same places deploy reads, canonical first and then the legacy file. A config that exists
  // but cannot be read is an error: guessing another directory could leave the CA where deploy
  // does not look.
  for (const searchDir of [baseDir, join(baseDir, 'authrim')]) {
    const candidates = [
      getEnvironmentPaths({ baseDir: searchDir, env: input.env }).config,
      findLegacyConfigPath(searchDir, input.env),
    ];
    const configPath = candidates.find((candidate) => existsSync(candidate));
    if (!configPath) continue;
    try {
      configuredKeysDir = AuthrimConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
        .keys.secretsPath;
    } catch {
      throw new Error('vc_ca_config_unreadable');
    }
    break;
  }
  return resolveDownstreamIntrospectionKeysDir({
    env: input.env,
    rootDir: baseDir,
    keysDir: getDeployKeysDirHint({
      baseDir,
      explicitKeysDir: input.keysDir,
      configuredKeysDir,
    }),
    keysBaseDir: cwd,
  });
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A timestamp for backup names, so a backup is never overwritten by the next one. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '');
}

/**
 * Creates the Authrim CA for HAIP `x5c` and writes it to the keys directory, where deploy picks
 * up the issuing CA key, its certificate and the fingerprint list and uploads them as Worker
 * secrets. Returns what it did; never prints the private keys.
 *
 * Safety rules: an existing CA of any kind (even a partial one) is never overwritten without
 * `--force` and the existing root key; a replacement keeps the root the environment already trusts;
 * a new root private key is written to a path that does not exist and that deploy never reads.
 */
export async function runVcCaInit(options: VcCaInitOptions): Promise<VcCaInitResult> {
  const env = options.env ?? 'prod';
  const keysDir = await resolveVcCaKeysDir({ env, keysDir: options.keysDir, cwd: options.cwd });
  if (options.dryRun) return runLocked(options, env, keysDir);
  // One initialisation per keys directory at a time: the checks below and the writes must not
  // interleave with another run's.
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const lockPath = join(keysDir, '.vc-ca-init.lock');
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('vc_ca_locked');
    throw error;
  }
  try {
    return await runLocked(options, env, keysDir);
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function runLocked(
  options: VcCaInitOptions,
  env: string,
  keysDir: string
): Promise<VcCaInitResult> {
  const path = (name: string): string => join(keysDir, name);
  const issuingKeyPath = path(VC_CA_FILES.issuingPrivateKey);
  const issuingCertificatePath = path(VC_CA_FILES.issuingCertificate);
  const fingerprintsPath = path(VC_CA_FILES.issuingFingerprints);
  const rootCertificatePath = path(VC_CA_FILES.rootCertificate);

  // Any CA file counts: a partial restore must be recovered on purpose, not overwritten.
  const existing = [
    issuingKeyPath,
    issuingCertificatePath,
    fingerprintsPath,
    rootCertificatePath,
  ].filter(exists);
  if (existing.length > 0 && !(options.force && options.rootKey)) {
    throw new Error(options.force ? 'vc_ca_root_key_required' : 'vc_ca_exists');
  }
  if (options.force && !options.rootKey) throw new Error('vc_ca_root_key_required');

  let root: { privateKeyPem: string; certificateDer: Uint8Array } | undefined;
  if (options.rootKey) {
    const certificatePath = options.rootCertificate
      ? resolve(options.rootCertificate)
      : rootCertificatePath;
    if (!exists(options.rootKey) || !exists(certificatePath)) {
      throw new Error('vc_ca_root_files_not_found');
    }
    root = {
      privateKeyPem: await readFile(options.rootKey, 'utf8'),
      certificateDer: certificatePemToDer(await readFile(certificatePath, 'utf8')),
    };
    // The root must be the one this environment already trusts, not another environment's.
    if (exists(rootCertificatePath)) {
      const saved = sha256Hex(certificatePemToDer(await readFile(rootCertificatePath, 'utf8')));
      if (saved !== sha256Hex(root.certificateDer))
        throw new Error('vc_ca_root_differs_from_saved');
    }
  }

  // Recovering from a partial state: a surviving issuing CA certificate must belong to the root
  // given, or already distributed chains would stop verifying; and its fingerprint stays trusted
  // even when the fingerprint list was lost.
  let oldIssuingFingerprint: string | undefined;
  if (root && exists(issuingCertificatePath)) {
    try {
      const oldDer = Buffer.from((await readFile(issuingCertificatePath, 'utf8')).trim(), 'base64');
      const rootX509 = new X509Certificate(Buffer.from(root.certificateDer));
      if (!new X509Certificate(oldDer).verify(rootX509.publicKey)) {
        throw new Error('vc_ca_root_does_not_match_issuing');
      }
      oldIssuingFingerprint = sha256Hex(new Uint8Array(oldDer));
    } catch (error) {
      if (error instanceof Error && error.message === 'vc_ca_root_does_not_match_issuing')
        throw error;
      throw new Error('vc_ca_existing_issuing_unreadable');
    }
  }

  const material = await generateVcCa({
    environment: env,
    organization: options.organization,
    root,
    rootYears: parseYears(options.rootCaYears, DEFAULT_ROOT_CA_YEARS, 'root_years'),
    issuingYears: parseYears(options.issuingCaYears, DEFAULT_ISSUING_CA_YEARS, 'issuing_years'),
  });

  const previousFingerprints = exists(fingerprintsPath)
    ? await readFile(fingerprintsPath, 'utf8')
    : undefined;
  const fingerprints = mergeIssuingCaFingerprints(
    material.issuingCertificateSha256,
    [previousFingerprints, oldIssuingFingerprint].filter(Boolean).join(',')
  );

  const createdRoot = material.rootPrivateKeyPem !== undefined;
  const rootKeyPath = createdRoot
    ? options.rootKeyOut
      ? resolve(options.rootKeyOut)
      : path(VC_CA_FILES.rootPrivateKey)
    : undefined;
  if (rootKeyPath) {
    // The root key must not land on a file deploy uploads or on one this command writes, and it
    // must be a new file: never over an existing key, certificate or link.
    // Names (in any directory: another environment's keys directory is deploy input too, and a
    // symlinked parent can lead back here) of files deploy reads or this command writes.
    const reservedNames = new Set<string>([
      ...Object.values(SECRET_KEY_FILES).filter((name): name is string => Boolean(name)),
      ADMIN_UI_BFF_PRIVATE_KEY_FILE,
      'setup_token.txt',
      'setup_machine_private.pem',
      VC_CA_FILES.issuingPrivateKey,
      VC_CA_FILES.issuingCertificate,
      VC_CA_FILES.issuingFingerprints,
      VC_CA_FILES.rootCertificate,
    ]);
    if (reservedNames.has(basename(rootKeyPath))) throw new Error('vc_ca_root_key_out_reserved');
    const realParent = (() => {
      try {
        return realpathSync(dirname(rootKeyPath));
      } catch {
        return undefined;
      }
    })();
    const realKeysDir = (() => {
      try {
        return realpathSync(keysDir);
      } catch {
        return resolve(keysDir);
      }
    })();
    // Inside the keys directory only the default root key name is allowed.
    if (
      (realParent === realKeysDir || dirname(rootKeyPath) === resolve(keysDir)) &&
      basename(rootKeyPath) !== VC_CA_FILES.rootPrivateKey
    ) {
      throw new Error('vc_ca_root_key_out_reserved');
    }
    if (exists(rootKeyPath)) throw new Error('vc_ca_root_key_out_exists');
  }

  // A root supplied from outside is remembered by its certificate, so later renewals can be
  // checked against it.
  const savesRootCertificate = createdRoot || !exists(rootCertificatePath);
  const written = [
    issuingKeyPath,
    issuingCertificatePath,
    fingerprintsPath,
    ...(savesRootCertificate ? [rootCertificatePath] : []),
    ...(rootKeyPath ? [rootKeyPath] : []),
  ];
  const backedUp: string[] = [];

  if (!options.dryRun) {
    const when = stamp(new Date());
    // 1. Keep the previous generation, under names that are never reused.
    for (const [file, mode] of [
      [issuingKeyPath, 0o600],
      [issuingCertificatePath, 0o644],
      [fingerprintsPath, 0o644],
    ] as const) {
      if (!exists(file)) continue;
      let backup = `${file}.bak-${when}`;
      for (let attempt = 1; exists(backup); attempt += 1) backup = `${file}.bak-${when}-${attempt}`;
      await writePrivateFileAtomically(backup, await readFile(file, 'utf8'), mode, {
        exclusive: true,
      });
      backedUp.push(backup);
    }
    // 2. The root first (a new root key is the one thing that cannot be recreated), then the
    //    issuing CA key, then what deploy reads to decide: the certificate and the fingerprints.
    if (rootKeyPath && material.rootPrivateKeyPem) {
      await mkdir(dirname(rootKeyPath), { recursive: true, mode: 0o700 });
      try {
        await writePrivateFileAtomically(rootKeyPath, material.rootPrivateKeyPem, 0o600, {
          exclusive: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('vc_ca_root_key_out_exists');
        }
        throw error;
      }
    }
    if (savesRootCertificate) {
      await writePrivateFileAtomically(rootCertificatePath, material.rootCertificatePem, 0o644);
    }
    await writePrivateFileAtomically(issuingKeyPath, material.issuingPrivateKeyPem, 0o600);
    await writePrivateFileAtomically(
      issuingCertificatePath,
      `${material.issuingCertificateBase64}\n`,
      0o644
    );
    await writePrivateFileAtomically(fingerprintsPath, `${fingerprints}\n`, 0o644);
  }

  return {
    keysDir,
    createdRoot,
    ...(rootKeyPath ? { rootKeyPath } : {}),
    written,
    backedUp,
    fingerprints,
    material: {
      rootCertificateSha256: material.rootCertificateSha256,
      issuingCertificateSha256: material.issuingCertificateSha256,
      issuingNotAfter: material.issuingNotAfter,
      rootNotAfter: material.rootNotAfter,
    },
  };
}

const ERROR_HINTS: Record<string, string> = {
  vc_ca_exists:
    'CA files already exist in the keys directory. To replace the issuing CA, pass --force together with --root-key (and --root-certificate) of the existing root.',
  vc_ca_root_key_required:
    'Replacing or recovering the CA needs the root key, so the trust anchor stays the same. Pass --force --root-key <file> (the offline root private key).',
  vc_ca_root_files_not_found:
    'The root key or its certificate was not found. Pass --root-key and --root-certificate (default: vc_root_ca_certificate.pem in the keys directory).',
  vc_ca_root_differs_from_saved:
    'That root certificate is not the one saved for this environment (vc_root_ca_certificate.pem). It may belong to another environment.',
  vc_ca_root_key_mismatch: 'The root private key does not belong to the root certificate.',
  vc_ca_root_not_a_ca: 'The root certificate is not a CA certificate.',
  vc_ca_root_not_valid_now: 'The root certificate is expired or not yet valid.',
  vc_ca_root_expires_too_soon: 'The root certificate expires too soon to issue a new issuing CA.',
  vc_ca_root_key_out_reserved:
    'The root key output path is a file this command or deploy uses. Choose a different --root-key-out, ideally outside the keys directory.',
  vc_ca_root_key_out_exists: 'The root key output path already exists; it is never overwritten.',
  vc_ca_environment_invalid: 'The environment name is not valid.',
  vc_ca_locked:
    'Another vc-ca-init is running, or one was interrupted. If none is running, delete .vc-ca-init.lock in the keys directory and check the files before retrying.',
  vc_ca_config_unreadable:
    'The environment config exists but could not be read, so the keys directory is unknown. Fix it, or pass --keys-dir.',
  vc_ca_root_path_length:
    'The root certificate does not allow a subordinate CA (pathLenConstraint 0). Use a root that does.',
  vc_ca_root_does_not_match_issuing:
    'The saved issuing CA certificate was not issued by this root. Use the root key and certificate that issued it.',
  vc_ca_existing_issuing_unreadable:
    'The saved issuing CA certificate could not be read, so its trust cannot be kept. Restore it or remove the CA files on purpose first.',
  vc_ca_too_many_fingerprints:
    'The trusted issuing CA list is full (8). Remove fingerprints of retired issuing CAs from vc_x5c_issuing_ca_sha256.txt first.',
};

export async function vcCaInitCommand(options: VcCaInitOptions): Promise<void> {
  try {
    if (!options.yes && !options.dryRun) {
      console.log(chalk.bold('\nAuthrim CA for HAIP x5c'));
      console.log(
        chalk.gray(
          options.rootKey
            ? 'A new issuing CA will be issued under your existing root.'
            : 'A new root CA and an issuing CA will be created. The root private key must then be moved offline.'
        )
      );
      const proceed = await confirm({ message: 'Continue?', default: true });
      if (!proceed) return;
    }
    const result = await runVcCaInit(options);
    const label = options.dryRun ? 'Would write' : 'Wrote';
    console.log(chalk.green(`\n${label}:`));
    for (const file of result.written) console.log(`  ${file}`);
    if (result.backedUp.length > 0) {
      console.log(chalk.gray('Previous files kept as:'));
      for (const file of result.backedUp) console.log(`  ${file}`);
    }
    console.log(`\nIssuing CA certificate SHA-256: ${result.material.issuingCertificateSha256}`);
    console.log(`Trusted issuing CA fingerprints: ${result.fingerprints}`);
    console.log(
      `Issuing CA valid until:          ${result.material.issuingNotAfter.toISOString()}`
    );
    if (result.createdRoot && result.rootKeyPath) {
      console.log(chalk.yellow('\nNext steps'));
      console.log(
        `  1. Move the root private key to offline storage and delete it from this machine:`
      );
      console.log(`       ${result.rootKeyPath}`);
      console.log(
        '     It is needed only to issue the next issuing CA (--root-key), and it is never uploaded.'
      );
      console.log(
        `  2. Give ${VC_CA_FILES.rootCertificate} (root SHA-256 ${result.material.rootCertificateSha256})`
      );
      console.log('     to the wallets and verifiers that should trust your credentials.');
      console.log(
        '  3. Deploy: authrim-setup deploy --env <name> uploads the issuing CA to the credential issuer.'
      );
    } else {
      console.log(chalk.yellow('\nNext step'));
      console.log('  Deploy: authrim-setup deploy --env <name> uploads the new issuing CA.');
      console.log(
        '  Previous issuing CAs stay trusted until you remove their fingerprints from the list file.'
      );
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`vc-ca-init failed: ${ERROR_HINTS[code] ?? code}`));
    process.exitCode = 1;
  }
}
