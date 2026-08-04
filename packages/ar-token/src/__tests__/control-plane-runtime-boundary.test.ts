import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('token Control Plane runtime boundary', () => {
  it('uses Hono runtime contexts for tenant-owned core and PII token lookups', () => {
    const source = readFileSync(resolve(testDir, '..', 'token.ts'), 'utf-8');

    expect(source).toContain('createAuthContextFromHono');
    expect(source).toContain('createPIIContextFromHono');
    expect(source).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB/u);
    expect(source).not.toMatch(/new\s+User(Core|PII)Repository\s*\(\s*c\.env\.DB_PII/u);
  });

  it('resolves trusted authorization-code and refresh subjects before account data access', () => {
    const source = readFileSync(resolve(testDir, '..', 'token.ts'), 'utf-8');
    const authorizationCodeRoute = source.indexOf(
      'resolveTrustedSubjectAccountRoute(c, authCodeData.sub)'
    );
    const authorizationCodeContext = source.indexOf(
      'createAccountAuthContextFromHono(c, tenantId)',
      authorizationCodeRoute
    );
    const refreshRoute = source.indexOf(
      'resolveTrustedSubjectAccountRoute(c, refreshTokenData.sub)'
    );
    const refreshContext = source.indexOf(
      'createAccountAuthContextFromHono(c, tenantId)',
      refreshRoute
    );

    expect(authorizationCodeRoute).toBeGreaterThan(-1);
    expect(authorizationCodeContext).toBeGreaterThan(authorizationCodeRoute);
    expect(refreshRoute).toBeGreaterThan(authorizationCodeContext);
    expect(refreshContext).toBeGreaterThan(refreshRoute);
  });

  it('atomically reserves approved device codes before token issuance', () => {
    const source = readFileSync(resolve(testDir, '..', 'token.ts'), 'utf-8');
    const approvedBranch = source.indexOf("// Status is 'approved' - issue tokens");
    const consumeCall = source.indexOf('https://internal/mark-token-issued', approvedBranch);
    const signingKeyLoad = source.indexOf('getSigningKeyFromKeyManager', approvedBranch);

    expect(approvedBranch).toBeGreaterThan(-1);
    expect(consumeCall).toBeGreaterThan(approvedBranch);
    expect(consumeCall).toBeLessThan(signingKeyLoad);
  });
});
