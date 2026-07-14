/**
 * Keys Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateKeyId,
  generateRsaKeyPair,
  generateEs256KeyPair,
  generateHexSecret,
  generateBase64Secret,
  generateAllSecrets,
  saveKeysToDirectory,
  keysExistForEnvironment,
  validatePrivateKey,
  validatePublicKeyJwk,
  validateSetupMachinePublicKeyJwk,
  generateWranglerSecretCommands,
  ensureSupplementalKeyFiles,
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

describe('generateEs256KeyPair', () => {
  it('should generate a valid ES256 key pair', () => {
    const keyPair = generateEs256KeyPair('setup-test-key');

    expect(keyPair.keyId).toBe('setup-test-key');
    expect(keyPair.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keyPair.publicKeyJwk.kty).toBe('EC');
    expect(keyPair.publicKeyJwk.crv).toBe('P-256');
    expect(keyPair.publicKeyJwk.kid).toBe('setup-test-key');
    expect(keyPair.publicKeyJwk.use).toBe('sig');
    expect(keyPair.publicKeyJwk.alg).toBe('ES256');
    expect(validateSetupMachinePublicKeyJwk(keyPair.publicKeyJwk)).toBe(true);
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
    expect(secrets.setupMachineKeyPair).toBeDefined();
    expect(secrets.setupMachineKeyPair.keyId).toBe('test-key-setup');
    expect(secrets.setupMachineKeyPair.publicKeyJwk.alg).toBe('ES256');
    expect(secrets.adminUiBffMachineKeyPair).toBeDefined();
    expect(secrets.adminUiBffMachineKeyPair.keyId).toBe('test-key-admin-ui-bff');
    expect(secrets.adminUiBffMachineKeyPair.publicKeyJwk.alg).toBe('ES256');
    expect(secrets.tenantRuntimeRegistryKeyPair).toBeDefined();
    expect(secrets.tenantRuntimeRegistryKeyPair.keyId).toBe('test-key-tenant-runtime-registry');
    expect(secrets.tenantRuntimeRegistryKeyPair.publicJwk.kty).toBe('OKP');
    expect(secrets.tenantRuntimeRegistryKeyPair.publicJwk.crv).toBe('Ed25519');
    expect(secrets.tenantRuntimeRegistryKeyPair.publicJwk.alg).toBe('EdDSA');
    expect(secrets.rpTokenEncryptionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.piiEncryptionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.objectEncryptionRootKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.otpHmacSecret).toBeDefined();
    expect(secrets.loggingCursorHmacSecret).toBeDefined();
    expect(secrets.flowRuntimeHmacSecret).toBeDefined();
    expect(secrets.pluginEncryptionKey).toBeDefined();
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
    expect(existsSync(join(keysDir, 'pii_encryption_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'object_encryption_root_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'otp_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'logging_cursor_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'plugin_encryption_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_token.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_machine_private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_machine_public.jwk.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'admin_ui_bff_private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'admin_ui_bff_public.jwk.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_signing_private.jwk.json'))).toBe(
      true
    );
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_verify.jwks.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'))).toBe(true);
  });

  it('should save keys to internal directory when keysBaseDir is not provided', async () => {
    const secrets = generateAllSecrets('int-test-key');

    await saveKeysToDirectory(secrets, { baseDir: testDir, env: 'dev' });

    const keysDir = join(testDir, AUTHRIM_DIR, 'dev', 'keys');
    expect(existsSync(join(keysDir, 'private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'metadata.json'))).toBe(true);
  }, 15_000);
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

describe('ensureSupplementalKeyFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      `.test-supplemental-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('backfills keys required by deploy-time Admin Machine Access', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    mkdirSync(keysDir, { recursive: true });
    const keyPair = generateRsaKeyPair('legacy-key');
    writeFileSync(join(keysDir, 'private.pem'), keyPair.privateKeyPem);
    writeFileSync(join(keysDir, 'public.jwk.json'), JSON.stringify(keyPair.publicKeyJwk));
    writeFileSync(join(keysDir, 'metadata.json'), JSON.stringify({ kid: 'legacy-key', files: {} }));

    const result = await ensureSupplementalKeyFiles(keysDir);

    expect(result.createdFiles).toHaveLength(14);
    expect(existsSync(join(keysDir, 'object_encryption_root_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'pii_encryption_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'vc_transaction_code_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'otp_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'logging_cursor_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'flow_runtime_hmac_secret.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'plugin_encryption_key.txt'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_machine_private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'setup_machine_public.jwk.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'admin_ui_bff_private.pem'))).toBe(true);
    expect(existsSync(join(keysDir, 'admin_ui_bff_public.jwk.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_signing_private.jwk.json'))).toBe(
      true
    );
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_verify.jwks.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'))).toBe(true);

    const setupJwk = JSON.parse(
      readFileSync(join(keysDir, 'setup_machine_public.jwk.json'), 'utf-8')
    );
    const adminUiBffJwk = JSON.parse(
      readFileSync(join(keysDir, 'admin_ui_bff_public.jwk.json'), 'utf-8')
    );
    const tenantRuntimeRegistryJwks = JSON.parse(
      readFileSync(join(keysDir, 'tenant_runtime_registry_verify.jwks.json'), 'utf-8')
    );
    const tenantRuntimeRegistryKeyId = readFileSync(
      join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
      'utf-8'
    );
    expect(setupJwk.kid).toBe('legacy-key-setup');
    expect(setupJwk.alg).toBe('ES256');
    expect(adminUiBffJwk.kid).toBe('legacy-key-admin-ui-bff');
    expect(adminUiBffJwk.alg).toBe('ES256');
    expect(tenantRuntimeRegistryKeyId).toBe('legacy-key-tenant-runtime-registry');
    expect(tenantRuntimeRegistryJwks.keys[0]).toEqual(
      expect.objectContaining({
        kid: 'legacy-key-tenant-runtime-registry',
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
      })
    );

    const secondResult = await ensureSupplementalKeyFiles(keysDir);
    expect(secondResult.createdFiles).toHaveLength(0);
  });

  it('removes legacy static secret files and metadata references', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    mkdirSync(keysDir, { recursive: true });
    const keyPair = generateRsaKeyPair('legacy-key');
    writeFileSync(join(keysDir, 'private.pem'), keyPair.privateKeyPem);
    writeFileSync(join(keysDir, 'public.jwk.json'), JSON.stringify(keyPair.publicKeyJwk));
    for (const fileName of [
      'admin_api_secret.txt',
      'key_manager_secret.txt',
      'version_manager_secret.txt',
    ]) {
      writeFileSync(join(keysDir, fileName), 'legacy-secret');
    }
    writeFileSync(
      join(keysDir, 'metadata.json'),
      JSON.stringify({
        kid: 'legacy-key',
        files: {
          adminApiSecret: 'admin_api_secret.txt',
          keyManagerSecret: 'key_manager_secret.txt',
          versionManagerSecret: 'version_manager_secret.txt',
        },
      })
    );

    await ensureSupplementalKeyFiles(keysDir);

    expect(existsSync(join(keysDir, 'admin_api_secret.txt'))).toBe(false);
    expect(existsSync(join(keysDir, 'key_manager_secret.txt'))).toBe(false);
    expect(existsSync(join(keysDir, 'version_manager_secret.txt'))).toBe(false);
    const metadata = JSON.parse(readFileSync(join(keysDir, 'metadata.json'), 'utf-8'));
    expect(metadata.files).not.toHaveProperty('adminApiSecret');
    expect(metadata.files).not.toHaveProperty('keyManagerSecret');
    expect(metadata.files).not.toHaveProperty('versionManagerSecret');
  });

  it('rejects partial supplemental machine key pairs', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, 'setup_machine_private.pem'), 'partial');

    await expect(ensureSupplementalKeyFiles(keysDir)).rejects.toThrow(
      /Incomplete machine key pair/
    );
  });

  it('rejects partial tenant runtime registry key sets', async () => {
    const keysDir = join(testDir, AUTHRIM_KEYS_DIR, 'prod');
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, 'tenant_runtime_registry_signing_private.jwk.json'), '{}');

    await expect(ensureSupplementalKeyFiles(keysDir)).rejects.toThrow(
      /Incomplete tenant runtime registry key set/
    );
  });
});

describe('generateWranglerSecretCommands', () => {
  it('includes PUBLIC_JWK_JSON upload command', () => {
    const secrets = generateAllSecrets('test-key');
    const commands = generateWranglerSecretCommands(secrets, '/tmp/keys', 'dev');

    expect(commands).toContain(
      'cat /tmp/keys/public.jwk.json | wrangler secret put PUBLIC_JWK_JSON --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/object_encryption_root_key.txt)" | wrangler secret put OBJECT_ENCRYPTION_ROOT_KEY --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/pii_encryption_key.txt)" | wrangler secret put PII_ENCRYPTION_KEY --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/otp_hmac_secret.txt)" | wrangler secret put OTP_HMAC_SECRET --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/logging_cursor_hmac_secret.txt)" | wrangler secret put LOGGING_CURSOR_HMAC_SECRET --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/flow_runtime_hmac_secret.txt)" | wrangler secret put FLOW_RUNTIME_HMAC_SECRET --env dev'
    );
    expect(commands).toContain(
      'echo -n "$(cat /tmp/keys/plugin_encryption_key.txt)" | wrangler secret put PLUGIN_ENCRYPTION_KEY --env dev'
    );
  });
});
