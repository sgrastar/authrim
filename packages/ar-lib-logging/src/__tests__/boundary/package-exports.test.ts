import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const expectedExports = {
  './archive': {
    import: './dist/archive.js',
    types: './dist/archive.d.ts',
    default: './src/archive.ts',
  },
  './chunks': {
    import: './dist/chunks/index.js',
    types: './dist/chunks/index.d.ts',
    default: './src/chunks/index.ts',
  },
  './contract': {
    import: './dist/contract/index.js',
    types: './dist/contract/index.d.ts',
    default: './src/contract/index.ts',
  },
  './coverage': {
    import: './dist/coverage/index.js',
    types: './dist/coverage/index.d.ts',
    default: './src/coverage/index.ts',
  },
  './delivery': {
    import: './dist/delivery/index.js',
    types: './dist/delivery/index.d.ts',
    default: './src/delivery/index.ts',
  },
  './destinations': {
    import: './dist/destinations/index.js',
    types: './dist/destinations/index.d.ts',
    default: './src/destinations/index.ts',
  },
  './keys': {
    import: './dist/keys/index.js',
    types: './dist/keys/index.d.ts',
    default: './src/keys/index.ts',
  },
  './messaging': {
    import: './dist/messaging/index.js',
    types: './dist/messaging/index.d.ts',
    default: './src/messaging/index.ts',
  },
  './policies': {
    import: './dist/policies/index.js',
    types: './dist/policies/index.d.ts',
    default: './src/policies/index.ts',
  },
};

describe('logging package export boundary', () => {
  it('publishes only explicit contract and implementation subpaths', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      main?: string;
      types?: string;
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports).toEqual(expectedExports);
    expect(Object.hasOwn(packageJson.exports, '.')).toBe(false);
    expect(packageJson).not.toHaveProperty('main');
    expect(packageJson).not.toHaveProperty('types');
    expect(existsSync(resolve(packageRoot, 'src/index.ts'))).toBe(false);
  });

  it('keeps the contract entrypoint free from implementation entrypoints', () => {
    const contractIndex = readFileSync(resolve(packageRoot, 'src/contract/index.ts'), 'utf8');
    const moduleSpecifiers = Array.from(
      contractIndex.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu),
      (match) => match[1]
    ).sort();

    expect(moduleSpecifiers).toEqual(['../ids', '../registry', '../tenant-key', '../time']);
    expect(contractIndex).toContain("export * from '../ids';");
    expect(contractIndex).toContain("export * from '../registry';");
    expect(contractIndex).toContain("export * from '../tenant-key';");
    expect(contractIndex).toContain("export * from '../time';");
  });
});
