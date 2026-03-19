import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLocalEnvironmentArtifacts } from '../core/environment-cleanup.js';
import { removeEnvironmentSectionFromToml } from '../core/wrangler-sync.js';

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

    const result = await cleanupLocalEnvironmentArtifacts({
      baseDir,
      env: 'test',
      packagesDir,
      keysBaseDir: baseDir,
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
  });
});
