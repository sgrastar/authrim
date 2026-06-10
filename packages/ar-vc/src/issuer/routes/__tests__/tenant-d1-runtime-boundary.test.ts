/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('VC issuer tenant-d1 runtime boundary', () => {
  it('resolves custom-claim PII storage through runtime user-store sources', () => {
    const source = readFileSync(resolve(testDir, '..', 'credential.ts'), 'utf-8');

    expect(source).toContain('resolveUserStoreRuntimeSourcesFromEnv');
    expect(source).toContain('runtimeSources.piiDb ?? runtimeSources.coreDb');
    expect(source).not.toMatch(/ensureDatabaseAdapter\(\s*c\.env\.DB_PII/u);
  });

  it('enforces holder binding policy before issuing credentials', () => {
    const source = readFileSync(resolve(testDir, '..', 'credential.ts'), 'utf-8');

    expect(source).toContain('createVCConfigManager');
    expect(source).toContain('isHolderBindingRequired');
    expect(source).toContain('!holderBinding');
    expect(source.indexOf('const vcConfig = createVCConfigManager')).toBeLessThan(
      source.indexOf('const sdjwtvc = await createSDJWTVC')
    );
  });
});
