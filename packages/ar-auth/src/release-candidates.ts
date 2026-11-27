/**
 * The information an authorization could release about the person to the app: the claims its ID
 * token and UserInfo would carry for the request's scopes and claims parameter, after the app's
 * identity mapping, before the person's choice among the optional ones. What the consent screen
 * shows, and what an earlier decision is checked against (information-release-consent.ts).
 *
 * It is computed the way UserInfo and the ID token release claims (the same claim evaluation,
 * assurance claims and identity mapping), so what is asked is what can be released.
 */
import type { Context } from 'hono';
import {
  applyOIDCIdentityMapping,
  buildStandardUserClaims,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  canonicalProjectionToOIDCClaimsUser,
  createAccountAuthContextFromHono,
  createAuthContextFromHono,
  createPIIContextFromHono,
  evaluateClaimsForTarget,
  claimsRequestRestrictsSub,
  deriveOIDCSubject,
  mergeReleaseCandidates,
  releaseCandidatesOf,
  resolveAssuranceClaims,
  resolveEffectiveSettings,
  loadSubjectServerClaims,
  resolveDisclosedServerClaims,
  type ParsedClaimsRequest,
  type ClientMetadata,
  type Env,
  type ReleaseCandidate,
} from '@authrim/ar-lib-core';

export interface ReleaseCandidatesInput {
  c: Context<{ Bindings: Env }>;
  tenantId: string;
  userId: string;
  clientId: string;
  clientMetadata: ClientMetadata;
  scopes: string[];
  claimsRequest: ParsedClaimsRequest | undefined;
  claimsRequestProtected: boolean;
  /** response_type=id_token: the ID token also carries the scope claims (OIDC Core 5.4). */
  idTokenOnly: boolean;
}

export interface ReleaseCandidates {
  candidates: ReleaseCandidate[];
  /** The value of each candidate, for a screen that shows them. */
  values: Record<string, unknown>;
}

/** Thrown when the app's identity mapping cannot be applied: nothing can be released or asked. */
export class ReleaseCandidatesUnavailableError extends Error {
  constructor(cause: unknown) {
    super('release_candidates_unavailable', { cause });
    this.name = 'ReleaseCandidatesUnavailableError';
  }
}

export async function computeReleaseCandidates(
  input: ReleaseCandidatesInput
): Promise<ReleaseCandidates> {
  const { c, tenantId, userId, clientId, clientMetadata } = input;
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const projection = await new CanonicalRuntimeUserProjectionRepository(
    piiCtx.coreAdapter,
    tenantId,
    new CanonicalSensitiveValueResolver(piiCtx.defaultPiiAdapter)
  ).findByLegacyUserId(userId);
  const user = projection ? canonicalProjectionToOIDCClaimsUser(projection) : null;
  const userData: Record<string, unknown> = {
    ...(user ? buildStandardUserClaims(user) : {}),
    sub: userId,
  };

  // The server-computed claims (roles, groups), which a claims request's SAO rules may test. They
  // are never consent items (releaseCandidatesOf leaves them out); a failure computes none.
  let computed: Record<string, unknown> = {};
  try {
    computed = await loadSubjectServerClaims(
      c.env,
      {
        metadata: createAuthContextFromHono(c, tenantId).coreAdapter,
        account: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
      },
      tenantId,
      userId,
      'id_token'
    );
  } catch {
    computed = {};
  }

  const lists: ReleaseCandidate[][] = [];
  const values: Record<string, unknown> = {};
  for (const target of ['userinfo', 'id_token'] as const) {
    const includeScopeClaims = target === 'userinfo' || input.idTokenOnly;
    const assurance = await resolveAssuranceClaims({
      target,
      tenantId,
      userId,
      scopes: input.scopes,
      claimsRequest: input.claimsRequest,
      clientPolicy: clientMetadata,
      includeScopeClaims,
      requestScope: c,
      loadSettings: () => resolveEffectiveSettings(c.env, 'assurance', { tenantId }),
      getAdapter: () => piiCtx.coreAdapter,
      onError: () => undefined,
    });
    // A `sub` the claims request names (or an ASC rule on /sub) is the sub the app receives
    // (a pairwise app's), as at issuance, never the account's id.
    let subjectValue: string | undefined;
    if (claimsRequestRestrictsSub(input.claimsRequest, target)) {
      try {
        subjectValue = await deriveOIDCSubject({
          adapter: createAuthContextFromHono(c, tenantId).coreAdapter,
          env: c.env,
          tenantId,
          clientId,
          subjectType: clientMetadata.subject_type ?? 'public',
          sectorIdentifier: clientMetadata.sector_identifier_uri,
          redirectUris: clientMetadata.redirect_uris,
          selector: clientMetadata.identity_mapping,
          destinationSurface: target,
          grantedScopes: input.scopes,
          claims: { sub: userId },
          sourceAttributes: userData,
        });
      } catch (error) {
        throw new ReleaseCandidatesUnavailableError(error);
      }
    }
    // Only what the app's profile lists on this surface is handed to the SAO rules.
    const disclosed = await resolveDisclosedServerClaims({
      env: c.env,
      tenantId,
      clientId,
      selector: clientMetadata.identity_mapping,
      surface: target,
      grantedScopes: input.scopes,
      ...(target === 'id_token' && input.idTokenOnly
        ? { alsoSurfaces: ['userinfo' as const] }
        : {}),
      // UserInfo carries only roles and groups; the ID token the full computed set.
      claims:
        target === 'id_token'
          ? computed
          : Object.fromEntries(
              Object.entries(computed).filter(
                ([name]) => name === 'authrim_roles' || name === 'authrim_groups'
              )
            ),
    });
    const evaluated = evaluateClaimsForTarget({
      target,
      ...(subjectValue !== undefined ? { subjectValue } : {}),
      claimsRequest: input.claimsRequest,
      initialClaims: { sub: userId, ...disclosed },
      availableClaims: {
        ...userData,
        ...(assurance.eduperson_assurance
          ? { eduperson_assurance: assurance.eduperson_assurance }
          : {}),
      },
      grantedScopes: input.scopes,
      clientPolicy: clientMetadata,
      includeScopeClaims,
      requestIntegrityProtected: input.claimsRequestProtected,
    });
    if (!evaluated.ok) continue;
    const optional = new Set<string>();
    let mapped: Record<string, unknown>;
    try {
      mapped = (
        await applyOIDCIdentityMapping({
          adapter: createAuthContextFromHono(c, tenantId).coreAdapter,
          env: c.env,
          tenantId,
          clientId,
          subjectType: clientMetadata.subject_type ?? 'public',
          sectorIdentifier: clientMetadata.sector_identifier_uri,
          redirectUris: clientMetadata.redirect_uris,
          selector: clientMetadata.identity_mapping,
          destinationSurface: target,
          grantedScopes: input.scopes,
          claims: evaluated.claims,
          sourceAttributes: userData,
          releaseOptionalOut: optional,
          // The server's claims are not computed for the screen's own profile check.
          serverComputedPending: true,
          ...(target === 'id_token'
            ? { claimsAuthorizedByRequest: true, userInfoClaimsInIdToken: input.idTokenOnly }
            : assurance.eduperson_assurance
              ? { authorizedClaimNames: ['eduperson_assurance', ...Object.keys(disclosed)] }
              : Object.keys(disclosed).length > 0
                ? { authorizedClaimNames: Object.keys(disclosed) }
                : {}),
        })
      ).claims;
    } catch (error) {
      throw new ReleaseCandidatesUnavailableError(error);
    }
    const candidates = releaseCandidatesOf(mapped, optional);
    for (const candidate of candidates) values[candidate.name] ??= mapped[candidate.name];
    lists.push(candidates);
  }
  return { candidates: mergeReleaseCandidates(...lists), values };
}
