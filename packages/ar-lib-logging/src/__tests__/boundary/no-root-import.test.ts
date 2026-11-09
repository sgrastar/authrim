import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const sourcePathspecs = ['cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'svelte', 'ts', 'tsx'].map(
  (extension) => `*.${extension}`
);
const loggingPackageName = ['@authrim', 'ar-lib-logging'].join('/');
const importQuoteMarks = ["'", '"', String.fromCharCode(96)];
const forbiddenSpecifiers = [loggingPackageName, `${loggingPackageName}/registry`].flatMap(
  (specifier) => importQuoteMarks.map((quote) => `${quote}${specifier}${quote}`)
);

describe('logging repository import boundary', () => {
  it('forbids root and legacy registry specifiers in production code and tests', () => {
    // Search tracked source only: generated Storybook and test workspaces are not repository code.
    const result = spawnSync(
      'git',
      [
        'grep',
        '-l',
        '-F',
        ...forbiddenSpecifiers.flatMap((specifier) => ['-e', specifier]),
        '--',
        ...sourcePathspecs,
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr || `git grep exited with ${result.status}`);
    }
    expect(result.stdout.trim().split('\n').filter(Boolean).sort()).toEqual([]);
  });
});
