import type { Context } from 'hono';
import type { Env, OAuthClientConsentRevocationState } from '@authrim/ar-lib-core';
import {
  createAccountAuthContextFromHono,
  findOAuthClientConsentRevocation,
  predatesOAuthClientConsentRevocation,
  resolveAccountDataContextFromHono,
} from '@authrim/ar-lib-core';

/** Shown when a request outlived a withdrawal of the client's consent: it must start again. */
export const CONSENT_WITHDRAWN_DESCRIPTION =
  'Consent for this application was withdrawn after this request was made. Start again on the device or application.';

/**
 * The approving user's consent withdrawals for the client, from the user's account database. A
 * user without account data never withdrew a consent.
 */
export async function readApprovalConsentWithdrawal(
  c: Context<{ Bindings: Env }>,
  input: { tenantId: string; userId: string; clientId: string }
): Promise<OAuthClientConsentRevocationState> {
  try {
    await resolveAccountDataContextFromHono(c, input.userId);
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') {
      return { generation: 0, revokedAt: null };
    }
    throw error;
  }
  return findOAuthClientConsentRevocation(
    createAccountAuthContextFromHono(c, input.tenantId).coreAdapter,
    input
  );
}

/**
 * Whether a device or CIBA request made at `requestedAt` (ms) predates the last withdrawal, so
 * approving it would grant under the withdrawn consent: the user has to start again.
 */
export function requestPredatesConsentWithdrawal(
  requestedAt: number,
  state: OAuthClientConsentRevocationState
): boolean {
  return predatesOAuthClientConsentRevocation(requestedAt, state.revokedAt);
}
