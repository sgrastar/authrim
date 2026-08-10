import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|svelte|ts|tsx)$/u;
const ignoredDirectories = new Set([
  '.authrim',
  '.git',
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
const loggingPackageName = ['@authrim', 'ar-lib-logging'].join('/');
const importQuoteMarks = ["'", '"', String.fromCharCode(96)];
const forbiddenSpecifiers = [loggingPackageName, `${loggingPackageName}/registry`].flatMap(
  (specifier) => importQuoteMarks.map((quote) => `${quote}${specifier}${quote}`)
);

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        return [];
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(fullPath);
      }
      if (entry.isFile() && sourceExtension.test(entry.name)) {
        return [fullPath];
      }
      return [];
    })
  );

  return nested.flat();
}

describe('logging repository import boundary', () => {
  it('forbids root and legacy registry specifiers in production code and tests', async () => {
    const sourceFiles = await listSourceFiles(repoRoot);
    const violations: string[] = [];

    await Promise.all(
      sourceFiles.map(async (file) => {
        const source = await readFile(file, 'utf8');
        if (forbiddenSpecifiers.some((specifier) => source.includes(specifier))) {
          violations.push(path.relative(repoRoot, file));
        }
      })
    );

    expect(violations.sort()).toEqual([]);
  });
});
