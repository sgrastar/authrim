/**
 * What an ID token carries for an app, whichever endpoint issues it: the token endpoint (code,
 * refresh, device, CIBA) and the authorization endpoint (implicit and hybrid flows, where the ID
 * token is returned from the front channel). One rule for both, so the sub an app sees for a user
 * is the same on every path:
 *
 *  1. the app's identity mapping (sub, claim mapping, Destination Profile consent filter,
 *     protocol and grant claims left alone, reserved sub refused),
 *  2. the app's attribute release consent for the claims that result,
 *  3. the grant claims: the consent generation, and the sealed account reference when the sub is
 *     not the user's id.
 *
 * The access token keeps the user's id as its sub on every path; only the ID token is mapped.
 */

import type { DatabaseAdapter } from '../db/adapter';
import type { ClientMetadata } from '../types/oidc';
import type { Env } from '../types/env';
import type { Logger } from '../utils/logger';
import { applyOIDCIdentityMapping, OIDCIdentityMappingRuntimeError } from './oidc-identity-mapping';
import {
  enforceOIDCAttributeReleaseConsent,
  OIDCAttributeReleaseConsentRequiredError,
} from './oidc-attribute-release-consent';
import { accessTokenConsentClaims } from './oauth-client-consent-revocation';
import {
  isSubjectReferenceAvailable,
  SUBJECT_REFERENCE_CLAIM,
  sealSubjectReference,
} from './subject-reference';

/** The user × client grant an ID token is issued under. */
export interface IDTokenGrant {
  /** The user's id (the ID token's sub may be a pairwise or persistent identifier for it). */
  userId: string;
  /** The consent generation the grant was checked against. */
  consentGeneration: number;
}

/** Why an ID token's claims could not be released, as an OAuth error the endpoint answers with. */
export interface IDTokenReleaseFailure {
  kind: 'invalid_mapping' | 'mapping_failed' | 'consent_required' | 'consent_check_failed';
  error: 'invalid_client' | 'consent_required' | 'server_error';
  description: string;
  status: 400 | 500;
}

export type IDTokenReleaseResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; failure: IDTokenReleaseFailure };

export interface IDTokenReleaseContext {
  env: Env;
  /** The adapter the identity mapping reads the user's data through. */
  adapter: DatabaseAdapter;
  tenantId: string;
  clientId: string;
  clientMetadata: ClientMetadata;
  /**
   * The user's attributes an identity mapping reads, loaded for the user the ID token is for.
   * Called only when the mapping reads attributes the ID token's claims lack, with their names
   * (custom attributes among them): the loader reads just the standard attributes named
   * (standardUserAttributeNames), and nothing, so no profile or contact value is looked up, when
   * none is. Every path supplies it, so the same user is mapped the same way whatever scope or
   * response type the ID token was issued for.
   */
  loadUserAttributes: (
    userId: string,
    names: readonly string[]
  ) => Promise<Record<string, unknown> | null>;
  /** The endpoint's own module logger. */
  log: Pick<Logger, 'warn' | 'error'>;
}

/**
 * Apply the app's identity mapping to an ID token's claims (its sub is the user's id). The mapping
 * reads the user's attributes, not only the claims this ID token happens to carry.
 */
export async function mapIDTokenClaims(
  ctx: IDTokenReleaseContext,
  claims: Record<string, unknown>,
  grantedScopes?: string[]
): Promise<IDTokenReleaseResult> {
  const { clientId } = ctx;
  const userId = typeof claims.sub === 'string' ? claims.sub : '';
  try {
    const mapped = await applyOIDCIdentityMapping({
      adapter: ctx.adapter,
      env: ctx.env,
      tenantId: ctx.tenantId,
      clientId,
      sectorIdentifier: ctx.clientMetadata.sector_identifier_uri,
      selector: ctx.clientMetadata.identity_mapping,
      destinationSurface: 'id_token',
      grantedScopes,
      claims,
      ...(userId ? { sourceAttributes: (names) => ctx.loadUserAttributes(userId, names) } : {}),
    });
    return { ok: true, claims: mapped.claims };
  } catch (error) {
    ctx.log.error(
      'Failed to apply OIDC identity mapping for ID token',
      { clientId },
      error as Error
    );
    if (error instanceof OIDCIdentityMappingRuntimeError) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_mapping',
          error: 'invalid_client',
          description: 'Client identity mapping configuration is invalid',
          status: 400,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: 'mapping_failed',
        error: 'server_error',
        description: 'Failed to apply identity mapping',
        status: 500,
      },
    };
  }
}

function describeClaimReleaseConsentRequired(
  error: OIDCAttributeReleaseConsentRequiredError
): string {
  if (error.reasonCodes.includes('release.attribute_consent.attribute_set_changed')) {
    return 'User consent is required because the ID token claim set has changed';
  }
  if (error.reasonCodes.includes('release.attribute_consent.every_time')) {
    return 'User consent is required for this ID token claim release';
  }
  return 'User consent is required before releasing ID token claims';
}

/**
 * Hold an ID token's claims to the app's attribute release consent. The consent is the user's, so
 * it is looked up by `userId`, not by the sub the ID token carries (which a mapping may have made
 * another identifier).
 */
export async function enforceIDTokenAttributeRelease(
  ctx: IDTokenReleaseContext,
  userId: string,
  claims: Record<string, unknown>
): Promise<IDTokenReleaseResult> {
  if (!userId) return { ok: true, claims };
  try {
    await enforceOIDCAttributeReleaseConsent({
      env: ctx.env,
      tenantId: ctx.tenantId,
      subjectId: userId,
      clientMetadata: ctx.clientMetadata,
      claims,
      target: 'id_token',
    });
    return { ok: true, claims };
  } catch (error) {
    ctx.log.warn('OIDC ID token claim release consent required', {
      clientId: ctx.clientId,
      reasonCodes:
        error instanceof OIDCAttributeReleaseConsentRequiredError ? error.reasonCodes : [],
    });
    if (error instanceof OIDCAttributeReleaseConsentRequiredError) {
      return {
        ok: false,
        failure: {
          kind: 'consent_required',
          error: 'consent_required',
          description: describeClaimReleaseConsentRequired(error),
          status: 400,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: 'consent_check_failed',
        error: 'server_error',
        description: 'Failed to evaluate claim release consent',
        status: 500,
      },
    };
  }
}

/**
 * The grant claims an ID token carries, so a Token Exchange of it is held to its consent like the
 * access tokens of the grant: the consent generation, and, when its sub is not the user's id, the
 * sealed reference to the user's account. Without the key to seal one, the reference is left out
 * and an exchange of the ID token is refused.
 */
export async function idTokenGrantClaims(
  env: Env,
  tenantId: string,
  clientId: string,
  claims: Record<string, unknown>,
  grant: IDTokenGrant
): Promise<Record<string, unknown>> {
  const consentClaims = accessTokenConsentClaims({
    generation: grant.consentGeneration,
    consentClientId: clientId,
    tokenClientId: clientId,
  });
  if (claims.sub === grant.userId || !isSubjectReferenceAvailable(env)) return consentClaims;
  return {
    ...consentClaims,
    [SUBJECT_REFERENCE_CLAIM]: await sealSubjectReference(
      env,
      { tenantId, clientId },
      grant.userId
    ),
  };
}

/**
 * Everything an ID token issued from the front channel carries beyond its protocol claims: the
 * identity mapping, the attribute release consent and the grant claims, in the token endpoint's
 * order. `claims` is the ID token as built from the grant (its sub is the user's id).
 */
export async function releaseIDTokenClaims(
  ctx: IDTokenReleaseContext,
  input: { claims: Record<string, unknown>; grantedScopes?: string[]; grant: IDTokenGrant }
): Promise<IDTokenReleaseResult> {
  const mapped = await mapIDTokenClaims(ctx, input.claims, input.grantedScopes);
  if (!mapped.ok) return mapped;
  const released = await enforceIDTokenAttributeRelease(ctx, input.grant.userId, mapped.claims);
  if (!released.ok) return released;
  return {
    ok: true,
    claims: {
      ...released.claims,
      ...(await idTokenGrantClaims(
        ctx.env,
        ctx.tenantId,
        ctx.clientId,
        released.claims,
        input.grant
      )),
    },
  };
}
