import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getEnvironmentPaths,
  getLegacyPaths,
  detectStructure,
  needsMigration,
  listEnvironments,
  environmentExists,
  resolvePaths,
  validateEnvName,
  getRelativeKeysPath,
  getLegacyRelativeKeysPath,
  AUTHRIM_DIR,
  LEGACY_CONFIG_FILE,
  LEGACY_LOCK_FILE,
  LEGACY_KEYS_DIR,
} from '../core/paths.js';

describe('paths module', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `authrim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getEnvironmentPaths', () => {
    it('should generate correct paths for environment', () => {
      const paths = getEnvironmentPaths({ baseDir: '/project', env: 'dev' });

      expect(paths.root).toBe('/project/.authrim/dev');
      expect(paths.config).toBe('/project/.authrim/dev/config.json');
      expect(paths.lock).toBe('/project/.authrim/dev/lock.json');
      expect(paths.version).toBe('/project/.authrim/dev/version.txt');
      expect(paths.keys).toBe('/project/.authrim/dev/keys');
      expect(paths.keyFiles.privateKey).toBe('/project/.authrim/dev/keys/private.pem');
      expect(paths.keyFiles.publicKey).toBe('/project/.authrim/dev/keys/public.jwk.json');
      expect(paths.keyFiles.setupToken).toBe('/project/.authrim/dev/keys/setup_token.txt');
    });

    it('should handle environment names with hyphens', () => {
      const paths = getEnvironmentPaths({ baseDir: '/project', env: 'my-staging-env' });

      expect(paths.root).toBe('/project/.authrim/my-staging-env');
      expect(paths.config).toBe('/project/.authrim/my-staging-env/config.json');
    });

    it('should handle relative base directory', () => {
      const paths = getEnvironmentPaths({ baseDir: '.', env: 'prod' });

      // join('.', 'path') returns 'path' without leading './'
      expect(paths.root).toBe('.authrim/prod');
      expect(paths.config).toBe('.authrim/prod/config.json');
    });
  });

  describe('getLegacyPaths', () => {
    it('should generate correct legacy paths', () => {
      const paths = getLegacyPaths('/project', 'dev');

      expect(paths.config).toBe('/project/authrim-config.json');
      expect(paths.lock).toBe('/project/authrim-lock.json');
      expect(paths.keys).toBe('/project/.keys/dev');
      expect(paths.keyFiles.privateKey).toBe('/project/.keys/dev/private.pem');
    });

    it('should handle different environments', () => {
      const devPaths = getLegacyPaths('/project', 'dev');
      const prodPaths = getLegacyPaths('/project', 'prod');

      // Config and lock are the same (global)
      expect(devPaths.config).toBe(prodPaths.config);
      expect(devPaths.lock).toBe(prodPaths.lock);

      // Keys are different per environment
      expect(devPaths.keys).toBe('/project/.keys/dev');
      expect(prodPaths.keys).toBe('/project/.keys/prod');
    });
  });

  describe('detectStructure', () => {
    it('should detect new structure', () => {
      // Create new structure
      const envDir = join(testDir, AUTHRIM_DIR, 'dev');
      mkdirSync(envDir, { recursive: true });
      writeFileSync(join(envDir, 'config.json'), '{}');

      const result = detectStructure(testDir);

      expect(result.type).toBe('new');
      expect(result.envs).toContain('dev');
    });

    it('should detect multiple environments in new structure', () => {
      // Create multiple environments
      for (const env of ['dev', 'staging', 'prod']) {
        const envDir = join(testDir, AUTHRIM_DIR, env);
        mkdirSync(envDir, { recursive: true });
        writeFileSync(join(envDir, 'config.json'), '{}');
      }

      const result = detectStructure(testDir);

      expect(result.type).toBe('new');
      expect(result.envs).toHaveLength(3);
      expect(result.envs).toContain('dev');
      expect(result.envs).toContain('staging');
      expect(result.envs).toContain('prod');
    });

    it('should detect legacy structure with config file', () => {
      writeFileSync(
        join(testDir, LEGACY_CONFIG_FILE),
        JSON.stringify({ environment: { prefix: 'myenv' } })
      );

      const result = detectStructure(testDir);

      expect(result.type).toBe('legacy');
      expect(result.legacyEnv).toBe('myenv');
    });

    it('should detect legacy structure with lock file', () => {
      writeFileSync(join(testDir, LEGACY_LOCK_FILE), JSON.stringify({ env: 'testenv' }));

      const result = detectStructure(testDir);

      expect(result.type).toBe('legacy');
      expect(result.legacyEnv).toBe('testenv');
    });

    it('should detect legacy structure from .keys directory', () => {
      const keysDir = join(testDir, LEGACY_KEYS_DIR, 'fromkeys');
      mkdirSync(keysDir, { recursive: true });

      const result = detectStructure(testDir);

      expect(result.type).toBe('legacy');
      expect(result.legacyEnv).toBe('fromkeys');
    });

    it('should return none for empty directory', () => {
      const result = detectStructure(testDir);

      expect(result.type).toBe('none');
      expect(result.envs).toHaveLength(0);
    });

    it('should prefer new structure over legacy when both exist', () => {
      // Create both structures
      const newEnvDir = join(testDir, AUTHRIM_DIR, 'newenv');
      mkdirSync(newEnvDir, { recursive: true });
      writeFileSync(join(newEnvDir, 'config.json'), '{}');

      writeFileSync(join(testDir, LEGACY_CONFIG_FILE), JSON.stringify({ environment: { prefix: 'legacyenv' } }));

      const result = detectStructure(testDir);

      expect(result.type).toBe('new');
      expect(result.envs).toContain('newenv');
    });
  });

  describe('needsMigration', () => {
    it('should return true for legacy structure', () => {
      writeFileSync(join(testDir, LEGACY_CONFIG_FILE), '{}');

      expect(needsMigration(testDir)).toBe(true);
    });

    it('should return false for new structure', () => {
      const envDir = join(testDir, AUTHRIM_DIR, 'dev');
      mkdirSync(envDir, { recursive: true });
      writeFileSync(join(envDir, 'config.json'), '{}');

      expect(needsMigration(testDir)).toBe(false);
    });

    it('should return false for empty directory', () => {
      expect(needsMigration(testDir)).toBe(false);
    });
  });

  describe('listEnvironments', () => {
    it('should list environments from new structure', () => {
      for (const env of ['alpha', 'beta']) {
        const envDir = join(testDir, AUTHRIM_DIR, env);
        mkdirSync(envDir, { recursive: true });
        writeFileSync(join(envDir, 'config.json'), '{}');
      }

      const envs = listEnvironments(testDir);

      expect(envs).toHaveLength(2);
      expect(envs).toContain('alpha');
      expect(envs).toContain('beta');
    });

    it('should list environments from legacy .keys structure', () => {
      for (const env of ['dev', 'prod']) {
        const keysDir = join(testDir, LEGACY_KEYS_DIR, env);
        mkdirSync(keysDir, { recursive: true });
      }

      const envs = listEnvironments(testDir);

      expect(envs).toHaveLength(2);
      expect(envs).toContain('dev');
      expect(envs).toContain('prod');
    });

    it('should combine environments from both structures', () => {
      // New structure
      const newEnvDir = join(testDir, AUTHRIM_DIR, 'new-env');
      mkdirSync(newEnvDir, { recursive: true });
      writeFileSync(join(newEnvDir, 'config.json'), '{}');

      // Legacy structure
      const legacyKeysDir = join(testDir, LEGACY_KEYS_DIR, 'legacy-env');
      mkdirSync(legacyKeysDir, { recursive: true });

      const envs = listEnvironments(testDir);

      expect(envs).toHaveLength(2);
      expect(envs).toContain('new-env');
      expect(envs).toContain('legacy-env');
    });

    it('should return sorted list', () => {
      for (const env of ['zebra', 'alpha', 'beta']) {
        const envDir = join(testDir, AUTHRIM_DIR, env);
        mkdirSync(envDir, { recursive: true });
        writeFileSync(join(envDir, 'config.json'), '{}');
      }

      const envs = listEnvironments(testDir);

      expect(envs).toEqual(['alpha', 'beta', 'zebra']);
    });

    it('should return empty array for empty directory', () => {
      const envs = listEnvironments(testDir);

      expect(envs).toHaveLength(0);
    });
  });

  describe('environmentExists', () => {
    it('should return true for existing new structure environment', () => {
      const envDir = join(testDir, AUTHRIM_DIR, 'existing');
      mkdirSync(envDir, { recursive: true });
      writeFileSync(join(envDir, 'config.json'), '{}');

      expect(environmentExists(testDir, 'existing')).toBe(true);
    });

    it('should return true for existing legacy environment', () => {
      const keysDir = join(testDir, LEGACY_KEYS_DIR, 'legacy-existing');
      mkdirSync(keysDir, { recursive: true });

      expect(environmentExists(testDir, 'legacy-existing')).toBe(true);
    });

    it('should return false for non-existing environment', () => {
      expect(environmentExists(testDir, 'nonexistent')).toBe(false);
    });
  });

  describe('resolvePaths', () => {
    it('should use new structure when forceNew is true', () => {
      const result = resolvePaths({ baseDir: testDir, env: 'test', forceNew: true });

      expect(result.type).toBe('new');
      expect(result.paths.config).toContain('.authrim');
    });

    it('should use legacy structure when forceLegacy is true', () => {
      const result = resolvePaths({ baseDir: testDir, env: 'test', forceLegacy: true });

      expect(result.type).toBe('legacy');
      expect(result.paths.config).toContain('authrim-config.json');
    });

    it('should detect existing new structure', () => {
      const envDir = join(testDir, AUTHRIM_DIR, 'detected');
      mkdirSync(envDir, { recursive: true });

      const result = resolvePaths({ baseDir: testDir, env: 'detected' });

      expect(result.type).toBe('new');
    });

    it('should detect existing legacy structure', () => {
      writeFileSync(join(testDir, LEGACY_CONFIG_FILE), '{}');

      const result = resolvePaths({ baseDir: testDir, env: 'any' });

      expect(result.type).toBe('legacy');
    });

    it('should default to new structure for new environments', () => {
      const result = resolvePaths({ baseDir: testDir, env: 'brandnew' });

      expect(result.type).toBe('new');
    });
  });

  describe('validateEnvName', () => {
    it('should accept valid environment names', () => {
      expect(validateEnvName('dev')).toBe(true);
      expect(validateEnvName('prod')).toBe(true);
      expect(validateEnvName('staging')).toBe(true);
      expect(validateEnvName('my-env')).toBe(true);
      expect(validateEnvName('env123')).toBe(true);
      expect(validateEnvName('a1-b2-c3')).toBe(true);
    });

    it('should reject invalid environment names', () => {
      expect(validateEnvName('')).toBe(false);
      expect(validateEnvName('123')).toBe(false); // Must start with letter
      expect(validateEnvName('Dev')).toBe(false); // No uppercase
      expect(validateEnvName('my_env')).toBe(false); // No underscores
      expect(validateEnvName('-env')).toBe(false); // Must start with letter
      expect(validateEnvName('env-')).toBe(true); // Trailing hyphen is OK
      expect(validateEnvName('my env')).toBe(false); // No spaces
    });
  });

  describe('getRelativeKeysPath', () => {
    it('should return relative path for new structure', () => {
      expect(getRelativeKeysPath()).toBe('./keys/');
    });
  });

  describe('getLegacyRelativeKeysPath', () => {
    it('should return relative path for legacy structure', () => {
      expect(getLegacyRelativeKeysPath('dev')).toBe('./.keys/dev/');
      expect(getLegacyRelativeKeysPath('prod')).toBe('./.keys/prod/');
    });
  });
});
