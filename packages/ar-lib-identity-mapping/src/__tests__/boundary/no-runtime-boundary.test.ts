import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../../..');
const srcRoot = resolve(packageRoot, 'src');

const forbiddenImports = [
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

    for (const file of listTsFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of forbiddenImports) {
        if (
          source.includes(`from '${forbidden}'`) ||
          source.includes(`from "${forbidden}"`) ||
          source.includes(`import('${forbidden}')`) ||
          source.includes(`import("${forbidden}")`)
        ) {
          violations.push(`${file}: ${forbidden}`);
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
