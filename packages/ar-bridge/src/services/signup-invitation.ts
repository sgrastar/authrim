/**
 * Invitations carried by an external IdP sign-in (OIDC/OAuth)
 *
 * The rules are shared with the SAML SP (`@authrim/ar-lib-core/services/external-signup-invitation`):
 * the start reserves one use, held by the sign-in's flow; the callback creates no account for
 * another email than the invitation names, applies the use only to an account it created, and
 * gives it back otherwise. This module resolves the tenant metadata database for them.
 */

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { getLogger, resolveAuthCorePersistenceAdapterFromEnv } from '@authrim/ar-lib-core';
import {
  applyExternalSignupInvitation as applyShared,
  externalSignupInvitationRequirement as requirementShared,
  releaseExternalSignupInvitation as releaseShared,
  reserveExternalSignupInvitation as reserveShared,
  type ExternalSignupInvitation,
  type ExternalSignupInvitationRequirement,
} from '@authrim/ar-lib-core/services/external-signup-invitation';

export type { ExternalSignupInvitation };

type BridgeLogger = ReturnType<ReturnType<typeof getLogger>['module']>;

function invitationDatabase(env: Env, tenantId: string, operation: string) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, `bridge-invitation:${operation}`, {
    tenantId,
  });
}

/**
 * How long a sign-in's reservation holds the use: its state (10 minutes) and a provisioning
 * continuation (5 minutes) both fit, and an abandoned start holds it no longer than that.
 */
export const EXTERNAL_INVITATION_RESERVATION_TTL_SECONDS = 15 * 60;

/** Reserves one use for a sign-in that starts, held by its flow. Null when unusable. */
export async function reserveExternalSignupInvitation(
  env: Env,
  input: { token: string; tenantId: string; flowId: string }
): Promise<ExternalSignupInvitation | null> {
  return reserveShared(await invitationDatabase(env, input.tenantId, 'reserve'), {
    token: input.token,
    tenantId: input.tenantId,
    holder: `external:${input.flowId}`,
    ttlSeconds: EXTERNAL_INVITATION_RESERVATION_TTL_SECONDS,
  });
}

/** What the invitation asks of the account a callback would create (null: nothing). */
export async function externalSignupInvitationRequirement(
  env: Env,
  input: { tenantId: string; inviteId: string }
): Promise<ExternalSignupInvitationRequirement | null> {
  return requirementShared(
    env,
    await invitationDatabase(env, input.tenantId, 'requirement'),
    input
  );
}

/** Applies the reserved use to the account the callback created (logged, never thrown). */
export async function applyExternalSignupInvitation(
  env: Env,
  log: BridgeLogger,
  input: ExternalSignupInvitation & {
    tenantId: string;
    userId: string;
    accountCoreAdapter: DatabaseAdapter;
  }
): Promise<boolean> {
  const { accountCoreAdapter, ...invitation } = input;
  return applyShared(
    () => invitationDatabase(env, input.tenantId, 'apply'),
    accountCoreAdapter,
    log,
    invitation
  );
}

/** Gives the reserved use back (an existing account signed in, or the sign-in failed). */
export async function releaseExternalSignupInvitation(
  env: Env,
  log: BridgeLogger,
  input: ExternalSignupInvitation & { tenantId: string }
): Promise<void> {
  await releaseShared(() => invitationDatabase(env, input.tenantId, 'release'), log, input);
}
