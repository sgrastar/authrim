/**
 * Software CA for the provider signing chains (staging; production uses the hardware root, see
 * docs/verifiable-credentials/20261124-haip-ca-with-hardware-root.md). One root, two intermediates
 * (wallet attestation, key attestation), and short-lived P-256 leaf certificates.
 *
 * Everything goes through the `openssl` binary. Private keys stay in files (mode 0600) inside a
 * directory the operator chooses OUTSIDE the repository; nothing here prints key material.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Purpose = 'wallet' | 'key';

const PURPOSE_NAMES: Record<Purpose, string> = {
  wallet: 'Wallet Attestation CA',
  key: 'Key Attestation CA',
};

function openssl(args: string[], input?: Buffer | string): Buffer {
  return execFileSync('openssl', args, {
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

function serial(): string {
  // Positive, 16 random bytes (first nibble forced to 1).
  return `0x1${hex(randomBytes(15))}`;
}

/** Leaf validity limit of the design (section 7): bounds what a leaked leaf key can forge. */
export const MAX_LEAF_DAYS = 30;

/** Creates a new 0600 file; an existing path (also a symlink) is refused. */
export function writeSecretFile(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}

/** Refuses a path inside a git working tree (secrets must not be one `git add` away). */
export function assertOutsideRepo(path: string): void {
  let probe = resolve(path);
  while (!existsSync(probe)) probe = dirname(probe);
  let dir = realpathSync(probe);
  for (;;) {
    if (existsSync(join(dir, '.git'))) throw new Error(`${path} is inside a git repository`);
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The CA directory must be a real directory we own that nobody else can enter or change. */
function assertPrivateDir(dir: string): void {
  const stat = lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`${dir} must be a directory owned by you with mode 0700`);
  }
}

function newKey(path: string): void {
  const pem = openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256']);
  writeSecretFile(path, pem);
}

function csr(keyPath: string, subject: string): Buffer {
  return openssl(['req', '-new', '-key', keyPath, '-subj', `/CN=${subject}`, '-sha256']);
}

function sign(input: {
  csrPem: Buffer;
  caCert: string;
  caKey: string;
  days: number;
  extensions: string;
  extFile: string;
}): Buffer {
  writeSecretFile(input.extFile, input.extensions);
  try {
    return openssl(
      [
        'x509',
        '-req',
        '-CA',
        input.caCert,
        '-CAkey',
        input.caKey,
        '-sha256',
        '-days',
        String(input.days),
        '-set_serial',
        serial(),
        '-extfile',
        input.extFile,
      ],
      input.csrPem
    );
  } finally {
    rmSync(input.extFile, { force: true });
  }
}

function der(certPem: string): Buffer {
  return openssl(['x509', '-in', certPem, '-outform', 'DER']);
}

export function sha256Hex(bytes: Buffer): string {
  return hex(createHash('sha256').update(bytes).digest());
}

export interface InitResult {
  rootSha256: string;
  walletIntermediateSha256: string;
  keyIntermediateSha256: string;
}

const CA_EXT =
  'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n';
const LEAF_EXT = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n';

/** Creates the root and both intermediates. Refuses to overwrite an existing CA directory. */
export function initCa(input: { dir: string; label: string; rootDays?: number }): InitResult {
  const dir = resolve(input.dir);
  if (existsSync(join(dir, 'root.pem'))) throw new Error(`a CA already exists in ${dir}`);
  assertOutsideRepo(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir);
  const rootKey = join(dir, 'root.key');
  const rootPem = join(dir, 'root.pem');
  newKey(rootKey);
  const rootCert = openssl([
    'req',
    '-new',
    '-x509',
    '-key',
    rootKey,
    '-sha256',
    '-days',
    String(input.rootDays ?? 3650),
    '-subj',
    `/CN=Authrim Wallet Provider Root (${input.label})`,
    '-set_serial',
    serial(),
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:1',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  writeSecretFile(rootPem, rootCert);
  const hashes: Record<Purpose, string> = { wallet: '', key: '' };
  for (const purpose of ['wallet', 'key'] as const) {
    const key = join(dir, `${purpose}-intermediate.key`);
    const pem = join(dir, `${purpose}-intermediate.pem`);
    newKey(key);
    const subject = `Authrim ${PURPOSE_NAMES[purpose]} (${input.label})`;
    writeSecretFile(
      pem,
      sign({
        csrPem: csr(key, subject),
        caCert: rootPem,
        caKey: rootKey,
        days: 1825,
        extensions: CA_EXT,
        extFile: join(dir, 'ext.tmp'),
      })
    );
    hashes[purpose] = sha256Hex(der(pem));
  }
  return {
    rootSha256: sha256Hex(der(rootPem)),
    walletIntermediateSha256: hashes.wallet,
    keyIntermediateSha256: hashes.key,
  };
}

/**
 * Issues a leaf for one purpose and returns the signer secret JSON
 * `{"privateKeyPkcs8","chain":[leaf, intermediate]}` (base64 DER). The caller must not print it.
 */
export function issueSignerSecret(input: { dir: string; purpose: Purpose; days: number }): {
  secret: string;
  intermediateSha256: string;
} {
  const dir = resolve(input.dir);
  const interKey = join(dir, `${input.purpose}-intermediate.key`);
  const interPem = join(dir, `${input.purpose}-intermediate.pem`);
  assertOutsideRepo(dir);
  assertPrivateDir(dir);
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_LEAF_DAYS) {
    throw new Error(`days must be 1..${MAX_LEAF_DAYS}`);
  }
  if (!existsSync(interKey) || !existsSync(interPem)) throw new Error('run init first');
  const work = join(dir, `.leaf-${hex(randomBytes(4))}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const leafKey = join(work, 'leaf.key');
    newKey(leafKey);
    const leafPem = join(work, 'leaf.pem');
    writeSecretFile(
      leafPem,
      sign({
        csrPem: csr(leafKey, `Authrim ${PURPOSE_NAMES[input.purpose]} leaf`),
        caCert: interPem,
        caKey: interKey,
        days: input.days,
        extensions: LEAF_EXT,
        extFile: join(work, 'ext.tmp'),
      })
    );
    const pkcs8 = openssl(['pkcs8', '-topk8', '-nocrypt', '-in', leafKey, '-outform', 'DER']);
    const interDer = der(interPem);
    return {
      secret: JSON.stringify({
        privateKeyPkcs8: b64(pkcs8),
        chain: [b64(der(leafPem)), b64(interDer)],
      }),
      intermediateSha256: sha256Hex(interDer),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function readPin(dir: string, purpose: Purpose): string {
  return sha256Hex(der(join(resolve(dir), `${purpose}-intermediate.pem`)));
}

export function intermediateBase64(dir: string, purpose: Purpose): string {
  return readFileSync(join(resolve(dir), `${purpose}-intermediate.pem`), 'utf8');
}
