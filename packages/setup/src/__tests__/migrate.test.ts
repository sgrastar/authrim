/**
 * Tests for migrate.ts - Migration from legacy to new structure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  needsMigration,
  getEnvironmentsToMigrate,
  createBackup,
  migrateToNewStructure,
  validateMigration,
  getMigrationStatus,
} from '../core/migrate.js';
import {
  LEGACY_CONFIG_FILE,
  LEGACY_LOCK_FILE,
  LEGACY_KEYS_DIR,
  AUTHRIM_DIR,
} from '../core/paths.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createTempDir(): string {
  const tempDir = join(
    tmpdir(),
    `authrim-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function createLegacyStructure(baseDir: string, env: string = 'dev'): void {
  // Create legacy config
  const config = {
    version: '1.0.0',
    environment: { prefix: env },
    profile: 'basic-op',
    tenant: { name: 'test', displayName: 'Test' },
    components: { api: true, loginUi: true, adminUi: true },
    oidc: {
      accessTokenTtl: 3600,
      refreshTokenTtl: 86400,
      authCodeTtl: 600,
      pkceRequired: true,
      responseTypes: ['code'],
      grantTypes: ['authorization_code'],
    },
    sharding: { authCodeShards: 4, refreshTokenShards: 4 },
    features: {},
    keys: { secretsPath: './.keys/' },
  };
  writeFileSync(join(baseDir, LEGACY_CONFIG_FILE), JSON.stringify(config, null, 2));

  // Create legacy lock
  const lock = {
    version: '1.0.0',
    env,
    createdAt: new Date().toISOString(),
    d1: { CORE_DB: { id: 'db-123', name: `${env}-authrim-core-db` } },
    kv: { SETTINGS: { id: 'kv-123', name: `${env}-SETTINGS` } },
  };
  writeFileSync(join(baseDir, LEGACY_LOCK_FILE), JSON.stringify(lock, null, 2));

  // Create legacy keys directory
  const keysDir = join(baseDir, LEGACY_KEYS_DIR, env);
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(
    join(keysDir, 'private.pem'),
    '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
  );
  writeFileSync(
    join(keysDir, 'public.jwk.json'),
    JSON.stringify({ kty: 'RSA', n: 'test', e: 'AQAB' })
  );
  writeFileSync(join(keysDir, 'admin_api_secret.txt'), 'secret-123');
}

function createNewStructure(baseDir: string, env: string = 'dev'): void {
  const envDir = join(baseDir, AUTHRIM_DIR, env);
  mkdirSync(envDir, { recursive: true });
  mkdirSync(join(envDir, 'keys'), { recursive: true });

  // Create config
  const config = {
    version: '1.0.0',
    environment: { prefix: env },
    profile: 'basic-op',
    tenant: { name: 'test', displayName: 'Test' },
    components: { api: true },
    oidc: {
      accessTokenTtl: 3600,
      refreshTokenTtl: 86400,
      authCodeTtl: 600,
      pkceRequired: true,
      responseTypes: ['code'],
      grantTypes: ['authorization_code'],
    },
    sharding: { authCodeShards: 4, refreshTokenShards: 4 },
    features: {},
    keys: { secretsPath: './keys/' },
  };
  writeFileSync(join(envDir, 'config.json'), JSON.stringify(config, null, 2));

  // Create lock
  const lock = {
    version: '1.0.0',
    env,
    createdAt: new Date().toISOString(),
    d1: {},
    kv: {},
  };
  writeFileSync(join(envDir, 'lock.json'), JSON.stringify(lock, null, 2));

  // Create version.txt
  writeFileSync(join(envDir, 'version.txt'), '0.1.0');

  // Create keys
  writeFileSync(
    join(envDir, 'keys', 'private.pem'),
    '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
  );
  writeFileSync(join(envDir, 'keys', 'public.jwk.json'), JSON.stringify({ kty: 'RSA' }));
}

// =============================================================================
// Tests
// =============================================================================

describe('migrate.ts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('needsMigration', () => {
    it('should return true for legacy structure', () => {
      createLegacyStructure(tempDir, 'dev');
      expect(needsMigration(tempDir)).toBe(true);
    });

    it('should return false for new structure', () => {
      createNewStructure(tempDir, 'dev');
      expect(needsMigration(tempDir)).toBe(false);
    });

    it('should return false for empty directory', () => {
      expect(needsMigration(tempDir)).toBe(false);
    });
  });

  describe('getEnvironmentsToMigrate', () => {
    it('should detect environment from legacy config', () => {
      createLegacyStructure(tempDir, 'prod');
      const envs = getEnvironmentsToMigrate(tempDir);
      expect(envs).toContain('prod');
    });

    it('should detect environments from .keys directory', () => {
      // Create .keys with multiple environments but no config
      mkdirSync(join(tempDir, LEGACY_KEYS_DIR, 'dev'), { recursive: true });
      mkdirSync(join(tempDir, LEGACY_KEYS_DIR, 'staging'), { recursive: true });

      const envs = getEnvironmentsToMigrate(tempDir);
      expect(envs).toContain('dev');
      expect(envs).toContain('staging');
    });

    it('should return empty array for empty directory', () => {
      const envs = getEnvironmentsToMigrate(tempDir);
      expect(envs).toEqual([]);
    });
  });

  describe('createBackup', () => {
    it('should create backup of legacy files', async () => {
      createLegacyStructure(tempDir, 'dev');

      const result = await createBackup(tempDir);

      expect(result.success).toBe(true);
      expect(result.backupPath).toContain('.authrim-backup-');
      expect(result.files.length).toBeGreaterThan(0);
      expect(existsSync(result.backupPath)).toBe(true);
      expect(existsSync(join(result.backupPath, LEGACY_CONFIG_FILE))).toBe(true);
      expect(existsSync(join(result.backupPath, LEGACY_LOCK_FILE))).toBe(true);
    });

    it('should handle empty directory gracefully', async () => {
      const result = await createBackup(tempDir);

      expect(result.success).toBe(true);
      expect(result.files).toEqual([]);
    });
  });

  describe('migrateToNewStructure', () => {
    it(
      'should migrate legacy structure to new structure',
      async () => {
        createLegacyStructure(tempDir, 'dev');

        const result = await migrateToNewStructure({
          baseDir: tempDir,
          noBackup: true,
        });

        expect(result.success).toBe(true);
        expect(result.migratedEnvs).toContain('dev');
        expect(result.errors).toEqual([]);

        // Check new structure exists
        const newConfigPath = join(tempDir, AUTHRIM_DIR, 'dev', 'config.json');
        const newLockPath = join(tempDir, AUTHRIM_DIR, 'dev', 'lock.json');
        const newVersionPath = join(tempDir, AUTHRIM_DIR, 'dev', 'version.txt');
        const newKeysDir = join(tempDir, AUTHRIM_DIR, 'dev', 'keys');

        expect(existsSync(newConfigPath)).toBe(true);
        expect(existsSync(newLockPath)).toBe(true);
        expect(existsSync(newVersionPath)).toBe(true);
        expect(existsSync(newKeysDir)).toBe(true);
        expect(existsSync(join(newKeysDir, 'private.pem'))).toBe(true);
      },
      { timeout: 30000 }
    );

    it('should create backup by default', async () => {
      createLegacyStructure(tempDir, 'dev');

      const result = await migrateToNewStructure({
        baseDir: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    it('should handle dry run mode', async () => {
      createLegacyStructure(tempDir, 'dev');

      const result = await migrateToNewStructure({
        baseDir: tempDir,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.migratedEnvs).toContain('dev');

      // New structure should NOT exist in dry run
      const newConfigPath = join(tempDir, AUTHRIM_DIR, 'dev', 'config.json');
      expect(existsSync(newConfigPath)).toBe(false);
    });

    it('should skip migration for new structure', async () => {
      createNewStructure(tempDir, 'dev');

      const result = await migrateToNewStructure({
        baseDir: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.migratedEnvs).toEqual([]);
    });

    it('should update secretsPath in migrated config', async () => {
      createLegacyStructure(tempDir, 'dev');

      await migrateToNewStructure({
        baseDir: tempDir,
        noBackup: true,
      });

      const newConfigPath = join(tempDir, AUTHRIM_DIR, 'dev', 'config.json');
      const config = JSON.parse(readFileSync(newConfigPath, 'utf-8'));
      expect(config.keys.secretsPath).toBe('./keys/');
    });
  });

  describe('validateMigration', () => {
    it('should validate successful migration', async () => {
      createLegacyStructure(tempDir, 'dev');
      const migrateResult = await migrateToNewStructure({ baseDir: tempDir, noBackup: true });
      expect(migrateResult.success).toBe(true);

      const result = await validateMigration(tempDir, 'dev');

      // If validation fails, show the issues for debugging
      if (!result.valid) {
        console.log('Validation issues:', result.issues);
      }

      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('should detect missing config.json', async () => {
      const envDir = join(tempDir, AUTHRIM_DIR, 'dev');
      mkdirSync(envDir, { recursive: true });
      // Only create lock.json, not config.json
      writeFileSync(join(envDir, 'lock.json'), '{}');

      const result = await validateMigration(tempDir, 'dev');

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('config.json not found');
    });

    it('should detect missing keys directory', async () => {
      const envDir = join(tempDir, AUTHRIM_DIR, 'dev');
      mkdirSync(envDir, { recursive: true });

      // Create minimal valid config and lock
      const config = {
        version: '1.0.0',
        environment: { prefix: 'dev' },
        profile: 'basic-op',
        tenant: { name: 'test', displayName: 'Test' },
        components: { api: true },
        oidc: {
          accessTokenTtl: 3600,
          refreshTokenTtl: 86400,
          authCodeTtl: 600,
          pkceRequired: true,
          responseTypes: ['code'],
          grantTypes: ['authorization_code'],
        },
        sharding: { authCodeShards: 4, refreshTokenShards: 4 },
        features: {},
        keys: { secretsPath: './keys/' },
      };
      writeFileSync(join(envDir, 'config.json'), JSON.stringify(config));
      writeFileSync(
        join(envDir, 'lock.json'),
        JSON.stringify({
          version: '1.0.0',
          env: 'dev',
          d1: {},
          kv: {},
          createdAt: new Date().toISOString(),
        })
      );
      writeFileSync(join(envDir, 'version.txt'), '0.1.0');

      const result = await validateMigration(tempDir, 'dev');

      expect(result.valid).toBe(false);
      expect(result.issues).toContain('keys/ directory not found');
    });
  });

  describe('getMigrationStatus', () => {
    it('should return correct status for legacy structure', () => {
      createLegacyStructure(tempDir, 'dev');

      const status = getMigrationStatus(tempDir);

      expect(status.needsMigration).toBe(true);
      expect(status.currentStructure).toBe('legacy');
      expect(status.environments).toContain('dev');
      expect(status.legacyFiles).toContain(LEGACY_CONFIG_FILE);
      expect(status.legacyFiles).toContain(LEGACY_LOCK_FILE);
    });

    it('should return correct status for new structure', () => {
      createNewStructure(tempDir, 'prod');

      const status = getMigrationStatus(tempDir);

      expect(status.needsMigration).toBe(false);
      expect(status.currentStructure).toBe('new');
      expect(status.environments).toContain('prod');
    });

    it('should return correct status for empty directory', () => {
      const status = getMigrationStatus(tempDir);

      expect(status.needsMigration).toBe(false);
      expect(status.currentStructure).toBe('none');
      expect(status.environments).toEqual([]);
    });
  });
});
