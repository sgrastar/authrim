import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../../..');
const srcRoot = resolve(packageRoot, 'src');
const runtimeSourceEntries = [
  resolve(srcRoot, 'core'),
  resolve(srcRoot, 'adapters'),
  resolve(srcRoot, 'previews'),
  resolve(srcRoot, 'source-profiles'),
  resolve(srcRoot, 'contract.ts'),
  resolve(srcRoot, 'runtime.ts'),
  resolve(srcRoot, 'authoring.ts'),
  resolve(srcRoot, 'experimental.ts'),
];

const forbiddenImportPrefixes = ['node:'];
const forbiddenExactImports = [
  'fs',
  'path',
  'url',
  'crypto',
  'buffer',
  'stream',
  'process',
  'hono',
  'cloudflare:workers',
  '@authrim/ar-lib-core',
  '@authrim/ar-lib-policy',
  '@authrim/ar-management',
  '@authrim/ar-auth',
  '@authrim/ar-token',
  'wrangler',
];

describe('no-runtime boundary', () => {
  it('does not import runtime-only modules from source files', () => {
    const violations: string[] = [];

    for (const file of listRuntimeTsFiles(runtimeSourceEntries)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of forbiddenExactImports) {
        if (hasImportSpecifier(source, forbidden)) {
          violations.push(`${file}: ${forbidden}`);
        }
      }
      for (const forbiddenPrefix of forbiddenImportPrefixes) {
        if (hasImportSpecifierPrefix(source, forbiddenPrefix)) {
          violations.push(`${file}: ${forbiddenPrefix}*`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps package dependencies on the allowlist', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
  });
});

function listRuntimeTsFiles(paths: string[]): string[] {
  return paths.flatMap((path) => (statSync(path).isDirectory() ? listTsFiles(path) : [path]));
}

function hasImportSpecifier(source: string, specifier: string): boolean {
  return (
    source.includes(`from '${specifier}'`) ||
    source.includes(`from "${specifier}"`) ||
    source.includes(`import('${specifier}')`) ||
    source.includes(`import("${specifier}")`)
  );
}

function hasImportSpecifierPrefix(source: string, prefix: string): boolean {
  return (
    source.includes(`from '${prefix}`) ||
    source.includes(`from "${prefix}`) ||
    source.includes(`import('${prefix}`) ||
    source.includes(`import("${prefix}`)
  );
}

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listTsFiles(path));
      continue;
    }
    if (extname(path) === '.ts') {
      files.push(path);
    }
  }
  return files;
}
