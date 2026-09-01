import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLocalEnvironmentArtifacts } from '../core/environment-cleanup.js';
import {
  checkWranglerStatus,
  extractEnvironmentSectionFromToml,
  mergeEnvironmentSectionIntoToml,
  removeEnvironmentSectionFromToml,
  writeWranglerFileAtomically,
} from '../core/wrangler-sync.js';

const tempDirs: string[] = [];

describe('removeEnvironmentSectionFromToml', () => {
  it('removes only the requested env section and preserves others', () => {
    const content = `main = "src/index.ts"
compatibility_date = "2024-09-23"

# Environment: test
[env.test]
name = "test-ar-saml"

[env.test.vars]
FOO = "bar"

# Environment: single
[env.single]
name = "single-ar-saml"

[env.single.vars]
FOO = "baz"
`;

    const result = removeEnvironmentSectionFromToml(content, 'test');

    expect(result.removed).toBe(true);
    expect(result.content).not.toContain('[env.test]');
    expect(result.content).toContain('[env.single]');
  });

  it('merges a generated env section without overwriting other environments', () => {
    const deployContent = `main = "src/index.ts"

# Environment: prod
[env.prod]
name = "prod-old"

# Environment: staging
[env.staging]
name = "staging-current"
`;
    const masterContent = `# Environment: prod
[env.prod]
name = "prod-new"
`;

    const merged = mergeEnvironmentSectionIntoToml(deployContent, masterContent, 'prod');

    expect(merged).toContain('name = "prod-new"');
    expect(merged).not.toContain('name = "prod-old"');
    expect(merged).toContain('[env.staging]');
    expect(merged).toContain('name = "staging-current"');
  });

  it('does not inject generated top-level wrangler keys into an env section', () => {
    const deployContent = `main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Environment: conformance
[env.conformance]
name = "conformance-old"

# Environment: test
[env.test]
name = "test-current"
`;
    const masterContent = `main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Environment: conformance
[env.conformance]
name = "conformance-new"

[env.conformance.vars]
FOO = "bar"
`;

    const merged = mergeEnvironmentSectionIntoToml(deployContent, masterContent, 'conformance');
    const conformanceSection = extractEnvironmentSectionFromToml(merged, 'conformance');

    expect(conformanceSection).toContain('name = "conformance-new"');
    expect(conformanceSection).toContain('[env.conformance.vars]');
    expect(conformanceSection).not.toContain('main = "src/index.ts"');
    expect(conformanceSection).not.toContain('compatibility_date = "2024-09-23"');
    expect(merged.match(/^main = "src\/index\.ts"$/gm) ?? []).toHaveLength(1);
  });

  it('advances the generated top-level Durable Object migration history while preserving other envs', () => {
    const deployContent = `main = "src/index.ts"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SessionStore"]

# Environment: prod
[env.prod]
name = "prod-old"

# Environment: staging
[env.staging]
name = "staging-current"
`;
    const masterContent = `main = "src/index.ts"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SessionStore"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["KeyManager"]

# Environment: prod
[env.prod]
name = "prod-new"
`;

    const merged = mergeEnvironmentSectionIntoToml(deployContent, masterContent, 'prod');

    expect(merged).toContain('tag = "v1"');
    expect(merged).toContain('tag = "v2"');
    expect(merged).toContain('new_sqlite_classes = ["KeyManager"]');
    expect(merged).toContain('[env.staging]');
    expect(merged).toContain('name = "staging-current"');
    expect(merged).toContain('name = "prod-new"');
    expect(merged).not.toContain('name = "prod-old"');
  });
});

describe('cleanupLocalEnvironmentArtifacts', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('removes local env directories and package wrangler sections for the deleted env', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-'));
    tempDirs.push(baseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const externalKeysDir = join(baseDir, '.authrim-keys', 'test');
    const packagesDir = join(baseDir, 'packages');
    const samlDir = join(packagesDir, 'ar-saml');

    await mkdir(envDir, { recursive: true });
    await mkdir(externalKeysDir, { recursive: true });
    await mkdir(samlDir, { recursive: true });

    await writeFile(join(envDir, 'config.json'), '{}', 'utf-8');
    await writeFile(join(externalKeysDir, 'private.pem'), 'secret', 'utf-8');
    await writeFile(
      join(samlDir, 'wrangler.toml'),
      `main = "src/index.ts"
compatibility_date = "2024-09-23"

# Environment: test
[env.test]
name = "test-ar-saml"

# Environment: single
[env.single]
name = "single-ar-saml"
`,
      'utf-8'
    );

    const progress: string[] = [];

    const result = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      packagesDir,
      keysBaseDir: baseDir,
      onProgress: (message) => progress.push(message),
    });

    expect(result.errors).toEqual([]);
    expect(existsSync(envDir)).toBe(false);
    expect(existsSync(externalKeysDir)).toBe(false);
    await expect(readFile(join(samlDir, 'wrangler.toml'), 'utf-8')).resolves.not.toContain(
      '[env.test]'
    );
    await expect(readFile(join(samlDir, 'wrangler.toml'), 'utf-8')).resolves.toContain(
      '[env.single]'
    );
    expect(progress.at(-1)).toContain('Removed environment directory');
  });

  it('preserves the environment inventory when a preceding local cleanup step fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-failure-'));
    tempDirs.push(baseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const brokenWranglerPath = join(baseDir, 'packages', 'ar-saml', 'wrangler.toml');
    await mkdir(envDir, { recursive: true });
    await mkdir(brokenWranglerPath, { recursive: true });
    await writeFile(join(envDir, 'lock.json'), '{"env":"test"}', 'utf-8');

    const result = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      packagesDir: join(baseDir, 'packages'),
      keysBaseDir: baseDir,
    });

    expect(result.errors).toEqual([
      expect.stringContaining('Failed to clean wrangler.toml for ar-saml'),
    ]);
    expect(existsSync(envDir)).toBe(true);
    await expect(readFile(join(envDir, 'lock.json'), 'utf-8')).resolves.toContain('"test"');
  });

  it('keeps the original wrangler bytes and environment inventory when atomic publication fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-atomic-failure-'));
    tempDirs.push(baseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const samlDir = join(baseDir, 'packages', 'ar-saml');
    const wranglerPath = join(samlDir, 'wrangler.toml');
    const original = `main = "src/index.ts"

# Environment: test
[env.test]
name = "test-ar-saml"

# Environment: single
[env.single]
name = "single-ar-saml"
`;
    await mkdir(envDir, { recursive: true });
    await mkdir(samlDir, { recursive: true });
    await writeFile(join(envDir, 'lock.json'), '{"env":"test"}', 'utf-8');
    await writeFile(wranglerPath, original, 'utf-8');

    const failed = await cleanupLocalEnvironmentArtifacts(
      {
        baseDir,
        env: 'test',
        packagesDir: join(baseDir, 'packages'),
      },
      {
        writeWranglerFile: async () => {
          throw new Error('simulated_atomic_publication_failure');
        },
      }
    );

    expect(failed.errors).toEqual([
      expect.stringContaining('simulated_atomic_publication_failure'),
    ]);
    await expect(readFile(wranglerPath, 'utf-8')).resolves.toBe(original);
    expect(existsSync(envDir)).toBe(true);

    const retried = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      packagesDir: join(baseDir, 'packages'),
    });
    expect(retried.errors).toEqual([]);
    const reflected = await readFile(wranglerPath, 'utf-8');
    expect(reflected).not.toContain('[env.test]');
    expect(reflected).toContain('[env.single]');
    expect(existsSync(envDir)).toBe(false);
  });

  it('resumes safely when an atomic rename committed before the writer reported failure', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-atomic-ambiguous-'));
    tempDirs.push(baseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const samlDir = join(baseDir, 'packages', 'ar-saml');
    const wranglerPath = join(samlDir, 'wrangler.toml');
    await mkdir(envDir, { recursive: true });
    await mkdir(samlDir, { recursive: true });
    await writeFile(join(envDir, 'lock.json'), '{"env":"test"}', 'utf-8');
    await writeFile(
      wranglerPath,
      `main = "src/index.ts"

# Environment: test
[env.test]
name = "test-ar-saml"

# Environment: single
[env.single]
name = "single-ar-saml"
`,
      'utf-8'
    );

    const first = await cleanupLocalEnvironmentArtifacts(
      {
        baseDir,
        env: 'test',
        packagesDir: join(baseDir, 'packages'),
      },
      {
        writeWranglerFile: async (path, content) => {
          await writeWranglerFileAtomically(path, content);
          throw new Error('simulated_post_commit_ack_loss');
        },
      }
    );
    expect(first.errors).toEqual([expect.stringContaining('simulated_post_commit_ack_loss')]);
    expect(existsSync(envDir)).toBe(true);
    await expect(readFile(wranglerPath, 'utf-8')).resolves.not.toContain('[env.test]');
    await expect(readFile(wranglerPath, 'utf-8')).resolves.toContain('[env.single]');

    const retried = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      packagesDir: join(baseDir, 'packages'),
    });
    expect(retried.errors).toEqual([]);
    expect(existsSync(envDir)).toBe(false);
    await expect(readFile(wranglerPath, 'utf-8')).resolves.toContain('[env.single]');
  });

  it('removes the external key directory pinned by config instead of the current cwd default', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-pinned-keys-'));
    const pinnedBaseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-pinned-base-'));
    const unrelatedBaseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-unrelated-base-'));
    tempDirs.push(baseDir, pinnedBaseDir, unrelatedBaseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const pinnedKeysDir = join(pinnedBaseDir, '.authrim-keys', 'test');
    const unrelatedKeysDir = join(unrelatedBaseDir, '.authrim-keys', 'test');
    await mkdir(envDir, { recursive: true });
    await mkdir(pinnedKeysDir, { recursive: true });
    await mkdir(unrelatedKeysDir, { recursive: true });
    await writeFile(join(pinnedKeysDir, 'private.pem'), 'pinned', 'utf-8');
    await writeFile(join(unrelatedKeysDir, 'private.pem'), 'unrelated', 'utf-8');
    await writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({
        keys: {
          storageType: 'external',
          secretsPath: `${pinnedKeysDir}/`,
        },
      }),
      'utf-8'
    );

    const result = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      keysBaseDir: unrelatedBaseDir,
    });

    expect(result.errors).toEqual([]);
    expect(existsSync(pinnedKeysDir)).toBe(false);
    expect(existsSync(unrelatedKeysDir)).toBe(true);
    expect(existsSync(envDir)).toBe(false);
  });

  it.each(['./keys/', 'keys/'])(
    'maps the historical external-key placeholder %s to the environment-scoped key bundle',
    async (secretsPath) => {
      const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-placeholder-keys-'));
      tempDirs.push(baseDir);
      const envDir = join(baseDir, '.authrim', 'conformance');
      const selectedKeysDir = join(baseDir, '.authrim-keys', 'conformance');
      const unrelatedKeysDir = join(baseDir, '.authrim-keys', 'scaleout');
      await mkdir(envDir, { recursive: true });
      await mkdir(selectedKeysDir, { recursive: true });
      await mkdir(unrelatedKeysDir, { recursive: true });
      await writeFile(
        join(envDir, 'config.json'),
        JSON.stringify({ keys: { storageType: 'external', secretsPath } }),
        'utf-8'
      );
      await writeFile(join(selectedKeysDir, 'private.pem'), 'selected', 'utf-8');
      await writeFile(join(unrelatedKeysDir, 'private.pem'), 'unrelated', 'utf-8');

      const result = await cleanupLocalEnvironmentArtifacts({
        baseDir,
        env: 'conformance',
        keysBaseDir: baseDir,
      });

      expect(result.errors).toEqual([]);
      expect(existsSync(envDir)).toBe(false);
      expect(existsSync(selectedKeysDir)).toBe(false);
      expect(existsSync(unrelatedKeysDir)).toBe(true);
    }
  );

  it('does not remove a same-name external key bundle for an internal-key environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-internal-keys-'));
    tempDirs.push(baseDir);

    const envDir = join(baseDir, '.authrim', 'test');
    const unrelatedExternalKeysDir = join(baseDir, '.authrim-keys', 'test');
    await mkdir(envDir, { recursive: true });
    await mkdir(unrelatedExternalKeysDir, { recursive: true });
    await writeFile(
      join(envDir, 'config.json'),
      `${JSON.stringify({ keys: { storageType: 'internal' } })}\n`,
      'utf-8'
    );
    await writeFile(join(unrelatedExternalKeysDir, 'private.pem'), 'unrelated-secret', 'utf-8');

    const result = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      keysBaseDir: baseDir,
    });

    expect(result.errors).toEqual([]);
    expect(existsSync(envDir)).toBe(false);
    expect(existsSync(unrelatedExternalKeysDir)).toBe(true);
    await expect(readFile(join(unrelatedExternalKeysDir, 'private.pem'), 'utf-8')).resolves.toBe(
      'unrelated-secret'
    );
  });

  it('preserves config when its pinned external key path is invalid', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-cleanup-invalid-keys-'));
    tempDirs.push(baseDir);
    const envDir = join(baseDir, '.authrim', 'test');
    await mkdir(envDir, { recursive: true });
    await writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({
        keys: {
          storageType: 'external',
          secretsPath: join(baseDir, '.authrim-keys', 'another-environment'),
        },
      }),
      'utf-8'
    );

    const result = await cleanupLocalEnvironmentArtifacts({ baseDir, env: 'test' });

    expect(result.errors).toEqual([expect.stringContaining('external_keys_config_path_mismatch')]);
    expect(existsSync(envDir)).toBe(true);
  });
});

describe('checkWranglerStatus', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('requires both the selected environment and generated top-level deployment settings', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'authrim-wrangler-status-'));
    tempDirs.push(baseDir);
    const masterDir = join(baseDir, '.authrim', 'test', 'wrangler');
    const packageDir = join(baseDir, 'packages', 'ar-saml');
    await mkdir(masterDir, { recursive: true });
    await mkdir(packageDir, { recursive: true });
    const environmentSection = '# Environment: test\n[env.test]\nname = "test-ar-saml"\n';
    await writeFile(
      join(masterDir, 'ar-saml.toml'),
      `main = "src/index.ts"\n[build]\ncommand = "managed"\n\n${environmentSection}`,
      'utf8'
    );
    await writeFile(
      join(packageDir, 'wrangler.toml'),
      `main = "src/index.ts"\n\n${environmentSection}`,
      'utf8'
    );

    const [status] = await checkWranglerStatus({
      baseDir,
      env: 'test',
      packagesDir: join(baseDir, 'packages'),
      components: ['ar-saml'],
    });

    expect(status.inSync).toBe(false);
  });
});
