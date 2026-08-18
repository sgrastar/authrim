import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const AUDITED_MUTATION_ROUTES = [
  'DELETE /api/account/devices/:id',
  'DELETE /api/account/passkeys/:id',
  'DELETE /api/account/sessions/:id',
  'DELETE /api/account/totp/:id',
  'DELETE /me/devices/:id',
  'PATCH /api/account/devices/:id',
  'PATCH /api/account/passkeys/:id',
  'PATCH /api/account/profile',
  'PATCH /api/account/totp/:id',
  'PATCH /me/devices/:id',
  'POST /api/account/identifier-replacements/complete',
  'POST /api/account/passkeys/complete',
  'POST /api/account/reauth/email-code/complete',
  'POST /api/account/reauth/passkey/complete',
  'POST /api/account/reauth/totp/complete',
  'POST /api/account/totp/activate',
  'POST /api/account/totp/backup-codes/regenerate',
  'POST /api/account/totp/options',
] as const;

// These routes only issue or consume short-lived navigation/authentication challenges.
// They do not change durable account profile, credential, device, or session state.
const EPHEMERAL_MUTATION_ROUTES = [
  'POST /api/account/identifier-replacements/start',
  'POST /api/account/passkeys/options',
  'POST /api/account/reauth/email-code/send',
  'POST /api/account/reauth/passkey/options',
  'POST /api/account/return',
  'POST /api/account/return/:id/consume',
] as const;

const ACCOUNT_AUDIT_ACTIONS = [
  'account.device.unlinked',
  'account.device.updated',
  'account.email.added',
  'account.email.changed',
  'account.email.reauthenticated',
  'account.passkey.created',
  'account.passkey.deleted',
  'account.passkey.reauthenticated',
  'account.passkey.updated',
  'account.profile.name_updated',
  'account.session.revoked',
  'account.totp.activated',
  'account.totp.backup_codes_regenerated',
  'account.totp.enrollment_started',
  'account.totp.reauthenticated',
  'account.totp.removed',
  'account.totp.updated',
] as const;

const AUDIT_PRODUCER_FILES = [
  'packages/ar-management/src/account-page.ts',
  'packages/ar-management/src/account-identifier-replacement.ts',
  'packages/ar-management/src/account-passkeys.ts',
  'packages/ar-management/src/account-sessions.ts',
  'packages/ar-management/src/account-totp.ts',
  'packages/ar-management/src/identifier-replacement-scheduled.ts',
  'packages/ar-management/src/self-service-devices.ts',
] as const;

function readRepositoryFile(path: string): string {
  return readFileSync(`${REPO_ROOT}${path}`, 'utf8');
}

describe('Account Page audit coverage', () => {
  it('requires every state-changing Account Page route to be classified', () => {
    const indexSource = readRepositoryFile('packages/ar-management/src/index.ts');
    const actualRoutes = [...indexSource.matchAll(/app\.(post|patch|delete)\(\s*'([^']+)'/gu)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .filter((route) => route.includes(' /api/account/') || route.includes(' /me/'))
      .sort();

    expect(actualRoutes).toEqual([...AUDITED_MUTATION_ROUTES, ...EPHEMERAL_MUTATION_ROUTES].sort());
  });

  it('keeps emitted account actions visible in Admin and Account Activity', () => {
    const producerSource = AUDIT_PRODUCER_FILES.map(readRepositoryFile).join('\n');
    const emittedActions = [
      ...new Set(
        [...producerSource.matchAll(/action:\s*'(account\.[^']+)'/gu)].map((match) => match[1])
      ),
    ].sort();
    expect(emittedActions).toEqual([...ACCOUNT_AUDIT_ACTIONS].sort());

    const adminLabels = readRepositoryFile(
      'packages/ar-admin-ui/src/lib/admin/account-audit-action-label.ts'
    );
    const accountActivity = readRepositoryFile(
      'packages/ar-login-ui/src/lib/components/account/AccountActivitySection.svelte'
    );
    for (const action of ACCOUNT_AUDIT_ACTIONS) {
      expect(adminLabels).toContain(`'${action}'`);
      expect(accountActivity).toContain(`'${action}'`);
    }
  });
});
