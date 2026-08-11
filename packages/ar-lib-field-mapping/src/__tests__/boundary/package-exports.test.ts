import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../../..');
const repositoryRoot = resolve(packageRoot, '../..');
const barePackageSpecifier = ['@authrim', 'ar-lib-field-mapping'].join('/');
const ignoredRepositoryDirectories = new Set([
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const guardedSourceExtensions = new Set([
  '.astro',
  '.cjs',
  '.cts',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);

describe('package export boundary', () => {
  it('publishes only explicit contract, runtime, authoring, experimental, and test exports', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      './authoring',
      './contract',
      './experimental',
      './runtime',
      './test-support',
    ]);
    expect(Object.prototype.hasOwnProperty.call(packageJson.exports, '.')).toBe(false);
    expect(packageJson).not.toHaveProperty('main');
    expect(packageJson).not.toHaveProperty('types');
    expect(existsSync(resolve(packageRoot, 'src/index.ts'))).toBe(false);
  });

  it('keeps contract type-only and prevents entrypoint dependency inversion', () => {
    const contract = readFileSync(resolve(packageRoot, 'src/contract.ts'), 'utf8');
    const runtime = readFileSync(resolve(packageRoot, 'src/runtime.ts'), 'utf8');
    const authoring = readFileSync(resolve(packageRoot, 'src/authoring.ts'), 'utf8');

    expect(contract).not.toMatch(/export\s*\{/);
    for (const entrypoint of [contract, runtime, authoring]) {
      expect(entrypoint).not.toMatch(/\b(?:class|function|const|let|var)\s+/);
    }
    expect(moduleSpecifiers(contract).sort()).toEqual(['./core/types']);
    expect(moduleSpecifiers(runtime).sort()).toEqual(['./core/catalog', './core/runtime']);
  });

  it('does not expose preview adapters or test helpers from stable entrypoints', () => {
    const stableSources = ['contract.ts', 'runtime.ts', 'authoring.ts']
      .map((file) => readFileSync(resolve(packageRoot, 'src', file), 'utf8'))
      .join('\n');

    expect(stableSources).not.toContain('./adapters');
    expect(stableSources).not.toContain('./test-support');
    expect(stableSources).not.toContain('adaptCsvPreview');
    expect(stableSources).not.toContain('validateStaticFixture');
  });

  it('keeps preview adapters in the experimental export', () => {
    const experimental = readFileSync(resolve(packageRoot, 'src/experimental.ts'), 'utf8');

    expect(experimental).toContain('adaptCsvPreview');
    expect(experimental).toContain("from './adapters'");
  });

  it('exports documented stable transform execution API from authoring', () => {
    const authoring = readFileSync(resolve(packageRoot, 'src/authoring.ts'), 'utf8');
    const contract = readFileSync(resolve(packageRoot, 'src/contract.ts'), 'utf8');

    expect(authoring).toContain('executeTransformStep');
    expect(contract).toContain('TransformExecutionInput');
    expect(contract).toContain('TransformExecutionResult');
  });

  it('forbids the removed bare-root import throughout the repository', () => {
    const violations: string[] = [];

    for (const file of listRepositorySourceFiles(repositoryRoot)) {
      const source = readFileSync(file, 'utf8');
      if (hasBareRootReference(source)) {
        violations.push(relative(repositoryRoot, file));
      }
    }

    expect(violations).toEqual([]);
  }, 15_000);

  it('recognizes exact bare imports with every supported quote style', () => {
    for (const quote of ["'", '"', '`']) {
      expect(
        hasBareRootReference(`const loaded = import(${quote}${barePackageSpecifier}${quote});`)
      ).toBe(true);
    }
    expect(
      hasBareRootReference(`const loaded = import(\`${barePackageSpecifier}/runtime\`);`)
    ).toBe(false);
    expect(hasBareRootReference(`{ "${barePackageSpecifier}": "workspace:*" }`)).toBe(false);
  });

  it('excludes transient test workspaces without excluding tracked dot-directories', () => {
    expect(shouldIgnoreRepositoryDirectory('.test-generated-env-example')).toBe(true);
    expect(shouldIgnoreRepositoryDirectory('.test-keys-example')).toBe(true);
    expect(shouldIgnoreRepositoryDirectory('.github')).toBe(false);
  });
});

function listRepositorySourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && shouldIgnoreRepositoryDirectory(entry.name)) {
      continue;
    }
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRepositorySourceFiles(path));
      continue;
    }
    if (entry.isFile() && guardedSourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function shouldIgnoreRepositoryDirectory(name: string): boolean {
  return ignoredRepositoryDirectories.has(name) || name.startsWith('.test-');
}

function hasBareRootReference(source: string): boolean {
  const quotedSpecifier = `(['"\`])${escapeRegExp(barePackageSpecifier)}\\1`;
  const patterns = [
    new RegExp(`\\bfrom\\s*${quotedSpecifier}`),
    new RegExp(`\\bimport\\s*\\(\\s*${quotedSpecifier}\\s*\\)`),
    new RegExp(`\\brequire\\s*\\(\\s*${quotedSpecifier}\\s*\\)`),
    new RegExp(
      `\\b(?:vi|jest)\\.(?:doMock|importActual|importMock|mock|unmock)\\s*\\(\\s*${quotedSpecifier}`
    ),
    new RegExp(`(?:^|[;\\n])\\s*import\\s*${quotedSpecifier}`, 'm'),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:vi|jest)\.mock\s*\(\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/gm,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
