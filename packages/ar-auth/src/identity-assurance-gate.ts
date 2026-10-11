/**
 * Identity assurance (IAL) at the authorization endpoint.
 *
 * A person who has not been proofed to the level a request requires cannot satisfy it by
 * authenticating again or stepping up, so the request is refused outright: `access_denied`, the
 * same for prompt=none. When what the request requires is known not to need evidence (nothing is
 * configured), the evidence is not read. A read that fails is refused as temporarily unavailable,
 * never taken for IAL1.
 */

import type { Context } from 'hono';
import {
  createAccountAuthContextFromHono,
  evaluateUserIAL,
  resolveAccountDataContextFromHono,
  resolveRequiredIAL,
  type ClientMetadata,
  type Env,
} from '@authrim/ar-lib-core';

/** Why a request was refused on identity assurance, in the OAuth error vocabulary. */
export interface IdentityAssuranceRefusal {
  error: 'access_denied' | 'temporarily_unavailable';
  description: string;
}

interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

export async function checkAuthorizeIdentityAssurance(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    userId: string;
    /** The scopes of the request as it stands (query, pushed request or request object). */
    scope: string | undefined;
    clientMetadata: Pick<ClientMetadata, 'minimum_ial'> | null | undefined;
    /** The `assurance` settings the request already read. */
    assuranceSettings: Record<string, unknown>;
    clientId: string;
    log: Logger;
  }
): Promise<IdentityAssuranceRefusal | null> {
  const required = resolveRequiredIAL({
    assuranceSettings: input.assuranceSettings,
    scope: input.scope,
    clientMinimumIAL: input.clientMetadata?.minimum_ial,
  });
  const result = await evaluateUserIAL({
    required,
    tenantId: input.tenantId,
    userId: input.userId,
    // The user's canonical store: where their identity, and so their evidence, lives.
    getAdapter: async () => {
      await resolveAccountDataContextFromHono(c, input.userId);
      return createAccountAuthContextFromHono(c, input.tenantId).coreAdapter;
    },
  });
  switch (result.outcome) {
    case 'not_required':
    case 'met':
      return null;
    case 'insufficient':
      input.log.info('Authorization refused: identity assurance level not met', {
        action: 'identity_assurance_refused',
        clientId: input.clientId,
        required: result.required,
        actual: result.actual,
      });
      return {
        error: 'access_denied',
        description: 'The identity assurance level this request requires has not been met',
      };
    case 'unavailable':
      input.log.error(
        'Failed to read identity assurance evidence',
        { action: 'identity_assurance_read', clientId: input.clientId },
        result.error instanceof Error ? result.error : new Error(String(result.error))
      );
      return {
        error: 'temporarily_unavailable',
        description: 'Identity assurance is temporarily unavailable',
      };
  }
}
