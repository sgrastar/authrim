/**
 * Authrim Key Generation Module
 *
 * Generates RSA key pairs for JWT signing and other cryptographic secrets.
 * Based on the existing setup-keys.sh script functionality.
 *
 * Supports external (.authrim-keys/{env}/), internal (.authrim/{env}/keys/),
 * and legacy (.keys/{env}/) key storage structures.
 */

import { randomBytes, generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto';
import { writeFile, mkdir, readFile, chmod, rm, rename, open, rmdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  getLegacyPaths,
  findKeysDirectory,
  resolvePaths,
  type EnvironmentPaths,
  type LegacyPaths,
} from './paths.js';

export const DEFAULT_RSA_SIGNING_KEY_BITS = 3072;

// =============================================================================
// Types
// =============================================================================

/**
 * JSON Web Key structure (subset of W3C spec for RSA keys)
 */
export interface JWK {
  kty: string;
  n?: string;
  e?: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

export interface KeyPair {
  /** Private key in PEM format */
  privateKeyPem: string;
  /** Public key in JWK format */
  publicKeyJwk: JWK;
  /** Key ID (kid) */
  keyId: string;
  /** Creation timestamp */
  createdAt: string;
}

export interface JwkKeyPair {
  privateJwk: JWK;
  publicJwk: JWK;
  keyId: string;
  createdAt: string;
}

export interface KeyMetadata {
  kid: string;
  algorithm: string;
  keySize: number;
  createdAt: string;
  files: {
    privateKey: string;
    publicKey: string;
    rpTokenEncryptionKey?: string;
    piiEncryptionKey?: string;
    objectEncryptionRootKey?: string;
    otpHmacSecret?: string;
    loggingCursorHmacSecret?: string;
    lookupHmacKeySlotA?: string;
    flowRuntimeHmacSecret?: string;
    vcTransactionCodeHmacSecret?: string;
    vcEvidenceHmacSecret?: string;
    vcProfileContractHmacSecret?: string;
    pluginEncryptionKey?: string;
    pluginMutationHmacKey?: string;
    notificationPayloadDecryptJwkSlotA?: string;
    notificationPayloadDecryptJwkSlotB?: string;
    notificationPayloadEncryptPublicJwks?: string;
    notificationIntentHmacKey?: string;
    agentElevationEncryptionKey?: string;
    setupMachinePrivateKey?: string;
    setupMachinePublicKey?: string;
    adminUiBffPrivateKey?: string;
    adminUiBffPublicKey?: string;
    tenantRuntimeRegistrySigningPrivateJwk?: string;
    tenantRuntimeRegistryVerifyingPublicJwks?: string;
    tenantRuntimeRegistrySigningKeyId?: string;
    smokeRpcSigningJwkSlotA?: string;
    smokeRpcSigningJwkSlotB?: string;
    controlSmokeVerifyingPublicJwks?: string;
  };
}

export interface SupplementalKeyFilesResult {
  createdFiles: string[];
}

const LEGACY_STATIC_SECRET_FILES = [
  'admin_api_secret.txt',
  'key_manager_secret.txt',
  'version_manager_secret.txt',
] as const;

const LEGACY_STATIC_SECRET_METADATA_KEYS = [
  'adminApiSecret',
  'keyManagerSecret',
  'versionManagerSecret',
] as const;

export interface GeneratedSecrets {
  /** RSA key pair for JWT signing */
  keyPair: KeyPair;
  /** ES256 key pair for setup tool Admin Machine Access */
  setupMachineKeyPair: KeyPair;
  /** ES256 key pair for Admin UI BFF Admin Machine Access transport auth */
  adminUiBffMachineKeyPair: KeyPair;
  /** Ed25519 key pair for tenant runtime registry snapshots */
  tenantRuntimeRegistryKeyPair: JwkKeyPair;
  /** Dedicated Ed25519 key pair for Control-to-Runtime binding smoke RPCs */
  controlSmokeKeyPair: JwkKeyPair;
  /** RSA-OAEP key pair for short-lived notification payload envelopes */
  notificationPayloadKeyPair: JwkKeyPair;
  /** RP Token encryption key (hex encoded) */
  rpTokenEncryptionKey: string;
  /** PII field encryption key (hex encoded) */
  piiEncryptionKey: string;
  /** Root key for object plane encryption (hex encoded) */
  objectEncryptionRootKey: string;
  /** HMAC secret for OTP and TOTP backup-code hashing */
  otpHmacSecret: string;
  /** HMAC secret for opaque logging Admin API cursors */
  loggingCursorHmacSecret: string;
  /** Dedicated HMAC key for Lookup blind indexes (initial active slot). */
  lookupHmacKeySlotA: string;
  /** HMAC secret for LoginUI Flow runtime contract signatures */
  flowRuntimeHmacSecret: string;
  /** Dedicated HMAC pepper for low-entropy OpenID4VCI transaction codes */
  vcTransactionCodeHmacSecret?: string;
  /** HMAC key for non-reversible VC verification evidence fingerprints */
  vcEvidenceHmacSecret: string;
  /** Shared HMAC key for Management-to-VC Credential Profile contracts */
  vcProfileContractHmacSecret: string;
  /** Dedicated encryption key for plugin configuration secrets */
  pluginEncryptionKey: string;
  /** Stable HMAC key for plugin mutation idempotency fingerprints */
  pluginMutationHmacKey: string;
  /** HMAC key for notification intent idempotency fingerprints */
  notificationIntentHmacKey: string;
  /** Dedicated AES-256-GCM key for Agent elevation payloads and terminal results. */
  agentElevationEncryptionKey: string;
  /** Setup token for initial admin creation */
  setupToken?: string;
}

// =============================================================================
// Key ID Generation
// =============================================================================

/**
 * Generate a unique key ID (kid)
 *
 * Format: {prefix}-key-{timestamp}-{random}
 */
export function generateKeyId(prefix: string = 'dev'): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const randomStr = randomBytes(4).toString('base64url').slice(0, 6);
  return `${prefix}-key-${timestamp}-${randomStr}`;
}

// =============================================================================
// RSA Key Pair Generation
// =============================================================================

/**
 * Generate an RSA key pair for JWT signing
 *
 * @param keyId - Custom key ID or auto-generated
 * @param keySize - RSA key size in bits (default: 3072)
 */
export function generateRsaKeyPair(
  keyId?: string,
  keySize: number = DEFAULT_RSA_SIGNING_KEY_BITS
): KeyPair {
  const kid = keyId || generateKeyId();

  // Generate RSA key pair
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: keySize,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // Convert public key to JWK format
  const publicKeyObject = createPublicKey({
    key: publicKey,
    format: 'pem',
  });

  const publicJwk = publicKeyObject.export({ format: 'jwk' }) as JWK;

  // Add standard JWK properties
  const jwkWithMetadata: JWK = {
    ...publicJwk,
    kid,
    use: 'sig',
    alg: 'RS256',
  };

  return {
    privateKeyPem: privateKey,
    publicKeyJwk: jwkWithMetadata,
    keyId: kid,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate an ES256 key pair for Admin Machine Access client assertions.
 *
 * The private key is held by the setup tool. Only the public JWK is registered in
 * DB_ADMIN as a machine credential.
 */
export function generateEs256KeyPair(keyId?: string): KeyPair {
  const kid = keyId || generateKeyId('setup');

  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  const publicKeyObject = createPublicKey({
    key: publicKey,
    format: 'pem',
  });

  const publicJwk = publicKeyObject.export({ format: 'jwk' }) as JWK;
  const jwkWithMetadata: JWK = {
    ...publicJwk,
    kid,
    use: 'sig',
    alg: 'ES256',
  };

  return {
    privateKeyPem: privateKey,
    publicKeyJwk: jwkWithMetadata,
    keyId: kid,
    createdAt: new Date().toISOString(),
  };
}

export function generateEd25519JwkKeyPair(keyId?: string): JwkKeyPair {
  const kid = keyId || generateKeyId('tenant-runtime-registry');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateKey.export({ format: 'jwk' }) as JWK;
  const publicJwk = publicKey.export({ format: 'jwk' }) as JWK;
  const metadata = {
    kid,
    use: 'sig',
    alg: 'EdDSA',
  };

  return {
    privateJwk: {
      ...privateJwk,
      ...metadata,
    },
    publicJwk: {
      ...publicJwk,
      ...metadata,
    },
    keyId: kid,
    createdAt: new Date().toISOString(),
  };
}

export function generateRsaOaepJwkKeyPair(
  keyId?: string,
  keySize: number = DEFAULT_RSA_SIGNING_KEY_BITS
): JwkKeyPair {
  const kid = keyId || generateKeyId('notification-payload');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: keySize,
  });
  const metadata = {
    kid,
    use: 'enc',
    alg: 'RSA-OAEP-256',
  };
  return {
    privateJwk: {
      ...(privateKey.export({ format: 'jwk' }) as JWK),
      ...metadata,
      key_ops: ['decrypt'],
    },
    publicJwk: {
      ...(publicKey.export({ format: 'jwk' }) as JWK),
      ...metadata,
      key_ops: ['encrypt'],
    },
    keyId: kid,
    createdAt: new Date().toISOString(),
  };
}

function notificationJwk(value: unknown, privateKey: boolean): JWK {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid notification payload key set');
  }
  const key = value as JWK;
  const operations: unknown[] = Array.isArray(key.key_ops) ? key.key_ops : [];
  const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const;
  if (
    key.kty !== 'RSA' ||
    key.use !== 'enc' ||
    key.alg !== 'RSA-OAEP-256' ||
    typeof key.kid !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(key.kid) ||
    typeof key.n !== 'string' ||
    typeof key.e !== 'string' ||
    operations.length !== 1 ||
    operations[0] !== (privateKey ? 'decrypt' : 'encrypt') ||
    (privateKey
      ? privateFields.some((field) => typeof key[field] !== 'string')
      : privateFields.some((field) => key[field] !== undefined))
  ) {
    throw new Error('Invalid notification payload key set');
  }
  return key;
}

function parseNotificationPrivateJwk(value: string): JWK {
  try {
    return notificationJwk(JSON.parse(value) as unknown, true);
  } catch {
    throw new Error('Invalid notification payload key set');
  }
}

function parseNotificationPublicJwks(value: string): JWK[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
      throw new Error('invalid');
    }
    return (keys as unknown[]).map((key) => notificationJwk(key, false));
  } catch {
    throw new Error('Invalid notification payload key set');
  }
}

function validateNotificationPayloadKeySet(privateJwks: string[], publicJwks: string): void {
  const privateKeys = privateJwks.map(parseNotificationPrivateJwk);
  const publicKeys = parseNotificationPublicJwks(publicJwks);
  const privateKeyIds = new Set(privateKeys.map((key) => key.kid));
  const publicKeyIds = new Set(publicKeys.map((key) => key.kid));
  if (
    privateKeyIds.size !== privateKeys.length ||
    publicKeyIds.size !== publicKeys.length ||
    privateKeyIds.size !== publicKeyIds.size ||
    [...privateKeyIds].some((keyId) => !publicKeyIds.has(keyId))
  ) {
    throw new Error('Invalid notification payload key set');
  }
  for (const privateJwk of privateKeys) {
    try {
      const derived = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({
        format: 'jwk',
      }) as JWK;
      const publicJwk = publicKeys.find((key) => key.kid === privateJwk.kid);
      if (!publicJwk || derived.n !== publicJwk.n || derived.e !== publicJwk.e) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('Invalid notification payload key set');
    }
  }
}

// =============================================================================
// Secret Generation
// =============================================================================

/**
 * Generate a random hex-encoded secret
 *
 * @param bytes - Number of random bytes (default: 32 = 256 bits)
 */
export function generateHexSecret(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a random base64url-encoded secret
 *
 * @param bytes - Number of random bytes (default: 32 = 256 bits)
 */
export function generateBase64Secret(bytes: number = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate all required secrets for Authrim
 */
export function generateAllSecrets(keyId?: string): GeneratedSecrets {
  const keyPair = generateRsaKeyPair(keyId);
  const setupMachineKeyPair = generateEs256KeyPair(`${keyPair.keyId}-setup`);
  const adminUiBffMachineKeyPair = generateEs256KeyPair(`${keyPair.keyId}-admin-ui-bff`);
  const tenantRuntimeRegistryKeyPair = generateEd25519JwkKeyPair(
    `${keyPair.keyId}-tenant-runtime-registry`
  );
  const controlSmokeKeyPair = generateEd25519JwkKeyPair(`${keyPair.keyId}-control-smoke`);
  const notificationPayloadKeyPair = generateRsaOaepJwkKeyPair(
    `${keyPair.keyId}-notification-payload`
  );

  return {
    keyPair,
    setupMachineKeyPair,
    adminUiBffMachineKeyPair,
    tenantRuntimeRegistryKeyPair,
    controlSmokeKeyPair,
    notificationPayloadKeyPair,
    rpTokenEncryptionKey: generateHexSecret(32), // 256-bit key
    piiEncryptionKey: generateHexSecret(32), // 256-bit key
    objectEncryptionRootKey: generateHexSecret(32), // 256-bit key
    otpHmacSecret: generateBase64Secret(32), // 256-bit secret
    loggingCursorHmacSecret: generateBase64Secret(32), // 256-bit secret
    lookupHmacKeySlotA: generateBase64Secret(32), // 256-bit dedicated blind-index key
    flowRuntimeHmacSecret: generateBase64Secret(32), // 256-bit secret
    vcTransactionCodeHmacSecret: generateBase64Secret(32), // 256-bit secret
    vcEvidenceHmacSecret: generateBase64Secret(32), // 256-bit secret
    vcProfileContractHmacSecret: generateBase64Secret(32), // 256-bit secret
    pluginEncryptionKey: generateBase64Secret(32), // 256-bit secret
    pluginMutationHmacKey: generateBase64Secret(32), // 256-bit stable idempotency key
    notificationIntentHmacKey: generateBase64Secret(32), // 256-bit notification fingerprint key
    agentElevationEncryptionKey: generateHexSecret(32), // 256-bit AES-GCM key
    setupToken: generateBase64Secret(32), // 256-bit URL-safe token for initial setup
  };
}

// =============================================================================
// File Operations
// =============================================================================

/**
 * Validate that a directory path is safe for writing keys
 * - Must not contain path traversal patterns
 * - Must be within the current working directory or an absolute path that's safe
 */
function validateKeysDirectory(keysDir: string): void {
  // Reject path traversal patterns
  if (keysDir.includes('..')) {
    throw new Error('Invalid keys directory: path traversal (..) not allowed');
  }
  // Reject null bytes (path truncation attack)
  if (keysDir.includes('\0')) {
    throw new Error('Invalid keys directory: null bytes not allowed');
  }
  // Reject shell metacharacters
  if (/[;&|`$(){}[\]<>!#*?]/.test(keysDir)) {
    throw new Error('Invalid keys directory: shell metacharacters not allowed');
  }

  const absolutePath = resolve(keysDir);
  const cwd = process.cwd();

  // Allow paths within the current working directory (project paths are safe)
  // This allows CI environments like GitHub Actions (/home/runner/work/...)
  if (absolutePath.startsWith(cwd + '/') || absolutePath === cwd) {
    return;
  }

  // Reject absolute paths to system directories (Unix)
  const dangerousPaths = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/root', '/home'];
  for (const dangerous of dangerousPaths) {
    if (absolutePath.startsWith(dangerous + '/') || absolutePath === dangerous) {
      throw new Error(`Invalid keys directory: writing to ${dangerous} is not allowed`);
    }
  }
  // Reject Windows system directories
  const windowsDangerous = ['C:\\Windows', 'C:\\Program Files', 'C:\\System32'];
  for (const dangerous of windowsDangerous) {
    if (absolutePath.toLowerCase().startsWith(dangerous.toLowerCase())) {
      throw new Error('Invalid keys directory: writing to system directories is not allowed');
    }
  }
}

export interface KeysDirectoryOptions {
  /** Use legacy .keys/{env}/ structure instead of .authrim/{env}/keys/ */
  legacy?: boolean;
  /** Base directory for external keys (keys stored at {keysBaseDir}/.authrim-keys/{env}/) */
  keysBaseDir?: string;
}

/**
 * Get environment-specific keys directory path
 *
 * Search order when keysBaseDir is provided:
 * 1. External: {keysBaseDir}/.authrim-keys/{env}/
 * 2. Internal: {baseDir}/.authrim/{env}/keys/
 * 3. Legacy: {baseDir}/.keys/{env}/
 *
 * @param baseDir - Base directory (usually source dir)
 * @param env - Environment name
 * @param options - Options for path resolution
 * @returns Path to the keys directory
 */
export function getKeysDirectory(
  baseDir: string,
  env: string,
  options?: KeysDirectoryOptions
): string {
  if (options?.legacy) {
    return getLegacyPaths(baseDir, env).keys;
  }

  // If keysBaseDir is provided, use findKeysDirectory for 3-tier fallback
  if (options?.keysBaseDir) {
    const found = findKeysDirectory({ env, sourceDir: baseDir, keysBaseDir: options.keysBaseDir });
    if (found) {
      return found.path;
    }
    // Default to external for new environments
    return getExternalKeysDir(env, options.keysBaseDir);
  }

  // Check if existing structure should be used
  const resolved = resolvePaths({ baseDir, env });
  if (resolved.type === 'legacy') {
    return (resolved.paths as LegacyPaths).keys;
  }

  return (resolved.paths as EnvironmentPaths).keys;
}

/**
 * Get keys directory path using the new structure
 */
export function getNewKeysDirectory(baseDir: string, env: string): string {
  return getEnvironmentPaths({ baseDir, env }).keys;
}

/**
 * Get keys directory path using the legacy structure
 * @deprecated Use getKeysDirectory with legacy option instead
 */
export function getLegacyKeysDirectory(baseDir: string, env: string): string {
  return getLegacyPaths(baseDir, env).keys;
}

const KEY_BUNDLE_PUBLICATION_MARKER = '.authrim-key-bundle-complete';

type KeyBundleInspection =
  | { status: 'absent' | 'incomplete' | 'corrupt' }
  | { status: 'recoverable'; publicKeyJwk: JWK }
  | { status: 'complete'; metadata: KeyMetadata; publicKeyJwk: JWK };

function hasPublishedKeyBundle(inspection: KeyBundleInspection): boolean {
  return (
    inspection.status === 'complete' ||
    inspection.status === 'recoverable' ||
    inspection.status === 'corrupt'
  );
}

/**
 * Inspect the durable identity at the center of a key bundle.
 *
 * A syntactically valid metadata document with a kid is treated as published even when its
 * key pair is damaged. That state must fail closed instead of being mistaken for permission to
 * rotate an environment identity. A malformed metadata document is repairable only when all
 * stable key material validates, and that repair reconstructs metadata without changing a key.
 */
function inspectKeyBundle(keysDir: string): KeyBundleInspection {
  if (!existsSync(keysDir)) {
    return { status: 'absent' };
  }

  const metadataPath = join(keysDir, 'metadata.json');
  const publicationMarkerPath = join(keysDir, KEY_BUNDLE_PUBLICATION_MARKER);
  const hasPublicationMarker = existsSync(publicationMarkerPath);
  const hasMetadataFile = existsSync(metadataPath);
  let metadata: KeyMetadata | undefined;
  if (hasMetadataFile) {
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Partial<KeyMetadata>).kid === 'string' &&
        (parsed as Partial<KeyMetadata>).kid!.length > 0 &&
        (parsed as Partial<KeyMetadata>).files &&
        typeof (parsed as Partial<KeyMetadata>).files === 'object' &&
        !Array.isArray((parsed as Partial<KeyMetadata>).files)
      ) {
        metadata = parsed as KeyMetadata;
      }
    } catch {
      // A complete pre-publication bundle with truncated metadata is handled below.
    }
  }

  const privateKeyPath = join(keysDir, 'private.pem');
  const publicKeyPath = join(keysDir, 'public.jwk.json');
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    return {
      status:
        hasPublicationMarker ||
        hasMetadataFile ||
        metadata ||
        existsSync(privateKeyPath) ||
        existsSync(publicKeyPath)
          ? 'corrupt'
          : 'incomplete',
    };
  }

  try {
    const privateKeyPem = readFileSync(privateKeyPath, 'utf-8');
    const publicKeyJwk = JSON.parse(readFileSync(publicKeyPath, 'utf-8')) as JWK;
    if (
      !validatePrivateKey(privateKeyPem) ||
      !validatePublicKeyJwk(publicKeyJwk) ||
      (metadata && publicKeyJwk.kid !== metadata.kid)
    ) {
      return { status: 'corrupt' };
    }

    const derivedPublicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({
      format: 'jwk',
    }) as JWK;
    if (derivedPublicKey.n !== publicKeyJwk.n || derivedPublicKey.e !== publicKeyJwk.e) {
      return { status: 'corrupt' };
    }

    if (!hasCompleteStableKeyBundle(keysDir)) {
      return { status: 'corrupt' };
    }

    if (!hasPublicationMarker) {
      return { status: 'recoverable', publicKeyJwk };
    }
    if (
      !metadata ||
      !validateKeyMetadata(metadata, publicKeyJwk, keysDir) ||
      !validateKeyBundlePublicationMarker(publicationMarkerPath, publicKeyJwk.kid!)
    ) {
      return { status: 'corrupt' };
    }
    return { status: 'complete', metadata, publicKeyJwk };
  } catch {
    return { status: 'corrupt' };
  }
}

interface LocatedKeyBundle {
  path: string;
  canonicalPath: string;
}

function findRecoverableStagingDirectory(canonicalPath: string): string | undefined {
  const parentDir = dirname(canonicalPath);
  const prefix = `.${basename(canonicalPath)}.staging-`;
  try {
    return readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(parentDir, entry.name))
      .filter((candidate) => {
        const inspection = inspectKeyBundle(candidate);
        return (
          (inspection.status === 'complete' || inspection.status === 'recoverable') &&
          hasCompleteStableKeyBundle(candidate)
        );
      })
      .sort((left, right) => {
        const modifiedDifference = statSync(left).mtimeMs - statSync(right).mtimeMs;
        return modifiedDifference || left.localeCompare(right);
      })[0];
  } catch {
    return undefined;
  }
}

function locatePublishedKeyBundle(canonicalPath: string): LocatedKeyBundle | undefined {
  if (hasPublishedKeyBundle(inspectKeyBundle(canonicalPath))) {
    return { path: canonicalPath, canonicalPath };
  }
  const stagedPath = findRecoverableStagingDirectory(canonicalPath);
  return stagedPath ? { path: stagedPath, canonicalPath } : undefined;
}

function findPublishedKeyBundleDirectory(
  baseDir: string,
  env: string,
  keysBaseDir?: string
): LocatedKeyBundle | undefined {
  const candidates = [
    ...(keysBaseDir ? [getExternalKeysDir(env, keysBaseDir)] : []),
    getEnvironmentPaths({ baseDir, env }).keys,
    getLegacyPaths(baseDir, env).keys,
  ];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate);
    if (visited.has(resolvedCandidate)) {
      continue;
    }
    visited.add(resolvedCandidate);
    const located = locatePublishedKeyBundle(candidate);
    if (located) {
      return located;
    }
  }

  return undefined;
}

/**
 * Check if keys already exist for an environment
 * Checks external, internal (new), and legacy structures
 *
 * @param baseDir - Source directory
 * @param env - Environment name
 * @param keysBaseDir - Optional base directory for external keys
 */
export function keysExistForEnvironment(
  baseDir: string,
  env: string,
  keysBaseDir?: string
): boolean {
  return findPublishedKeyBundleDirectory(baseDir, env, keysBaseDir) !== undefined;
}

export interface SaveKeysOptions {
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Environment name */
  env?: string;
  /** Use legacy .keys/{env}/ structure */
  legacy?: boolean;
  /** Direct path to keys directory (overrides baseDir/env/legacy) */
  targetDir?: string;
  /** Base directory for external keys (saves to {keysBaseDir}/.authrim-keys/{env}/) */
  keysBaseDir?: string;
}

function getKeyBundlePaths(directory: string) {
  return {
    privateKey: join(directory, 'private.pem'),
    publicKey: join(directory, 'public.jwk.json'),
    rpTokenEncryptionKey: join(directory, 'rp_token_encryption_key.txt'),
    piiEncryptionKey: join(directory, 'pii_encryption_key.txt'),
    objectEncryptionRootKey: join(directory, 'object_encryption_root_key.txt'),
    otpHmacSecret: join(directory, 'otp_hmac_secret.txt'),
    loggingCursorHmacSecret: join(directory, 'logging_cursor_hmac_secret.txt'),
    lookupHmacKeySlotA: join(directory, 'lookup_hmac_key_slot_a.txt'),
    flowRuntimeHmacSecret: join(directory, 'flow_runtime_hmac_secret.txt'),
    vcTransactionCodeHmacSecret: join(directory, 'vc_transaction_code_hmac_secret.txt'),
    vcEvidenceHmacSecret: join(directory, 'vc_evidence_hmac_secret.txt'),
    vcProfileContractHmacSecret: join(directory, 'vc_profile_contract_hmac_secret.txt'),
    pluginEncryptionKey: join(directory, 'plugin_encryption_key.txt'),
    pluginMutationHmacKey: join(directory, 'plugin_mutation_hmac_key.txt'),
    notificationPayloadDecryptJwkSlotA: join(
      directory,
      'notification_payload_decryption_jwk_slot_a.private.jwk.json'
    ),
    notificationPayloadDecryptJwkSlotB: join(
      directory,
      'notification_payload_decryption_jwk_slot_b.private.jwk.json'
    ),
    notificationPayloadEncryptPublicJwks: join(
      directory,
      'notification_payload_encryption_public.jwks.json'
    ),
    notificationIntentHmacKey: join(directory, 'notification_intent_hmac_key.txt'),
    agentElevationEncryptionKey: join(directory, 'agent_elevation_encryption_key.txt'),
    setupToken: join(directory, 'setup_token.txt'),
    setupMachinePrivateKey: join(directory, 'setup_machine_private.pem'),
    setupMachinePublicKey: join(directory, 'setup_machine_public.jwk.json'),
    adminUiBffPrivateKey: join(directory, 'admin_ui_bff_private.pem'),
    adminUiBffPublicKey: join(directory, 'admin_ui_bff_public.jwk.json'),
    tenantRuntimeRegistrySigningPrivateJwk: join(
      directory,
      'tenant_runtime_registry_signing_private.jwk.json'
    ),
    tenantRuntimeRegistryVerifyingPublicJwks: join(
      directory,
      'tenant_runtime_registry_verify.jwks.json'
    ),
    tenantRuntimeRegistrySigningKeyId: join(
      directory,
      'tenant_runtime_registry_signing_key_id.txt'
    ),
    smokeRpcSigningJwkSlotA: join(directory, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
    smokeRpcSigningJwkSlotB: join(directory, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'),
    controlSmokeVerifyingPublicJwks: join(directory, 'control_smoke_verify.jwks.json'),
    metadata: join(directory, 'metadata.json'),
    publicationMarker: join(directory, KEY_BUNDLE_PUBLICATION_MARKER),
  };
}

function readRequiredText(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const value = readFileSync(path, 'utf-8');
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function validateJwkPair(privateJwkPath: string, publicJwksPath: string): boolean {
  try {
    const privateJwk = JSON.parse(readFileSync(privateJwkPath, 'utf-8')) as JWK;
    const publicJwks = JSON.parse(readFileSync(publicJwksPath, 'utf-8')) as {
      keys?: unknown;
    };
    if (
      !Array.isArray(publicJwks.keys) ||
      publicJwks.keys.length < 1 ||
      publicJwks.keys.length > 2
    ) {
      return false;
    }
    const matchingPublicKeys = (publicJwks.keys as JWK[]).filter(
      (key) => key.kid === privateJwk.kid
    );
    if (matchingPublicKeys.length !== 1) return false;
    const publicJwk = matchingPublicKeys[0]!;
    const derived = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({
      format: 'jwk',
    }) as JWK;
    return (
      typeof privateJwk.kid === 'string' &&
      privateJwk.kid === publicJwk.kid &&
      derived.kty === publicJwk.kty &&
      derived.crv === publicJwk.crv &&
      derived.x === publicJwk.x
    );
  } catch {
    return false;
  }
}

function validatePemJwkPair(privateKeyPath: string, publicKeyPath: string): boolean {
  try {
    const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf-8'));
    const publicJwk = JSON.parse(readFileSync(publicKeyPath, 'utf-8')) as JWK;
    const derived = createPublicKey(privateKey).export({ format: 'jwk' }) as JWK;
    return (
      validateSetupMachinePublicKeyJwk(publicJwk) &&
      derived.kty === publicJwk.kty &&
      derived.crv === publicJwk.crv &&
      derived.x === publicJwk.x &&
      derived.y === publicJwk.y
    );
  } catch {
    return false;
  }
}

function validateRsaPemJwkPair(privateKeyPath: string, publicKeyPath: string): boolean {
  try {
    const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf-8'));
    const publicJwk = JSON.parse(readFileSync(publicKeyPath, 'utf-8')) as JWK;
    const derived = createPublicKey(privateKey).export({ format: 'jwk' }) as JWK;
    return (
      privateKey.asymmetricKeyType === 'rsa' &&
      privateKey.asymmetricKeyDetails?.modulusLength === DEFAULT_RSA_SIGNING_KEY_BITS &&
      validatePublicKeyJwk(publicJwk) &&
      publicJwk.alg === 'RS256' &&
      derived.kty === publicJwk.kty &&
      derived.n === publicJwk.n &&
      derived.e === publicJwk.e
    );
  } catch {
    return false;
  }
}

function validateKeyBundlePublicationMarker(path: string, expectedKeyId: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return (
      Boolean(marker) &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      (marker as { version?: unknown }).version === 1 &&
      (marker as { kid?: unknown }).kid === expectedKeyId
    );
  } catch {
    return false;
  }
}

function validateKeyMetadata(metadata: KeyMetadata, publicKeyJwk: JWK, directory: string): boolean {
  if (
    metadata.kid !== publicKeyJwk.kid ||
    metadata.algorithm !== 'RS256' ||
    metadata.keySize !== DEFAULT_RSA_SIGNING_KEY_BITS ||
    typeof metadata.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !metadata.files ||
    typeof metadata.files !== 'object' ||
    Array.isArray(metadata.files)
  ) {
    return false;
  }

  const paths = getKeyBundlePaths(directory);
  const requiredFiles: Array<[keyof KeyMetadata['files'], string]> = [
    ['privateKey', paths.privateKey],
    ['publicKey', paths.publicKey],
    ['rpTokenEncryptionKey', paths.rpTokenEncryptionKey],
    ['piiEncryptionKey', paths.piiEncryptionKey],
    ['objectEncryptionRootKey', paths.objectEncryptionRootKey],
    ['otpHmacSecret', paths.otpHmacSecret],
    ['loggingCursorHmacSecret', paths.loggingCursorHmacSecret],
    ['lookupHmacKeySlotA', paths.lookupHmacKeySlotA],
    ['flowRuntimeHmacSecret', paths.flowRuntimeHmacSecret],
    ['vcTransactionCodeHmacSecret', paths.vcTransactionCodeHmacSecret],
    ['vcEvidenceHmacSecret', paths.vcEvidenceHmacSecret],
    ['vcProfileContractHmacSecret', paths.vcProfileContractHmacSecret],
    ['pluginEncryptionKey', paths.pluginEncryptionKey],
    ['pluginMutationHmacKey', paths.pluginMutationHmacKey],
    ['notificationPayloadDecryptJwkSlotA', paths.notificationPayloadDecryptJwkSlotA],
    ['notificationPayloadEncryptPublicJwks', paths.notificationPayloadEncryptPublicJwks],
    ['notificationIntentHmacKey', paths.notificationIntentHmacKey],
    ['agentElevationEncryptionKey', paths.agentElevationEncryptionKey],
    ['setupMachinePrivateKey', paths.setupMachinePrivateKey],
    ['setupMachinePublicKey', paths.setupMachinePublicKey],
    ['adminUiBffPrivateKey', paths.adminUiBffPrivateKey],
    ['adminUiBffPublicKey', paths.adminUiBffPublicKey],
    ['tenantRuntimeRegistrySigningPrivateJwk', paths.tenantRuntimeRegistrySigningPrivateJwk],
    ['tenantRuntimeRegistryVerifyingPublicJwks', paths.tenantRuntimeRegistryVerifyingPublicJwks],
    ['tenantRuntimeRegistrySigningKeyId', paths.tenantRuntimeRegistrySigningKeyId],
    ['smokeRpcSigningJwkSlotA', paths.smokeRpcSigningJwkSlotA],
    ['controlSmokeVerifyingPublicJwks', paths.controlSmokeVerifyingPublicJwks],
  ];
  return requiredFiles.every(([key, expectedPath]) => {
    const recordedPath = metadata.files[key];
    return typeof recordedPath === 'string' && basename(recordedPath) === basename(expectedPath);
  });
}

function hasCompleteStableKeyBundle(directory: string): boolean {
  const paths = getKeyBundlePaths(directory);
  const hexSecrets = [
    paths.rpTokenEncryptionKey,
    paths.piiEncryptionKey,
    paths.objectEncryptionRootKey,
    paths.agentElevationEncryptionKey,
  ];
  const base64UrlSecrets = [
    paths.otpHmacSecret,
    paths.loggingCursorHmacSecret,
    paths.lookupHmacKeySlotA,
    paths.flowRuntimeHmacSecret,
    paths.vcTransactionCodeHmacSecret,
    paths.vcEvidenceHmacSecret,
    paths.vcProfileContractHmacSecret,
    paths.pluginEncryptionKey,
    paths.pluginMutationHmacKey,
    paths.notificationIntentHmacKey,
  ];
  if (hexSecrets.some((path) => !/^[a-f0-9]{64}$/u.test(readRequiredText(path) ?? ''))) {
    return false;
  }
  if (base64UrlSecrets.some((path) => !/^[A-Za-z0-9_-]{43}$/u.test(readRequiredText(path) ?? ''))) {
    return false;
  }
  if (
    !validateRsaPemJwkPair(paths.privateKey, paths.publicKey) ||
    !validatePemJwkPair(paths.setupMachinePrivateKey, paths.setupMachinePublicKey) ||
    !validatePemJwkPair(paths.adminUiBffPrivateKey, paths.adminUiBffPublicKey) ||
    !validateJwkPair(
      paths.tenantRuntimeRegistrySigningPrivateJwk,
      paths.tenantRuntimeRegistryVerifyingPublicJwks
    ) ||
    !validateJwkPair(paths.smokeRpcSigningJwkSlotA, paths.controlSmokeVerifyingPublicJwks)
  ) {
    return false;
  }

  const tenantRuntimeKeyId = readRequiredText(paths.tenantRuntimeRegistrySigningKeyId);
  try {
    const tenantPrivateJwk = JSON.parse(
      readFileSync(paths.tenantRuntimeRegistrySigningPrivateJwk, 'utf-8')
    ) as JWK;
    if (tenantRuntimeKeyId !== tenantPrivateJwk.kid) {
      return false;
    }
    validateNotificationPayloadKeySet(
      [readFileSync(paths.notificationPayloadDecryptJwkSlotA, 'utf-8')],
      readFileSync(paths.notificationPayloadEncryptPublicJwks, 'utf-8')
    );
  } catch {
    return false;
  }

  return true;
}

type KeyBundlePaths = ReturnType<typeof getKeyBundlePaths>;

function buildKeyMetadata(keyId: string, createdAt: string, paths: KeyBundlePaths): KeyMetadata {
  return {
    kid: keyId,
    algorithm: 'RS256',
    keySize: DEFAULT_RSA_SIGNING_KEY_BITS,
    createdAt,
    files: {
      privateKey: paths.privateKey,
      publicKey: paths.publicKey,
      rpTokenEncryptionKey: paths.rpTokenEncryptionKey,
      piiEncryptionKey: paths.piiEncryptionKey,
      objectEncryptionRootKey: paths.objectEncryptionRootKey,
      otpHmacSecret: paths.otpHmacSecret,
      loggingCursorHmacSecret: paths.loggingCursorHmacSecret,
      lookupHmacKeySlotA: paths.lookupHmacKeySlotA,
      flowRuntimeHmacSecret: paths.flowRuntimeHmacSecret,
      vcTransactionCodeHmacSecret: paths.vcTransactionCodeHmacSecret,
      vcEvidenceHmacSecret: paths.vcEvidenceHmacSecret,
      vcProfileContractHmacSecret: paths.vcProfileContractHmacSecret,
      pluginEncryptionKey: paths.pluginEncryptionKey,
      pluginMutationHmacKey: paths.pluginMutationHmacKey,
      notificationPayloadDecryptJwkSlotA: paths.notificationPayloadDecryptJwkSlotA,
      notificationPayloadEncryptPublicJwks: paths.notificationPayloadEncryptPublicJwks,
      notificationIntentHmacKey: paths.notificationIntentHmacKey,
      agentElevationEncryptionKey: paths.agentElevationEncryptionKey,
      setupMachinePrivateKey: paths.setupMachinePrivateKey,
      setupMachinePublicKey: paths.setupMachinePublicKey,
      adminUiBffPrivateKey: paths.adminUiBffPrivateKey,
      adminUiBffPublicKey: paths.adminUiBffPublicKey,
      tenantRuntimeRegistrySigningPrivateJwk: paths.tenantRuntimeRegistrySigningPrivateJwk,
      tenantRuntimeRegistryVerifyingPublicJwks: paths.tenantRuntimeRegistryVerifyingPublicJwks,
      tenantRuntimeRegistrySigningKeyId: paths.tenantRuntimeRegistrySigningKeyId,
      smokeRpcSigningJwkSlotA: paths.smokeRpcSigningJwkSlotA,
      controlSmokeVerifyingPublicJwks: paths.controlSmokeVerifyingPublicJwks,
    },
  };
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some supported filesystems do not allow directory handles to be synced.
  }
}

async function replaceFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}-${randomBytes(8).toString('hex')}.tmp`
  );
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectoryBestEffort(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function repairRecoverableKeyBundle(
  directory: string,
  publicKeyJwk: JWK
): Promise<KeyMetadata> {
  const paths = getKeyBundlePaths(directory);
  const privateKeyStat = statSync(paths.privateKey);
  const createdAt = new Date(privateKeyStat.birthtimeMs || privateKeyStat.mtimeMs).toISOString();
  const metadata = buildKeyMetadata(publicKeyJwk.kid!, createdAt, paths);

  await replaceFileAtomically(paths.metadata, JSON.stringify(metadata, null, 2));
  await replaceFileAtomically(
    paths.publicationMarker,
    JSON.stringify({ version: 1, kid: publicKeyJwk.kid })
  );
  await syncDirectoryBestEffort(directory);
  return metadata;
}

async function syncKeyBundleFiles(paths: KeyBundlePaths): Promise<void> {
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) {
      continue;
    }
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectoryBestEffort(dirname(paths.metadata));
}

/**
 * Save keys and secrets to the keys directory
 *
 * Supports both:
 * - New structure: .authrim/{env}/keys/
 * - Legacy structure: .keys/{env}/
 *
 * @param secrets - Generated secrets to save
 * @param options - Options for path resolution
 */
export async function saveKeysToDirectory(
  secrets: GeneratedSecrets,
  options: SaveKeysOptions | string = {},
  legacyEnv?: string
): Promise<void> {
  let targetDir: string;

  // Support legacy function signature: saveKeysToDirectory(secrets, keysDir, env)
  if (typeof options === 'string') {
    // Legacy call: saveKeysToDirectory(secrets, '.keys', 'dev')
    targetDir = legacyEnv ? join(options, legacyEnv) : options;
  } else {
    const { baseDir = process.cwd(), env, legacy, targetDir: explicitDir, keysBaseDir } = options;

    if (explicitDir) {
      targetDir = explicitDir;
    } else if (env) {
      if (keysBaseDir) {
        // External keys: {keysBaseDir}/.authrim-keys/{env}/
        targetDir = getExternalKeysDir(env, keysBaseDir);
      } else if (legacy) {
        targetDir = getLegacyPaths(baseDir, env).keys;
      } else {
        targetDir = getEnvironmentPaths({ baseDir, env }).keys;
      }
    } else {
      throw new Error('Either env or targetDir must be provided');
    }
  }

  // Security: Validate directory path to prevent path traversal
  validateKeysDirectory(targetDir);

  if (locatePublishedKeyBundle(targetDir)) {
    throw new Error('existing_key_bundle_must_be_reused');
  }

  const publishedTargetDir = targetDir;
  const parentDir = dirname(publishedTargetDir);
  const stagingDir = join(
    parentDir,
    `.${basename(publishedTargetDir)}.staging-${process.pid}-${randomBytes(8).toString('hex')}`
  );
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  await mkdir(stagingDir, { mode: 0o700 });

  const paths = getKeyBundlePaths(stagingDir);
  const publishedPaths = getKeyBundlePaths(publishedTargetDir);

  try {
    // Sensitive file permission: owner read/write only
    const SENSITIVE_FILE_MODE = 0o600;

    // Write private key
    await writeFile(paths.privateKey, secrets.keyPair.privateKeyPem, 'utf-8');
    await chmod(paths.privateKey, SENSITIVE_FILE_MODE);

    // Write public key (JWK)
    await writeFile(
      paths.publicKey,
      JSON.stringify(secrets.keyPair.publicKeyJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.publicKey, SENSITIVE_FILE_MODE);

    // Write other secrets
    await writeFile(paths.rpTokenEncryptionKey, secrets.rpTokenEncryptionKey, 'utf-8');
    await chmod(paths.rpTokenEncryptionKey, SENSITIVE_FILE_MODE);
    await writeFile(paths.piiEncryptionKey, secrets.piiEncryptionKey, 'utf-8');
    await chmod(paths.piiEncryptionKey, SENSITIVE_FILE_MODE);
    await writeFile(paths.objectEncryptionRootKey, secrets.objectEncryptionRootKey, 'utf-8');
    await chmod(paths.objectEncryptionRootKey, SENSITIVE_FILE_MODE);
    await writeFile(paths.otpHmacSecret, secrets.otpHmacSecret, 'utf-8');
    await chmod(paths.otpHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(paths.loggingCursorHmacSecret, secrets.loggingCursorHmacSecret, 'utf-8');
    await chmod(paths.loggingCursorHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(paths.lookupHmacKeySlotA, secrets.lookupHmacKeySlotA, 'utf-8');
    await chmod(paths.lookupHmacKeySlotA, SENSITIVE_FILE_MODE);
    await writeFile(paths.flowRuntimeHmacSecret, secrets.flowRuntimeHmacSecret, 'utf-8');
    await chmod(paths.flowRuntimeHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.vcTransactionCodeHmacSecret,
      secrets.vcTransactionCodeHmacSecret ?? generateBase64Secret(32),
      'utf-8'
    );
    await chmod(paths.vcTransactionCodeHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.vcEvidenceHmacSecret,
      secrets.vcEvidenceHmacSecret ?? generateBase64Secret(32),
      'utf-8'
    );
    await chmod(paths.vcEvidenceHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.vcProfileContractHmacSecret,
      secrets.vcProfileContractHmacSecret ?? generateBase64Secret(32),
      'utf-8'
    );
    await chmod(paths.vcProfileContractHmacSecret, SENSITIVE_FILE_MODE);
    await writeFile(paths.pluginEncryptionKey, secrets.pluginEncryptionKey, 'utf-8');
    await chmod(paths.pluginEncryptionKey, SENSITIVE_FILE_MODE);
    await writeFile(paths.pluginMutationHmacKey, secrets.pluginMutationHmacKey, 'utf-8');
    await chmod(paths.pluginMutationHmacKey, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.notificationPayloadDecryptJwkSlotA,
      JSON.stringify(secrets.notificationPayloadKeyPair.privateJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.notificationPayloadDecryptJwkSlotA, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.notificationPayloadEncryptPublicJwks,
      JSON.stringify({ keys: [secrets.notificationPayloadKeyPair.publicJwk] }, null, 2),
      'utf-8'
    );
    await chmod(paths.notificationPayloadEncryptPublicJwks, SENSITIVE_FILE_MODE);
    await writeFile(paths.notificationIntentHmacKey, secrets.notificationIntentHmacKey, 'utf-8');
    await chmod(paths.notificationIntentHmacKey, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.agentElevationEncryptionKey,
      secrets.agentElevationEncryptionKey,
      'utf-8'
    );
    await chmod(paths.agentElevationEncryptionKey, SENSITIVE_FILE_MODE);

    if (secrets.setupToken) {
      await writeFile(paths.setupToken, secrets.setupToken, 'utf-8');
      await chmod(paths.setupToken, SENSITIVE_FILE_MODE);
    }

    await writeFile(
      paths.setupMachinePrivateKey,
      secrets.setupMachineKeyPair.privateKeyPem,
      'utf-8'
    );
    await chmod(paths.setupMachinePrivateKey, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.setupMachinePublicKey,
      JSON.stringify(secrets.setupMachineKeyPair.publicKeyJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.setupMachinePublicKey, SENSITIVE_FILE_MODE);

    await writeFile(
      paths.adminUiBffPrivateKey,
      secrets.adminUiBffMachineKeyPair.privateKeyPem,
      'utf-8'
    );
    await chmod(paths.adminUiBffPrivateKey, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.adminUiBffPublicKey,
      JSON.stringify(secrets.adminUiBffMachineKeyPair.publicKeyJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.adminUiBffPublicKey, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.tenantRuntimeRegistrySigningPrivateJwk,
      JSON.stringify(secrets.tenantRuntimeRegistryKeyPair.privateJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.tenantRuntimeRegistrySigningPrivateJwk, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.tenantRuntimeRegistryVerifyingPublicJwks,
      JSON.stringify({ keys: [secrets.tenantRuntimeRegistryKeyPair.publicJwk] }, null, 2),
      'utf-8'
    );
    await chmod(paths.tenantRuntimeRegistryVerifyingPublicJwks, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.tenantRuntimeRegistrySigningKeyId,
      secrets.tenantRuntimeRegistryKeyPair.keyId,
      'utf-8'
    );
    await chmod(paths.tenantRuntimeRegistrySigningKeyId, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.smokeRpcSigningJwkSlotA,
      JSON.stringify(secrets.controlSmokeKeyPair.privateJwk, null, 2),
      'utf-8'
    );
    await chmod(paths.smokeRpcSigningJwkSlotA, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.controlSmokeVerifyingPublicJwks,
      JSON.stringify({ keys: [secrets.controlSmokeKeyPair.publicJwk] }, null, 2),
      'utf-8'
    );
    await chmod(paths.controlSmokeVerifyingPublicJwks, SENSITIVE_FILE_MODE);

    // Write metadata
    const metadata = buildKeyMetadata(
      secrets.keyPair.keyId,
      secrets.keyPair.createdAt,
      publishedPaths
    );

    await writeFile(paths.metadata, JSON.stringify(metadata, null, 2), 'utf-8');
    await chmod(paths.metadata, SENSITIVE_FILE_MODE);
    await writeFile(
      paths.publicationMarker,
      JSON.stringify({ version: 1, kid: secrets.keyPair.keyId }),
      'utf-8'
    );
    await chmod(paths.publicationMarker, SENSITIVE_FILE_MODE);
    await syncKeyBundleFiles(paths);

    if (inspectKeyBundle(stagingDir).status !== 'complete') {
      throw new Error('generated_key_bundle_failed_validation');
    }

    const currentInspection = inspectKeyBundle(publishedTargetDir);
    if (hasPublishedKeyBundle(currentInspection)) {
      throw new Error('existing_key_bundle_must_be_reused');
    }

    if (!existsSync(publishedTargetDir)) {
      try {
        // A directory rename exposes the complete bundle in one filesystem operation.
        await rename(stagingDir, publishedTargetDir);
        await syncDirectoryBestEffort(parentDir);
        return;
      } catch (error) {
        if (hasPublishedKeyBundle(inspectKeyBundle(publishedTargetDir))) {
          throw new Error('existing_key_bundle_must_be_reused');
        }
        throw error;
      }
    }

    if (readdirSync(publishedTargetDir).length > 0) {
      throw new Error('incomplete_key_bundle_requires_recovery');
    }

    // Empty callers' target directories are removed before the atomic directory publish. No key
    // file at the canonical path is ever copied, renamed, or replaced individually.
    await rmdir(publishedTargetDir);
    try {
      await rename(stagingDir, publishedTargetDir);
    } catch (error) {
      if (hasPublishedKeyBundle(inspectKeyBundle(publishedTargetDir))) {
        throw new Error('existing_key_bundle_must_be_reused');
      }
      throw error;
    }
    await syncDirectoryBestEffort(parentDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function readBaseKeyId(targetDir: string): Promise<string> {
  const metadataPath = join(targetDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as Partial<KeyMetadata>;
      if (typeof metadata.kid === 'string' && metadata.kid.length > 0) {
        return metadata.kid;
      }
    } catch {
      // Fall through to public JWK below.
    }
  }

  const publicJwkPath = join(targetDir, 'public.jwk.json');
  if (existsSync(publicJwkPath)) {
    try {
      const publicJwk = JSON.parse(await readFile(publicJwkPath, 'utf-8')) as Partial<JWK>;
      if (typeof publicJwk.kid === 'string' && publicJwk.kid.length > 0) {
        return publicJwk.kid;
      }
    } catch {
      // Fall through to generated key ID below.
    }
  }

  return generateKeyId('supplemental');
}

async function writeSensitiveFile(path: string, content: string): Promise<void> {
  await replaceFileAtomically(path, content);
}

async function writeMissingMachineKeyPair(
  paths: { privateKey: string; publicKey: string },
  keyId: string,
  createdFiles: string[]
): Promise<void> {
  const hasPrivateKey = existsSync(paths.privateKey);
  const hasPublicKey = existsSync(paths.publicKey);

  if (hasPrivateKey && hasPublicKey) {
    if (!validatePemJwkPair(paths.privateKey, paths.publicKey)) {
      throw new Error(`Mismatched machine key pair: ${paths.privateKey} and ${paths.publicKey}`);
    }
    return;
  }

  if (!hasPrivateKey && hasPublicKey) {
    throw new Error(
      `Incomplete machine key pair: both ${paths.privateKey} and ${paths.publicKey} are required`
    );
  }

  if (hasPrivateKey) {
    try {
      const privateKey = createPrivateKey(await readFile(paths.privateKey, 'utf-8'));
      if (privateKey.asymmetricKeyType !== 'ec') throw new Error('invalid');
      const derived = createPublicKey(privateKey).export({ format: 'jwk' }) as JWK;
      const publicJwk: JWK = {
        ...derived,
        kid: keyId,
        use: 'sig',
        alg: 'ES256',
      };
      await writeSensitiveFile(paths.publicKey, JSON.stringify(publicJwk, null, 2));
      if (!validatePemJwkPair(paths.privateKey, paths.publicKey)) throw new Error('invalid');
      createdFiles.push(paths.publicKey);
      return;
    } catch (error) {
      throw new Error(
        `Incomplete machine key pair: private key cannot recover ${paths.publicKey}`,
        { cause: error }
      );
    }
  }

  const keyPair = generateEs256KeyPair(keyId);
  await writeSensitiveFile(paths.privateKey, keyPair.privateKeyPem);
  await writeSensitiveFile(paths.publicKey, JSON.stringify(keyPair.publicKeyJwk, null, 2));
  createdFiles.push(paths.privateKey, paths.publicKey);
}

async function ensureSupplementalSecret(
  path: string,
  createValue: () => string,
  validateValue: (value: string) => boolean,
  createdFiles: string[]
): Promise<void> {
  if (existsSync(path)) {
    const value = await readFile(path, 'utf-8').catch(() => '');
    if (!validateValue(value)) {
      throw new Error(`Invalid supplemental secret: ${path}`);
    }
    return;
  }
  await writeSensitiveFile(path, createValue());
  createdFiles.push(path);
}

function deriveNotificationPublicJwk(privateJwk: JWK): JWK {
  const validated = notificationJwk(privateJwk, true);
  const derived = createPublicKey(createPrivateKey({ key: validated, format: 'jwk' })).export({
    format: 'jwk',
  }) as JWK;
  return {
    ...derived,
    kid: validated.kid,
    use: 'enc',
    alg: 'RSA-OAEP-256',
    key_ops: ['encrypt'],
  };
}

async function ensureNotificationPayloadKeySet(
  paths: {
    privateSlotA: string;
    privateSlotB: string;
    publicJwks: string;
  },
  keyId: string,
  createdFiles: string[]
): Promise<void> {
  const hasPrivateA = existsSync(paths.privateSlotA);
  const hasPrivateB = existsSync(paths.privateSlotB);
  const hasPublic = existsSync(paths.publicJwks);
  if (!hasPrivateA && (hasPrivateB || hasPublic)) {
    throw new Error(`Incomplete notification payload key set: ${paths.privateSlotA} is required`);
  }

  if (hasPrivateA) {
    const privateValues = [await readFile(paths.privateSlotA, 'utf-8')];
    if (hasPrivateB) privateValues.push(await readFile(paths.privateSlotB, 'utf-8'));
    const privateJwks = privateValues.map(parseNotificationPrivateJwk);
    if (hasPublic) {
      validateNotificationPayloadKeySet(privateValues, await readFile(paths.publicJwks, 'utf-8'));
      return;
    }
    await writeSensitiveFile(
      paths.publicJwks,
      JSON.stringify({ keys: privateJwks.map(deriveNotificationPublicJwk) }, null, 2)
    );
    validateNotificationPayloadKeySet(privateValues, await readFile(paths.publicJwks, 'utf-8'));
    createdFiles.push(paths.publicJwks);
    return;
  }

  const keyPair = generateRsaOaepJwkKeyPair(keyId);
  await writeSensitiveFile(paths.privateSlotA, JSON.stringify(keyPair.privateJwk, null, 2));
  await writeSensitiveFile(
    paths.publicJwks,
    JSON.stringify({ keys: [keyPair.publicJwk] }, null, 2)
  );
  createdFiles.push(paths.privateSlotA, paths.publicJwks);
}

function deriveEd25519PublicJwk(privateJwk: JWK): JWK {
  if (
    privateJwk.kty !== 'OKP' ||
    privateJwk.crv !== 'Ed25519' ||
    typeof privateJwk.kid !== 'string' ||
    privateJwk.use !== 'sig' ||
    privateJwk.alg !== 'EdDSA'
  ) {
    throw new Error('Invalid Ed25519 private JWK');
  }
  const derived = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({
    format: 'jwk',
  }) as JWK;
  return {
    ...derived,
    kid: privateJwk.kid,
    use: 'sig',
    alg: 'EdDSA',
  };
}

async function ensureEd25519KeySet(
  paths: {
    privateSlotA: string;
    privateSlotB?: string;
    publicJwks: string;
    keyIdFile?: string;
  },
  keyId: string,
  label: string,
  createdFiles: string[]
): Promise<void> {
  const hasPrivateA = existsSync(paths.privateSlotA);
  const hasPrivateB = Boolean(paths.privateSlotB && existsSync(paths.privateSlotB));
  const hasPublic = existsSync(paths.publicJwks);
  const hasKeyId = Boolean(paths.keyIdFile && existsSync(paths.keyIdFile));
  if (!hasPrivateA && (hasPrivateB || hasPublic || hasKeyId)) {
    throw new Error(`Incomplete ${label} key set: ${paths.privateSlotA} is required`);
  }

  if (hasPrivateA) {
    const privatePaths = [paths.privateSlotA];
    if (hasPrivateB && paths.privateSlotB) privatePaths.push(paths.privateSlotB);
    const privateJwks = privatePaths.map((path) => {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')) as JWK;
      } catch (error) {
        throw new Error(`Incomplete ${label} key set: invalid private key`, { cause: error });
      }
    });
    let publicJwks: JWK[];
    try {
      publicJwks = privateJwks.map(deriveEd25519PublicJwk);
    } catch (error) {
      throw new Error(`Incomplete ${label} key set: invalid private key`, { cause: error });
    }
    if (hasPublic) {
      for (const privatePath of privatePaths) {
        if (!validateJwkPair(privatePath, paths.publicJwks)) {
          throw new Error(`Mismatched ${label} key set`);
        }
      }
    } else {
      await writeSensitiveFile(paths.publicJwks, JSON.stringify({ keys: publicJwks }, null, 2));
      createdFiles.push(paths.publicJwks);
    }

    if (paths.keyIdFile) {
      const expectedKeyId = privateJwks[0].kid!;
      if (hasKeyId) {
        if ((await readFile(paths.keyIdFile, 'utf-8')).trim() !== expectedKeyId) {
          throw new Error(`Mismatched ${label} key ID`);
        }
      } else {
        await writeSensitiveFile(paths.keyIdFile, expectedKeyId);
        createdFiles.push(paths.keyIdFile);
      }
    }
    return;
  }

  const keyPair = generateEd25519JwkKeyPair(keyId);
  await writeSensitiveFile(paths.privateSlotA, JSON.stringify(keyPair.privateJwk, null, 2));
  await writeSensitiveFile(
    paths.publicJwks,
    JSON.stringify({ keys: [keyPair.publicJwk] }, null, 2)
  );
  createdFiles.push(paths.privateSlotA, paths.publicJwks);
  if (paths.keyIdFile) {
    await writeSensitiveFile(paths.keyIdFile, keyPair.keyId);
    createdFiles.push(paths.keyIdFile);
  }
}

async function updateMetadataWithSupplementalFiles(
  targetDir: string,
  files: Partial<KeyMetadata['files']>
): Promise<void> {
  const metadataPath = join(targetDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    return;
  }

  let metadata: KeyMetadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as KeyMetadata;
  } catch {
    // A complete bundle is reconstructed from its key identity after supplemental writes.
    return;
  }
  metadata.files = {
    ...metadata.files,
    ...files,
  };
  for (const key of LEGACY_STATIC_SECRET_METADATA_KEYS) {
    delete (metadata.files as Record<string, unknown>)[key];
  }
  await writeSensitiveFile(metadataPath, JSON.stringify(metadata, null, 2));
}

async function removeLegacyStaticSecretFiles(keysDir: string): Promise<void> {
  for (const fileName of LEGACY_STATIC_SECRET_FILES) {
    await rm(join(keysDir, fileName), { force: true });
  }
}

/**
 * Backfill keys/secrets introduced after the original setup flow.
 *
 * Existing self-hosted installs may have a valid key directory without
 * VersionManager or Admin Machine Access key material. Deploy paths call this
 * before uploading secrets and before bootstrapping DB_ADMIN machine principals.
 */
export async function ensureSupplementalKeyFiles(
  keysDir: string,
  options: { includeSetupMachineKeyPair?: boolean } = {}
): Promise<SupplementalKeyFilesResult> {
  validateKeysDirectory(keysDir);

  if (!existsSync(keysDir)) {
    throw new Error(`Keys directory not found: ${keysDir}`);
  }

  await removeLegacyStaticSecretFiles(keysDir);

  const createdFiles: string[] = [];
  const baseKeyId = await readBaseKeyId(keysDir);
  const paths = {
    objectEncryptionRootKey: join(keysDir, 'object_encryption_root_key.txt'),
    piiEncryptionKey: join(keysDir, 'pii_encryption_key.txt'),
    otpHmacSecret: join(keysDir, 'otp_hmac_secret.txt'),
    loggingCursorHmacSecret: join(keysDir, 'logging_cursor_hmac_secret.txt'),
    lookupHmacKeySlotA: join(keysDir, 'lookup_hmac_key_slot_a.txt'),
    flowRuntimeHmacSecret: join(keysDir, 'flow_runtime_hmac_secret.txt'),
    vcTransactionCodeHmacSecret: join(keysDir, 'vc_transaction_code_hmac_secret.txt'),
    vcEvidenceHmacSecret: join(keysDir, 'vc_evidence_hmac_secret.txt'),
    vcProfileContractHmacSecret: join(keysDir, 'vc_profile_contract_hmac_secret.txt'),
    pluginEncryptionKey: join(keysDir, 'plugin_encryption_key.txt'),
    pluginMutationHmacKey: join(keysDir, 'plugin_mutation_hmac_key.txt'),
    notificationPayloadDecryptJwkSlotA: join(
      keysDir,
      'notification_payload_decryption_jwk_slot_a.private.jwk.json'
    ),
    notificationPayloadDecryptJwkSlotB: join(
      keysDir,
      'notification_payload_decryption_jwk_slot_b.private.jwk.json'
    ),
    notificationPayloadEncryptPublicJwks: join(
      keysDir,
      'notification_payload_encryption_public.jwks.json'
    ),
    notificationIntentHmacKey: join(keysDir, 'notification_intent_hmac_key.txt'),
    agentElevationEncryptionKey: join(keysDir, 'agent_elevation_encryption_key.txt'),
    setupMachinePrivateKey: join(keysDir, 'setup_machine_private.pem'),
    setupMachinePublicKey: join(keysDir, 'setup_machine_public.jwk.json'),
    adminUiBffPrivateKey: join(keysDir, 'admin_ui_bff_private.pem'),
    adminUiBffPublicKey: join(keysDir, 'admin_ui_bff_public.jwk.json'),
    tenantRuntimeRegistrySigningPrivateJwk: join(
      keysDir,
      'tenant_runtime_registry_signing_private.jwk.json'
    ),
    tenantRuntimeRegistryVerifyingPublicJwks: join(
      keysDir,
      'tenant_runtime_registry_verify.jwks.json'
    ),
    tenantRuntimeRegistrySigningKeyId: join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
    smokeRpcSigningJwkSlotA: join(keysDir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
    smokeRpcSigningJwkSlotB: join(keysDir, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'),
    controlSmokeVerifyingPublicJwks: join(keysDir, 'control_smoke_verify.jwks.json'),
  };

  const hexSecretPaths = [
    paths.objectEncryptionRootKey,
    paths.piiEncryptionKey,
    paths.agentElevationEncryptionKey,
  ];
  for (const path of hexSecretPaths) {
    await ensureSupplementalSecret(
      path,
      () => generateHexSecret(32),
      (value) => /^[a-f0-9]{64}$/u.test(value),
      createdFiles
    );
  }
  const base64UrlSecretPaths = [
    paths.otpHmacSecret,
    paths.loggingCursorHmacSecret,
    paths.lookupHmacKeySlotA,
    paths.flowRuntimeHmacSecret,
    paths.vcTransactionCodeHmacSecret,
    paths.vcEvidenceHmacSecret,
    paths.vcProfileContractHmacSecret,
    paths.pluginEncryptionKey,
    paths.pluginMutationHmacKey,
    paths.notificationIntentHmacKey,
  ];
  for (const path of base64UrlSecretPaths) {
    await ensureSupplementalSecret(
      path,
      () => generateBase64Secret(32),
      (value) => /^[A-Za-z0-9_-]{43}$/u.test(value),
      createdFiles
    );
  }
  await ensureNotificationPayloadKeySet(
    {
      privateSlotA: paths.notificationPayloadDecryptJwkSlotA,
      privateSlotB: paths.notificationPayloadDecryptJwkSlotB,
      publicJwks: paths.notificationPayloadEncryptPublicJwks,
    },
    `${baseKeyId}-notification-payload`,
    createdFiles
  );

  if (options.includeSetupMachineKeyPair !== false) {
    await writeMissingMachineKeyPair(
      {
        privateKey: paths.setupMachinePrivateKey,
        publicKey: paths.setupMachinePublicKey,
      },
      `${baseKeyId}-setup`,
      createdFiles
    );
  }
  await writeMissingMachineKeyPair(
    {
      privateKey: paths.adminUiBffPrivateKey,
      publicKey: paths.adminUiBffPublicKey,
    },
    `${baseKeyId}-admin-ui-bff`,
    createdFiles
  );
  await ensureEd25519KeySet(
    {
      privateSlotA: paths.tenantRuntimeRegistrySigningPrivateJwk,
      publicJwks: paths.tenantRuntimeRegistryVerifyingPublicJwks,
      keyIdFile: paths.tenantRuntimeRegistrySigningKeyId,
    },
    `${baseKeyId}-tenant-runtime-registry`,
    'tenant runtime registry',
    createdFiles
  );

  await ensureEd25519KeySet(
    {
      privateSlotA: paths.smokeRpcSigningJwkSlotA,
      privateSlotB: paths.smokeRpcSigningJwkSlotB,
      publicJwks: paths.controlSmokeVerifyingPublicJwks,
    },
    `${baseKeyId}-control-smoke`,
    'control smoke',
    createdFiles
  );

  await updateMetadataWithSupplementalFiles(keysDir, {
    objectEncryptionRootKey: paths.objectEncryptionRootKey,
    piiEncryptionKey: paths.piiEncryptionKey,
    otpHmacSecret: paths.otpHmacSecret,
    loggingCursorHmacSecret: paths.loggingCursorHmacSecret,
    flowRuntimeHmacSecret: paths.flowRuntimeHmacSecret,
    vcTransactionCodeHmacSecret: paths.vcTransactionCodeHmacSecret,
    vcEvidenceHmacSecret: paths.vcEvidenceHmacSecret,
    vcProfileContractHmacSecret: paths.vcProfileContractHmacSecret,
    pluginEncryptionKey: paths.pluginEncryptionKey,
    pluginMutationHmacKey: paths.pluginMutationHmacKey,
    notificationPayloadDecryptJwkSlotA: paths.notificationPayloadDecryptJwkSlotA,
    ...(existsSync(paths.notificationPayloadDecryptJwkSlotB)
      ? { notificationPayloadDecryptJwkSlotB: paths.notificationPayloadDecryptJwkSlotB }
      : {}),
    notificationPayloadEncryptPublicJwks: paths.notificationPayloadEncryptPublicJwks,
    notificationIntentHmacKey: paths.notificationIntentHmacKey,
    agentElevationEncryptionKey: paths.agentElevationEncryptionKey,
    ...(options.includeSetupMachineKeyPair !== false
      ? {
          setupMachinePrivateKey: paths.setupMachinePrivateKey,
          setupMachinePublicKey: paths.setupMachinePublicKey,
        }
      : {}),
    adminUiBffPrivateKey: paths.adminUiBffPrivateKey,
    adminUiBffPublicKey: paths.adminUiBffPublicKey,
    tenantRuntimeRegistrySigningPrivateJwk: paths.tenantRuntimeRegistrySigningPrivateJwk,
    tenantRuntimeRegistryVerifyingPublicJwks: paths.tenantRuntimeRegistryVerifyingPublicJwks,
    tenantRuntimeRegistrySigningKeyId: paths.tenantRuntimeRegistrySigningKeyId,
    smokeRpcSigningJwkSlotA: paths.smokeRpcSigningJwkSlotA,
    ...(existsSync(paths.smokeRpcSigningJwkSlotB)
      ? { smokeRpcSigningJwkSlotB: paths.smokeRpcSigningJwkSlotB }
      : {}),
    controlSmokeVerifyingPublicJwks: paths.controlSmokeVerifyingPublicJwks,
  });

  if (hasCompleteStableKeyBundle(keysDir)) {
    const inspection = inspectKeyBundle(keysDir);
    if (inspection.status === 'recoverable') {
      await repairRecoverableKeyBundle(keysDir, inspection.publicKeyJwk);
    } else if (inspection.status !== 'complete') {
      throw new Error('key_bundle_corrupt_after_supplemental_reconciliation');
    }
  }

  return { createdFiles };
}

async function restoreStagedKeyBundle(location: LocatedKeyBundle): Promise<string> {
  if (location.path === location.canonicalPath) {
    return location.canonicalPath;
  }

  const canonicalInspection = inspectKeyBundle(location.canonicalPath);
  if (hasPublishedKeyBundle(canonicalInspection)) {
    return location.canonicalPath;
  }

  if (existsSync(location.canonicalPath)) {
    if (readdirSync(location.canonicalPath).length > 0) {
      throw new Error('incomplete_key_bundle_requires_recovery');
    }
    try {
      await rmdir(location.canonicalPath);
    } catch (error) {
      if (hasPublishedKeyBundle(inspectKeyBundle(location.canonicalPath))) {
        return location.canonicalPath;
      }
      if (existsSync(location.canonicalPath)) {
        throw error;
      }
    }
  }

  try {
    await rename(location.path, location.canonicalPath);
  } catch (error) {
    if (hasPublishedKeyBundle(inspectKeyBundle(location.canonicalPath))) {
      return location.canonicalPath;
    }
    throw error;
  }
  await syncDirectoryBestEffort(dirname(location.canonicalPath));
  return location.canonicalPath;
}

export interface LoadKeysOptions {
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Environment name */
  env?: string;
  /** Direct path to keys directory (overrides baseDir/env) */
  targetDir?: string;
  /** Base directory for external keys (searches {keysBaseDir}/.authrim-keys/{env}/ first) */
  keysBaseDir?: string;
}

/**
 * Load existing keys from directory
 *
 * Automatically detects and uses the correct structure (new or legacy)
 *
 * @param options - Options for path resolution, or legacy keysDir string
 * @param legacyEnv - Environment name (legacy signature)
 */
export async function loadKeysFromDirectory(
  options: LoadKeysOptions | string = {},
  legacyEnv?: string
): Promise<{
  keyPair?: Partial<KeyPair>;
  metadata?: KeyMetadata;
}> {
  let location: LocatedKeyBundle;

  // Support legacy function signature: loadKeysFromDirectory('.keys', 'dev')
  if (typeof options === 'string') {
    const canonicalPath = legacyEnv ? join(options, legacyEnv) : options;
    location = locatePublishedKeyBundle(canonicalPath) ?? {
      path: canonicalPath,
      canonicalPath,
    };
  } else {
    const { baseDir = process.cwd(), env, targetDir: explicitDir, keysBaseDir } = options;

    if (explicitDir) {
      location = locatePublishedKeyBundle(explicitDir) ?? {
        path: explicitDir,
        canonicalPath: explicitDir,
      };
    } else if (env) {
      const publishedBundleDir = findPublishedKeyBundleDirectory(baseDir, env, keysBaseDir);
      if (!publishedBundleDir) {
        return {};
      }
      location = publishedBundleDir;
    } else {
      throw new Error('Either env or targetDir must be provided');
    }
  }

  const targetDir = await restoreStagedKeyBundle(location);
  let inspection = inspectKeyBundle(targetDir);
  if (inspection.status === 'recoverable') {
    await repairRecoverableKeyBundle(targetDir, inspection.publicKeyJwk);
    inspection = inspectKeyBundle(targetDir);
  }
  if (inspection.status !== 'complete') {
    return {};
  }

  return {
    keyPair: {
      keyId: inspection.metadata.kid,
      publicKeyJwk: inspection.publicKeyJwk,
      createdAt: inspection.metadata.createdAt,
    },
    metadata: inspection.metadata,
  };
}

// =============================================================================
// Wrangler Secret Commands
// =============================================================================

/**
 * Validate a path parameter to prevent path traversal attacks
 */
function validatePath(path: string, paramName: string): void {
  // Reject paths with traversal patterns
  if (path.includes('..') || path.includes('\0')) {
    throw new Error(`Invalid ${paramName}: path traversal detected`);
  }
  // Reject shell metacharacters
  if (/[;&|`$(){}[\]<>!#*?]/.test(path)) {
    throw new Error(`Invalid ${paramName}: shell metacharacters not allowed`);
  }
}

/**
 * Validate environment name
 */
function validateEnvName(env: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error('Invalid environment name: must be lowercase alphanumeric with hyphens');
  }
}

/**
 * Generate wrangler commands for uploading secrets
 * @deprecated Use uploadSecrets from deploy.ts instead for programmatic upload
 */
export function generateWranglerSecretCommands(
  secrets: GeneratedSecrets,
  keysDir: string = '.keys',
  env?: string
): string[] {
  // Validate inputs to prevent command injection
  validatePath(keysDir, 'keysDir');
  if (env) {
    validateEnvName(env);
  }

  const envFlag = env ? ` --env ${env}` : '';
  const commands: string[] = [];

  // Private key (multiline secret)
  commands.push(
    `cat ${join(keysDir, 'private.pem')} | wrangler secret put PRIVATE_KEY_PEM${envFlag}`
  );

  // Public JWK
  commands.push(
    `cat ${join(keysDir, 'public.jwk.json')} | wrangler secret put PUBLIC_JWK_JSON${envFlag}`
  );

  // RP Token encryption key
  commands.push(
    `echo -n "$(cat ${join(keysDir, 'rp_token_encryption_key.txt')})" | wrangler secret put RP_TOKEN_ENCRYPTION_KEY${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'pii_encryption_key.txt')})" | wrangler secret put PII_ENCRYPTION_KEY${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'otp_hmac_secret.txt')})" | wrangler secret put OTP_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'object_encryption_root_key.txt')})" | wrangler secret put OBJECT_ENCRYPTION_ROOT_KEY${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'logging_cursor_hmac_secret.txt')})" | wrangler secret put LOGGING_CURSOR_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'flow_runtime_hmac_secret.txt')})" | wrangler secret put FLOW_RUNTIME_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'vc_transaction_code_hmac_secret.txt')})" | wrangler secret put VC_TRANSACTION_CODE_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'vc_evidence_hmac_secret.txt')})" | wrangler secret put VC_EVIDENCE_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'vc_profile_contract_hmac_secret.txt')})" | wrangler secret put VC_PROFILE_CONTRACT_HMAC_SECRET${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'plugin_encryption_key.txt')})" | wrangler secret put PLUGIN_ENCRYPTION_KEY${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'plugin_mutation_hmac_key.txt')})" | wrangler secret put PLUGIN_MUTATION_HMAC_KEY${envFlag}`
  );

  commands.push(
    `echo -n "$(cat ${join(keysDir, 'agent_elevation_encryption_key.txt')})" | wrangler secret put AGENT_ELEVATION_ENCRYPTION_KEY${envFlag}`
  );

  return commands;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate that a private key PEM is valid RSA
 */
export function validatePrivateKey(pem: string): boolean {
  try {
    const key = createPrivateKey({
      key: pem,
      format: 'pem',
    });
    return key.type === 'private' && key.asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/**
 * Validate that a public key JWK has required properties
 */
export function validatePublicKeyJwk(jwk: JWK): boolean {
  if (!jwk.kty || jwk.kty !== 'RSA') return false;
  if (!jwk.n || !jwk.e) return false;
  if (!jwk.kid) return false;
  return true;
}

export function validateSetupMachinePublicKeyJwk(jwk: JWK): boolean {
  return (
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    typeof jwk.y === 'string' &&
    typeof jwk.kid === 'string' &&
    jwk.alg === 'ES256'
  );
}
