import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('authorization logging security contract', () => {
  it('does not install the raw Hono access logger on authorization requests', async () => {
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("from 'hono/logger'");
    expect(source).not.toContain("app.use('*', logger())");
  });

  it('does not emit session, user, or authorization-code fragments', async () => {
    const source = await readFile(new URL('../authorize.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('sessionIdPrefix:');
    expect(source).not.toContain('sessionUserId: session?.userId');
    expect(source).not.toContain('sidPrefix:');
    expect(source).not.toContain('codePrefix:');
    expect(source).not.toContain('instanceName: authCodeStoreInstanceName');
  });

  it('resolves routed account data before consent and fails closed on consent errors', async () => {
    const source = await readFile(new URL('../authorize.ts', import.meta.url), 'utf8');
    const accountRoute = source.indexOf("'auth_authorize_account_route'");
    const consentEvaluation = source.indexOf('// Check if consent is required');
    const consentFailure = source.indexOf(
      "return sendError('temporarily_unavailable', 'Unable to evaluate consent requirements')"
    );

    expect(accountRoute).toBeGreaterThan(0);
    expect(accountRoute).toBeLessThan(consentEvaluation);
    expect(consentFailure).toBeGreaterThan(consentEvaluation);
  });
});
