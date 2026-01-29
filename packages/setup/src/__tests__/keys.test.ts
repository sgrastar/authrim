/**
 * Keys Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateKeyId,
  generateRsaKeyPair,
  generateHexSecret,
  generateBase64Secret,
  generateAllSecrets,
  saveKeysToDirectory,
  keysExistForEnvironment,
  validatePrivateKey,
  validatePublicKeyJwk,
} from '../core/keys.js';
import { AUTHRIM_KEYS_DIR, AUTHRIM_DIR, LEGACY_KEYS_DIR } from '../core/paths.js';

describe('generateKeyId', () => {
  it('should generate a key ID with default prefix', () => {
    const keyId = generateKeyId();

    expect(keyId).toMatch(/^dev-key-\d+-[a-zA-Z0-9_-]+$/);
  });

  it('should generate a key ID with custom prefix', () => {
    const keyId = generateKeyId('prod');

    expect(keyId).toMatch(/^prod-key-\d+-[a-zA-Z0-9_-]+$/);
  });

  it('should generate unique key IDs', () => {
    const keyId1 = generateKeyId('test');
    const keyId2 = generateKeyId('test');

    expect(keyId1).not.toBe(keyId2);
  });
});

describe('generateRsaKeyPair', () => {
  it('should generate a valid RSA key pair', () => {
    const keyPair = generateRsaKeyPair('test-key');

    expect(keyPair.keyId).toBe('test-key');
    expect(keyPair.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keyPair.publicKeyJwk.kty).toBe('RSA');
    expect(keyPair.publicKeyJwk.kid).toBe('test-key');
    expect(keyPair.publicKeyJwk.use).toBe('sig');
    expect(keyPair.publicKeyJwk.alg).toBe('RS256');
    expect(keyPair.createdAt).toBeDefined();
  });

  it('should generate key with auto-generated ID', () => {
    const keyPair = generateRsaKeyPair();

    expect(keyPair.keyId).toMatch(/^dev-key-\d+-[a-zA-Z0-9_-]+$/);
  });
});

describe('generateHexSecret', () => {
  it('should generate 32-byte hex secret by default', () => {
    const secret = generateHexSecret();

    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should generate custom size hex secret', () => {
    const secret = generateHexSecret(16);

    expect(secret).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('generateBase64Secret', () => {
  it('should generate base64url secret', () => {
    const secret = generateBase64Secret();

    expect(secret).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });
});

describe('generateAllSecrets', () => {
  it('should generate all required secrets', () => {
    const secrets = generateAllSecrets('test-key');

    expect(secrets.keyPair).toBeDefined();
    expect(secrets.keyPair.keyId).toBe('test-key');
    expect(secrets.rpTokenEncryptionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.adminApiSecret).toBeDefined();
    expect(secrets.keyManagerSecret).toBeDefined();
    expect(secrets.setupToken).toBeDefined();
  });
});

describe('validatePrivateKey', () => {
  it('should validate a valid RSA private key', () => {
    const keyPair = generateRsaKeyPair();

    expect(validatePrivateKey(keyPair.privateKeyPem)).toBe(true);
  });

  it('should reject invalid private key', () => {
    expect(validatePrivateKey('invalid-key')).toBe(false);
  });
});

describe('validatePublicKeyJwk', () => {
  it('should validate a valid JWK', () => {
    const keyPair = generateRsaKeyPair('test-key');

    expect(validatePublicKeyJwk(keyPair.publicKeyJwk)).toBe(true);
  });

  it('should reject JWK without required fields', () => {
    expect(validatePublicKeyJwk({ kty: 'RSA' })).toBe(false);
    expect(validatePublicKeyJwk({ kty: 'RSA', n: 'xxx', e: 'xxx' })).toBe(false);
  });

  it('should reject non-RSA JWK', () => {
    expect(validatePublicKeyJwk({ kty: 'EC', kid: 'test' })).toBe(false);
  });
});

// =============================================================================
// External Keys Storage Tests
// =============================================================================

describe('saveKeysToDirectory with external keys', () => {
  let testDir: string;

  beforeEach(() => {
    // Use project-relative directory to avoid keys.ts dangerous path validation blocking /var, /tmp
    testDir = join(
      process.cwd(),
      `.test-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save keys to external directory when keysBaseDir is provided', async () => {
    const secrets = generateAllSecrets('ext-test-key');

    await saveKeysToDirectory(secrets, { keysBaseDir: testDir, env: 'prod' });

    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    expect(existsSync(join(keysDir, 'private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'public.jwk.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'metadata.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'rp_token_encryption_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'admin_api_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'key_manager_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_token.txt'))).toBe(true);
  });

  it('should save keys to internal directory when keysBaseDir is not provided', async () => {
    const secrets = generateAllSecrets('int-test-key');

    await saveKeysToDirectory(secrets, { baseDir: testDir, env: 'dev' });

    const keysDir = join(testDir, AUTHRIM_DIR, 'dev', 'keys');
    expect(existsSync(join(keysDir, 'private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'metadata.json'))).toBe(true);
  });
});

describe('keysExistForEnvironment with external keys', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      `.test-keys-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should detect keys in external directory', () => {
    const externalDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'metadata.json'), '{}');

    expect(keysExistForEnvironment(testDir, 'prod', testDir)).toBe(true);
  });

  it('should detect keys in internal directory', () => {
    const internalDir = join(testDir, AUTHRIM_DIR, 'prod', 'keys');
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, 'metadata.json'), '{}');

    expect(keysExistForEnvironment(testDir, 'prod')).toBe(true);
  });

  it('should detect keys in legacy directory', () => {
    const legacyDir = join(testDir, LEGACY_KEYS_DIR, 'prod');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'metadata.json'), '{}');

    expect(keysExistForEnvironment(testDir, 'prod')).toBe(true);
  });

  it('should return false when no keys exist', () => {
    expect(keysExistForEnvironment(testDir, 'prod', testDir)).toBe(false);
  });
});
