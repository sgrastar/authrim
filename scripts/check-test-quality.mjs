#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const roots = ['packages', 'test', 'test-e2e'];
const errors = [];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (['node_modules', 'dist', 'coverage', '.svelte-kit'].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    else files.push(entryPath);
  }

  return files;
}

const files = (
  await Promise.all(
    roots.map(async (root) => {
      try {
        return await walk(path.join(repoRoot, root));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    })
  )
)
  .flat()
  .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));

const forbiddenPatterns = [
  [/\b(?:describe|it|test)\.only\s*\(/, 'focused .only test'],
  [/expect\(true\)\.toBe\(true\)/, 'trivial true assertion'],
  [/TODO:\s*Implement test/i, 'unimplemented test placeholder'],
];

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  for (const [pattern, description] of forbiddenPatterns) {
    if (pattern.test(source)) {
      errors.push(`${path.relative(repoRoot, file)}: contains ${description}`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Canonical test quality check failed:\n- ${errors.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Canonical test quality check passed (${files.length} test file(s)).\n`);
}
