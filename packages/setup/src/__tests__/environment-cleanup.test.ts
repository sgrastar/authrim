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
