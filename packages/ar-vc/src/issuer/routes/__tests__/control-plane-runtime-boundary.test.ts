/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('VC issuer Control Plane runtime boundary', () => {
  it('resolves custom-claim storage through the unified tenant/account runtime sources', () => {
    const source = readFileSync(resolve(testDir, '..', 'credential.ts'), 'utf-8');

    expect(source).toContain('resolveCustomClaimRuntimeSourcesFromEnv');
    expect(source).toContain('accountId: `account:${tokenResult.userId}`');
    expect(source).toContain('runtimeSources.schemaDb');
    expect(source).toContain('runtimeSources.piiDb');
    expect(source).not.toMatch(/ensureDatabaseAdapter\(\s*c\.env\.DB_PII/u);
    expect(source).not.toMatch(/ensureDatabaseAdapter\(\s*c\.env\.DB/u);
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
