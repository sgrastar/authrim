import type { D1Database } from '@cloudflare/workers-types';
import {
  ensureDatabaseAdapter,
  findCanonicalAccountAuthenticationState,
  isCanonicalAccountIdForUser,
  transitionAccountAuthenticationState,
  type AccountDirectoryPublication,
  type Env,
} from '@authrim/ar-lib-core';

export async function activatePublishedAccountAuthenticationState(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  tenantCore: D1Database,
  publication: AccountDirectoryPublication,
  activatedAtSeconds: number
): Promise<void> {
  const userId = publication.accountId.startsWith('account:')
    ? publication.accountId.slice('account:'.length)
    : '';
  if (!isCanonicalAccountIdForUser(publication.accountId, userId)) {
    throw new Error('directory_account_authentication_identity_invalid');
  }

  const authenticationState = await findCanonicalAccountAuthenticationState(
    ensureDatabaseAdapter(tenantCore, 'account-directory-authentication-state'),
    publication.tenantId,
    userId
  );
  if (!authenticationState) {
    throw new Error('directory_account_authentication_state_invalid');
  }

  const activatedAtMs = activatedAtSeconds * 1000;
  if (!Number.isSafeInteger(activatedAtMs) || activatedAtMs < 1) {
    throw new Error('directory_account_authentication_version_invalid');
  }
  await transitionAccountAuthenticationState(env, {
    tenantId: publication.tenantId,
    userId,
    lifecycle: authenticationState.lifecycle,
    sourceVersionMs: Math.max(authenticationState.sourceVersionMs + 1, activatedAtMs),
    operationId: `directory.${publication.operationId}`,
    revokeSessions: authenticationState.lifecycle !== 'active',
  });
}
