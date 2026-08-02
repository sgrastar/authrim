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
import { writeFile, mkdir, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  // Check external structure
  if (keysBaseDir) {
    const externalDir = getExternalKeysDir(env, keysBaseDir);
    if (existsSync(join(externalDir, 'metadata.json'))) {
      return true;
    }
  }

  // Check new structure
  const newPaths = getEnvironmentPaths({ baseDir, env });
  const newMetadataPath = join(newPaths.keys, 'metadata.json');
  if (existsSync(newMetadataPath)) {
    return true;
  }

  // Check legacy structure
  const legacyPaths = getLegacyPaths(baseDir, env);
  const legacyMetadataPath = join(legacyPaths.keys, 'metadata.json');
  return existsSync(legacyMetadataPath);
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

  // Ensure directory exists with restrictive permissions (owner-only access)
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
  }

  const paths = {
    privateKey: join(targetDir, 'private.pem'),
    publicKey: join(targetDir, 'public.jwk.json'),
    rpTokenEncryptionKey: join(targetDir, 'rp_token_encryption_key.txt'),
    piiEncryptionKey: join(targetDir, 'pii_encryption_key.txt'),
    objectEncryptionRootKey: join(targetDir, 'object_encryption_root_key.txt'),
    otpHmacSecret: join(targetDir, 'otp_hmac_secret.txt'),
    loggingCursorHmacSecret: join(targetDir, 'logging_cursor_hmac_secret.txt'),
    lookupHmacKeySlotA: join(targetDir, 'lookup_hmac_key_slot_a.txt'),
    flowRuntimeHmacSecret: join(targetDir, 'flow_runtime_hmac_secret.txt'),
    vcTransactionCodeHmacSecret: join(targetDir, 'vc_transaction_code_hmac_secret.txt'),
    vcEvidenceHmacSecret: join(targetDir, 'vc_evidence_hmac_secret.txt'),
    vcProfileContractHmacSecret: join(targetDir, 'vc_profile_contract_hmac_secret.txt'),
    pluginEncryptionKey: join(targetDir, 'plugin_encryption_key.txt'),
    pluginMutationHmacKey: join(targetDir, 'plugin_mutation_hmac_key.txt'),
    notificationPayloadDecryptJwkSlotA: join(
      targetDir,
      'notification_payload_decryption_jwk_slot_a.private.jwk.json'
    ),
    notificationPayloadDecryptJwkSlotB: join(
      targetDir,
      'notification_payload_decryption_jwk_slot_b.private.jwk.json'
    ),
    notificationPayloadEncryptPublicJwks: join(
      targetDir,
      'notification_payload_encryption_public.jwks.json'
    ),
    notificationIntentHmacKey: join(targetDir, 'notification_intent_hmac_key.txt'),
    agentElevationEncryptionKey: join(targetDir, 'agent_elevation_encryption_key.txt'),
    setupToken: join(targetDir, 'setup_token.txt'),
    setupMachinePrivateKey: join(targetDir, 'setup_machine_private.pem'),
    setupMachinePublicKey: join(targetDir, 'setup_machine_public.jwk.json'),
    adminUiBffPrivateKey: join(targetDir, 'admin_ui_bff_private.pem'),
    adminUiBffPublicKey: join(targetDir, 'admin_ui_bff_public.jwk.json'),
    tenantRuntimeRegistrySigningPrivateJwk: join(
      targetDir,
      'tenant_runtime_registry_signing_private.jwk.json'
    ),
    tenantRuntimeRegistryVerifyingPublicJwks: join(
      targetDir,
      'tenant_runtime_registry_verify.jwks.json'
    ),
    tenantRuntimeRegistrySigningKeyId: join(
      targetDir,
      'tenant_runtime_registry_signing_key_id.txt'
    ),
    smokeRpcSigningJwkSlotA: join(targetDir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
    smokeRpcSigningJwkSlotB: join(targetDir, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'),
    controlSmokeVerifyingPublicJwks: join(targetDir, 'control_smoke_verify.jwks.json'),
    metadata: join(targetDir, 'metadata.json'),
  };

  // Sensitive file permission: owner read/write only
  const SENSITIVE_FILE_MODE = 0o600;

  // Write private key
  await writeFile(paths.privateKey, secrets.keyPair.privateKeyPem, 'utf-8');
  await chmod(paths.privateKey, SENSITIVE_FILE_MODE);

  // Write public key (JWK)
  await writeFile(paths.publicKey, JSON.stringify(secrets.keyPair.publicKeyJwk, null, 2), 'utf-8');
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
  await writeFile(paths.agentElevationEncryptionKey, secrets.agentElevationEncryptionKey, 'utf-8');
  await chmod(paths.agentElevationEncryptionKey, SENSITIVE_FILE_MODE);

  if (secrets.setupToken) {
    await writeFile(paths.setupToken, secrets.setupToken, 'utf-8');
    await chmod(paths.setupToken, SENSITIVE_FILE_MODE);
  }

  await writeFile(paths.setupMachinePrivateKey, secrets.setupMachineKeyPair.privateKeyPem, 'utf-8');
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
  const metadata: KeyMetadata = {
    kid: secrets.keyPair.keyId,
    algorithm: 'RS256',
    keySize: DEFAULT_RSA_SIGNING_KEY_BITS,
    createdAt: secrets.keyPair.createdAt,
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

  await writeFile(paths.metadata, JSON.stringify(metadata, null, 2), 'utf-8');
  await chmod(paths.metadata, SENSITIVE_FILE_MODE);
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
  await writeFile(path, content, 'utf-8');
  await chmod(path, 0o600);
}

async function writeMissingMachineKeyPair(
  paths: { privateKey: string; publicKey: string },
  keyId: string,
  createdFiles: string[]
): Promise<void> {
  const hasPrivateKey = existsSync(paths.privateKey);
  const hasPublicKey = existsSync(paths.publicKey);

  if (hasPrivateKey && hasPublicKey) {
    return;
  }

  if (hasPrivateKey !== hasPublicKey) {
    throw new Error(
      `Incomplete machine key pair: both ${paths.privateKey} and ${paths.publicKey} are required`
    );
  }

  const keyPair = generateEs256KeyPair(keyId);
  await writeSensitiveFile(paths.privateKey, keyPair.privateKeyPem);
  await writeSensitiveFile(paths.publicKey, JSON.stringify(keyPair.publicKeyJwk, null, 2));
  createdFiles.push(paths.privateKey, paths.publicKey);
}

async function updateMetadataWithSupplementalFiles(
  targetDir: string,
  files: Partial<KeyMetadata['files']>
): Promise<void> {
  const metadataPath = join(targetDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    return;
  }

  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as KeyMetadata;
    metadata.files = {
      ...metadata.files,
      ...files,
    };
    await writeSensitiveFile(metadataPath, JSON.stringify(metadata, null, 2));
  } catch {
    // Metadata is advisory; do not block deploy-time compatibility repair.
  }
}

async function removeLegacyStaticSecretFiles(keysDir: string): Promise<void> {
  for (const fileName of LEGACY_STATIC_SECRET_FILES) {
    await rm(join(keysDir, fileName), { force: true });
  }

  const metadataPath = join(keysDir, 'metadata.json');
  if (!existsSync(metadataPath)) {
    return;
  }

  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8')) as KeyMetadata & {
      files: Record<string, unknown>;
    };
    let changed = false;
    for (const key of LEGACY_STATIC_SECRET_METADATA_KEYS) {
      if (key in metadata.files) {
        delete metadata.files[key];
        changed = true;
      }
    }
    if (changed) {
      await writeSensitiveFile(metadataPath, JSON.stringify(metadata, null, 2));
    }
  } catch {
    // Metadata is advisory; removing the actual secret files is the security boundary.
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

  if (!existsSync(paths.objectEncryptionRootKey)) {
    await writeSensitiveFile(paths.objectEncryptionRootKey, generateHexSecret(32));
    createdFiles.push(paths.objectEncryptionRootKey);
  }

  if (!existsSync(paths.piiEncryptionKey)) {
    await writeSensitiveFile(paths.piiEncryptionKey, generateHexSecret(32));
    createdFiles.push(paths.piiEncryptionKey);
  }

  if (!existsSync(paths.otpHmacSecret)) {
    await writeSensitiveFile(paths.otpHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.otpHmacSecret);
  }

  if (!existsSync(paths.loggingCursorHmacSecret)) {
    await writeSensitiveFile(paths.loggingCursorHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.loggingCursorHmacSecret);
  }

  if (!existsSync(paths.lookupHmacKeySlotA)) {
    await writeSensitiveFile(paths.lookupHmacKeySlotA, generateBase64Secret(32));
    createdFiles.push(paths.lookupHmacKeySlotA);
  }

  if (!existsSync(paths.flowRuntimeHmacSecret)) {
    await writeSensitiveFile(paths.flowRuntimeHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.flowRuntimeHmacSecret);
  }

  if (!existsSync(paths.vcTransactionCodeHmacSecret)) {
    await writeSensitiveFile(paths.vcTransactionCodeHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.vcTransactionCodeHmacSecret);
  }

  if (!existsSync(paths.vcEvidenceHmacSecret)) {
    await writeSensitiveFile(paths.vcEvidenceHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.vcEvidenceHmacSecret);
  }

  if (!existsSync(paths.vcProfileContractHmacSecret)) {
    await writeSensitiveFile(paths.vcProfileContractHmacSecret, generateBase64Secret(32));
    createdFiles.push(paths.vcProfileContractHmacSecret);
  }

  if (!existsSync(paths.pluginEncryptionKey)) {
    await writeSensitiveFile(paths.pluginEncryptionKey, generateBase64Secret(32));
    createdFiles.push(paths.pluginEncryptionKey);
  }
  if (!existsSync(paths.pluginMutationHmacKey)) {
    await writeSensitiveFile(paths.pluginMutationHmacKey, generateBase64Secret(32));
    createdFiles.push(paths.pluginMutationHmacKey);
  }
  const hasNotificationPayloadPrivate = existsSync(paths.notificationPayloadDecryptJwkSlotA);
  const hasNotificationPayloadPublic = existsSync(paths.notificationPayloadEncryptPublicJwks);
  if (hasNotificationPayloadPrivate || hasNotificationPayloadPublic) {
    if (!hasNotificationPayloadPrivate || !hasNotificationPayloadPublic) {
      throw new Error(
        `Incomplete notification payload key set: ${paths.notificationPayloadDecryptJwkSlotA} and ${paths.notificationPayloadEncryptPublicJwks} are required`
      );
    }
    const privateJwks = [await readFile(paths.notificationPayloadDecryptJwkSlotA, 'utf-8')];
    if (existsSync(paths.notificationPayloadDecryptJwkSlotB)) {
      privateJwks.push(await readFile(paths.notificationPayloadDecryptJwkSlotB, 'utf-8'));
    }
    validateNotificationPayloadKeySet(
      privateJwks,
      await readFile(paths.notificationPayloadEncryptPublicJwks, 'utf-8')
    );
  } else {
    const keyPair = generateRsaOaepJwkKeyPair(`${baseKeyId}-notification-payload`);
    await writeSensitiveFile(
      paths.notificationPayloadDecryptJwkSlotA,
      JSON.stringify(keyPair.privateJwk, null, 2)
    );
    await writeSensitiveFile(
      paths.notificationPayloadEncryptPublicJwks,
      JSON.stringify({ keys: [keyPair.publicJwk] }, null, 2)
    );
    createdFiles.push(
      paths.notificationPayloadDecryptJwkSlotA,
      paths.notificationPayloadEncryptPublicJwks
    );
  }
  if (!existsSync(paths.notificationIntentHmacKey)) {
    await writeSensitiveFile(paths.notificationIntentHmacKey, generateBase64Secret(32));
    createdFiles.push(paths.notificationIntentHmacKey);
  }
  if (!existsSync(paths.agentElevationEncryptionKey)) {
    await writeSensitiveFile(paths.agentElevationEncryptionKey, generateHexSecret(32));
    createdFiles.push(paths.agentElevationEncryptionKey);
  }

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
  const hasRuntimeSigningPrivate = existsSync(paths.tenantRuntimeRegistrySigningPrivateJwk);
  const hasRuntimeVerifyingJwks = existsSync(paths.tenantRuntimeRegistryVerifyingPublicJwks);
  const hasRuntimeSigningKeyId = existsSync(paths.tenantRuntimeRegistrySigningKeyId);
  if (hasRuntimeSigningPrivate || hasRuntimeVerifyingJwks || hasRuntimeSigningKeyId) {
    if (!hasRuntimeSigningPrivate || !hasRuntimeVerifyingJwks || !hasRuntimeSigningKeyId) {
      throw new Error(
        `Incomplete tenant runtime registry key set: ${paths.tenantRuntimeRegistrySigningPrivateJwk}, ${paths.tenantRuntimeRegistryVerifyingPublicJwks}, and ${paths.tenantRuntimeRegistrySigningKeyId} are required`
      );
    }
  } else {
    const keyPair = generateEd25519JwkKeyPair(`${baseKeyId}-tenant-runtime-registry`);
    await writeSensitiveFile(
      paths.tenantRuntimeRegistrySigningPrivateJwk,
      JSON.stringify(keyPair.privateJwk, null, 2)
    );
    await writeSensitiveFile(
      paths.tenantRuntimeRegistryVerifyingPublicJwks,
      JSON.stringify({ keys: [keyPair.publicJwk] }, null, 2)
    );
    await writeSensitiveFile(paths.tenantRuntimeRegistrySigningKeyId, keyPair.keyId);
    createdFiles.push(
      paths.tenantRuntimeRegistrySigningPrivateJwk,
      paths.tenantRuntimeRegistryVerifyingPublicJwks,
      paths.tenantRuntimeRegistrySigningKeyId
    );
  }

  const hasControlSmokePrivate = existsSync(paths.smokeRpcSigningJwkSlotA);
  const hasControlSmokePublic = existsSync(paths.controlSmokeVerifyingPublicJwks);
  if (hasControlSmokePrivate || hasControlSmokePublic) {
    if (!hasControlSmokePrivate || !hasControlSmokePublic) {
      throw new Error(
        `Incomplete control smoke key set: ${paths.smokeRpcSigningJwkSlotA} and ${paths.controlSmokeVerifyingPublicJwks} are required`
      );
    }
  } else {
    const keyPair = generateEd25519JwkKeyPair(`${baseKeyId}-control-smoke`);
    await writeSensitiveFile(
      paths.smokeRpcSigningJwkSlotA,
      JSON.stringify(keyPair.privateJwk, null, 2)
    );
    await writeSensitiveFile(
      paths.controlSmokeVerifyingPublicJwks,
      JSON.stringify({ keys: [keyPair.publicJwk] }, null, 2)
    );
    createdFiles.push(paths.smokeRpcSigningJwkSlotA, paths.controlSmokeVerifyingPublicJwks);
  }

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

  return { createdFiles };
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
  let targetDir: string;

  // Support legacy function signature: loadKeysFromDirectory('.keys', 'dev')
  if (typeof options === 'string') {
    targetDir = legacyEnv ? join(options, legacyEnv) : options;
  } else {
    const { baseDir = process.cwd(), env, targetDir: explicitDir, keysBaseDir } = options;

    if (explicitDir) {
      targetDir = explicitDir;
    } else if (env) {
      // Use findKeysDirectory for 3-tier search when keysBaseDir is provided
      if (keysBaseDir) {
        const found = findKeysDirectory({ env, sourceDir: baseDir, keysBaseDir });
        if (found) {
          targetDir = found.path;
        } else {
          // No keys found anywhere
          return {};
        }
      } else {
        // Auto-detect which structure to use
        const resolved = resolvePaths({ baseDir, env });
        if (resolved.type === 'legacy') {
          targetDir = (resolved.paths as LegacyPaths).keys;
        } else {
          targetDir = (resolved.paths as EnvironmentPaths).keys;
        }
      }
    } else {
      throw new Error('Either env or targetDir must be provided');
    }
  }

  const metadataPath = join(targetDir, 'metadata.json');

  if (!existsSync(metadataPath)) {
    return {};
  }

  try {
    const metadataContent = await readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataContent) as KeyMetadata;

    // Load public key JWK
    const publicKeyPath = join(targetDir, 'public.jwk.json');
    let publicKeyJwk: JWK | undefined;

    if (existsSync(publicKeyPath)) {
      const publicKeyContent = await readFile(publicKeyPath, 'utf-8');
      publicKeyJwk = JSON.parse(publicKeyContent);
    }

    return {
      keyPair: {
        keyId: metadata.kid,
        publicKeyJwk,
        createdAt: metadata.createdAt,
      },
      metadata,
    };
  } catch {
    return {};
  }
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
