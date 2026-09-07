import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const productionSourceExtension = /\.(?:js|mjs|ts|tsx|svelte)$/u;
const testFilePattern = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:spec|test)\.[^.]+$/u;
const rootDynamicImportPattern = /\bimport\s*\(\s*(['"])@authrim\/ar-lib-core\1\s*\)/u;

async function listProductionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(packagesRoot, fullPath);

      if (testFilePattern.test(relativePath)) return [];
      if (entry.isDirectory()) return listProductionSourceFiles(fullPath);
      if (entry.isFile() && productionSourceExtension.test(entry.name)) return [fullPath];
      return [];
    })
  );

  return nested.flat();
}

describe('ar-lib-core dynamic import boundary', () => {
  it('does not dynamically load the root entrypoint from production package sources', async () => {
    const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
    const sourceDirectories = packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesRoot, entry.name, 'src'));
    const sourceFiles = (
      await Promise.all(
        sourceDirectories.map(async (directory) => {
          try {
            return await listProductionSourceFiles(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
          }
        })
      )
    ).flat();

    const violations: string[] = [];
    await Promise.all(
      sourceFiles.map(async (file) => {
        const source = await readFile(file, 'utf8');
        if (rootDynamicImportPattern.test(source)) {
          violations.push(path.relative(packagesRoot, file));
        }
      })
    );

    expect(violations.sort()).toEqual([]);
  });

  it('exposes ReBACService through a narrow package subpath', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(packagesRoot, 'ar-lib-core', 'package.json'), 'utf8')
    ) as { exports: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./rebac/rebac-service');
  });
});
