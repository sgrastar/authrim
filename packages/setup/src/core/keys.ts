/**
 * Authrim Key Generation Module
 *
 * Generates RSA key pairs for JWT signing and other cryptographic secrets.
 * Based on the existing setup-keys.sh script functionality.
 */

import { randomBytes, generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export interface KeyMetadata {
  kid: string;
  algorithm: string;
  keySize: number;
  createdAt: string;
  files: {
    privateKey: string;
    publicKey: string;
    rpTokenEncryptionKey?: string;
  };
}

export interface GeneratedSecrets {
  /** RSA key pair for JWT signing */
  keyPair: KeyPair;
  /** RP Token encryption key (hex encoded) */
  rpTokenEncryptionKey: string;
  /** Admin API secret */
  adminApiSecret: string;
  /** Key Manager secret */
  keyManagerSecret: string;
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
 * @param keySize - RSA key size in bits (default: 2048)
 */
export function generateRsaKeyPair(keyId?: string, keySize: number = 2048): KeyPair {
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

  return {
    keyPair,
    rpTokenEncryptionKey: generateHexSecret(32), // 256-bit key
    adminApiSecret: generateBase64Secret(32), // 256-bit secret
    keyManagerSecret: generateBase64Secret(32), // 256-bit secret
    setupToken: generateHexSecret(32), // 256-bit token for initial setup
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
  // Reject absolute paths to system directories (Unix)
  const absolutePath = resolve(keysDir);
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
      throw new Error(`Invalid keys directory: writing to system directories is not allowed`);
    }
  }
}

/**
 * Save keys and secrets to the .keys directory
 */
export async function saveKeysToDirectory(
  secrets: GeneratedSecrets,
  keysDir: string = '.keys'
): Promise<void> {
  // Security: Validate directory path to prevent path traversal
  validateKeysDirectory(keysDir);

  // Ensure directory exists
  if (!existsSync(keysDir)) {
    await mkdir(keysDir, { recursive: true });
  }

  const paths = {
    privateKey: join(keysDir, 'private.pem'),
    publicKey: join(keysDir, 'public.jwk.json'),
    rpTokenEncryptionKey: join(keysDir, 'rp_token_encryption_key.txt'),
    adminApiSecret: join(keysDir, 'admin_api_secret.txt'),
    keyManagerSecret: join(keysDir, 'key_manager_secret.txt'),
    setupToken: join(keysDir, 'setup_token.txt'),
    metadata: join(keysDir, 'metadata.json'),
  };

  // Write private key
  await writeFile(paths.privateKey, secrets.keyPair.privateKeyPem, 'utf-8');

  // Write public key (JWK)
  await writeFile(paths.publicKey, JSON.stringify(secrets.keyPair.publicKeyJwk, null, 2), 'utf-8');

  // Write other secrets
  await writeFile(paths.rpTokenEncryptionKey, secrets.rpTokenEncryptionKey, 'utf-8');
  await writeFile(paths.adminApiSecret, secrets.adminApiSecret, 'utf-8');
  await writeFile(paths.keyManagerSecret, secrets.keyManagerSecret, 'utf-8');

  if (secrets.setupToken) {
    await writeFile(paths.setupToken, secrets.setupToken, 'utf-8');
  }

  // Write metadata
  const metadata: KeyMetadata = {
    kid: secrets.keyPair.keyId,
    algorithm: 'RS256',
    keySize: 2048,
    createdAt: secrets.keyPair.createdAt,
    files: {
      privateKey: paths.privateKey,
      publicKey: paths.publicKey,
      rpTokenEncryptionKey: paths.rpTokenEncryptionKey,
    },
  };

  await writeFile(paths.metadata, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Load existing keys from directory
 */
export async function loadKeysFromDirectory(keysDir: string = '.keys'): Promise<{
  keyPair?: Partial<KeyPair>;
  metadata?: KeyMetadata;
}> {
  const metadataPath = join(keysDir, 'metadata.json');

  if (!existsSync(metadataPath)) {
    return {};
  }

  try {
    const metadataContent = await readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataContent) as KeyMetadata;

    // Load public key JWK
    const publicKeyPath = join(keysDir, 'public.jwk.json');
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
    throw new Error(`Invalid environment name: must be lowercase alphanumeric with hyphens`);
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

  // RP Token encryption key
  commands.push(
    `echo -n "$(cat ${join(keysDir, 'rp_token_encryption_key.txt')})" | wrangler secret put RP_TOKEN_ENCRYPTION_KEY${envFlag}`
  );

  // Admin API secret
  commands.push(
    `echo -n "$(cat ${join(keysDir, 'admin_api_secret.txt')})" | wrangler secret put ADMIN_API_SECRET${envFlag}`
  );

  // Key Manager secret
  commands.push(
    `echo -n "$(cat ${join(keysDir, 'key_manager_secret.txt')})" | wrangler secret put KEY_MANAGER_SECRET${envFlag}`
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
