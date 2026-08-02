import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_ROOTS = [
  'packages/ar-auth/src',
  'packages/ar-management/src',
  'packages/ar-policy/src',
  'packages/ar-bridge/src',
  'packages/ar-saml/src',
  'packages/ar-lib-core/src',
] as const;
const RUNTIME_SOURCE_ROOTS = SOURCE_ROOTS.filter((root) => root !== 'packages/ar-lib-core/src');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function matchingFiles(pattern: RegExp, roots: readonly string[] = SOURCE_ROOTS): string[] {
  return roots
    .flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(REPO_ROOT, path))
    .sort();
}

describe('sync hook production call-site inventory', () => {
  it('forbids direct human-verification provider execution in Runtime and Management', () => {
    expect(matchingFiles(/verifyHumanVerificationToken\(/u)).toEqual([]);
  });

  it('centralizes the typed Runner sync RPC production call', () => {
    expect(
      matchingFiles(/\.runHumanVerification\(|\.runPolicyDecision\(|\.runFlowHook\(/u)
    ).toEqual(['packages/ar-lib-core/src/services/human-verification-runner.ts']);
  });

  it('freezes the remaining Runtime and Management plugin-key references', () => {
    expect(matchingFiles(/PLUGIN_ENCRYPTION_KEY/u, RUNTIME_SOURCE_ROOTS)).toEqual([
      'packages/ar-management/src/authentication-methods.ts',
      'packages/ar-management/src/provider-reprojection-jobs.ts',
      'packages/ar-management/src/routes/settings/plugins.ts',
    ]);
  });
});
