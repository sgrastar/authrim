import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const readRepositoryFile = (path: string) => readFileSync(`${repositoryRoot}/${path}`, 'utf8');
const legacySettingsPath = ['/api/admin/settings', 'guest-auth'].join('/');

describe('legacy device guest settings API removal contract', () => {
  it('does not register or document the compatibility settings endpoint', () => {
    const routes = readRepositoryFile('packages/ar-management/src/index.ts');
    const openapi = readRepositoryFile('packages/ar-management/openapi/admin.openapi.yaml');

    expect(routes).not.toContain(legacySettingsPath);
    expect(openapi).not.toContain(legacySettingsPath);
    for (const component of [
      'AdminSettingsAnonymousAuthUpdate:',
      'AdminSettingsAnonymousAuth:',
      'AdminSettingsAnonymousAuthUpdateRequest:',
      'AdminSettingsAnonymousAuthResponse:',
      'AdminSettingsAnonymousAuthUpdateResponse:',
    ]) {
      expect(openapi).not.toContain(component);
    }
  });

  it('does not retain its handler exports or legacy KV configuration keys', () => {
    const source = readRepositoryFile('packages/ar-management/src/routes/guest-users.ts');
    const removedTokens = [
      ['get', 'GuestAuthConfig'].join(''),
      ['update', 'GuestAuthConfig'].join(''),
      ['feature_flag', ['ENABLE', 'GUEST', 'DEVICE', 'AUTH'].join('_')].join(':'),
      ['guest_auth', 'default_expires_in_days'].join(':'),
      ['guest_auth', 'cleanup_interval_hours'].join(':'),
    ];

    for (const token of removedTokens) expect(source).not.toContain(token);
    expect(source).toContain('listGuestUsers');
    expect(source).toContain('deleteGuestUser');
    expect(source).toContain('cleanupExpiredGuestUsers');
  });
});
