import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import authApp from '../index';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const legacyBase = ['/api/auth', 'upgrade'].join('/');
const legacyPaths = [legacyBase, `${legacyBase}/complete`, `${legacyBase}/status`];
const officialBase = ['/api/account', 'guest-upgrade'].join('/');
const readRepositoryFile = (path: string) => readFileSync(`${repositoryRoot}/${path}`, 'utf8');

describe('legacy guest upgrade API removal contract', () => {
  it('does not register a legacy route or retain its handler module', () => {
    const registeredRoutes = authApp.routes.map(({ method, path }) => `${method} ${path}`);

    expect(registeredRoutes).not.toContain(`POST ${legacyPaths[0]}`);
    expect(registeredRoutes).not.toContain(`POST ${legacyPaths[1]}`);
    expect(registeredRoutes).not.toContain(`GET ${legacyPaths[2]}`);
    expect(existsSync(`${repositoryRoot}/packages/ar-auth/src/upgrade.ts`)).toBe(false);
    expect(existsSync(`${repositoryRoot}/packages/ar-auth/src/__tests__/upgrade.test.ts`)).toBe(
      false
    );
  });

  it('does not publish legacy paths or components in the Auth OpenAPI contract', () => {
    const openapi = readRepositoryFile('packages/ar-auth/openapi/auth.openapi.yaml');

    for (const path of legacyPaths) expect(openapi).not.toContain(path);
    for (const component of [
      'UpgradeStartRequest:',
      'UpgradeStartResponse:',
      'UpgradeCompleteRequest:',
      'UpgradeCompleteResponse:',
      'UpgradeStatusResponse:',
    ]) {
      expect(openapi).not.toContain(component);
    }
  });

  it('publishes only the three official Account Page endpoints', () => {
    const managementRoutes = readRepositoryFile('packages/ar-management/src/index.ts');
    const managementOpenapi = readRepositoryFile(
      'packages/ar-management/openapi/user-self-service.openapi.yaml'
    );
    const loginUiApi = readRepositoryFile('packages/ar-login-ui/src/lib/api/account.ts');
    const officialPaths = [officialBase, `${officialBase}/start`, `${officialBase}/complete`];

    for (const path of officialPaths) {
      expect(managementRoutes).toContain(path);
      expect(managementOpenapi).toContain(path);
      expect(loginUiApi).toContain(path);
    }
    for (const path of legacyPaths) expect(loginUiApi).not.toContain(path);
  });

  it('does not retain legacy upgrade session state or method types', () => {
    const authSources = [
      'packages/ar-auth/src/index.ts',
      'packages/ar-auth/src/email-code.ts',
      'packages/ar-auth/src/passkey.ts',
      'packages/ar-lib-core/src/types/contracts/client.ts',
    ].map(readRepositoryFile);
    for (const source of authSources) {
      for (const path of legacyPaths) expect(source).not.toContain(path);
    }
    for (const field of [
      'pending_upgrade_token',
      'pending_upgrade_method',
      'verified_upgrade_method',
      'verified_email_at',
      'verified_email_user_id',
      'upgrade_nonce',
      'user.upgraded',
    ]) {
      expect(authSources.join('\n')).not.toContain(field);
    }
    expect(authSources.join('\n')).not.toMatch(/allowedUpgradeMethods\?[^\n]+(?:social|phone)/);
  });
});
