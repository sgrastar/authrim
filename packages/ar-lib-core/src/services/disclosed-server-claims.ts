/**
 * The server-computed authorization claims (roles, groups, ...) an app's Destination Profile
 * discloses on a surface.
 *
 * The claims are computed before a claims request's SAO rules run, so a rule can test them. A rule
 * outcome must not tell an app what its profile does not release, so only the claims the profile
 * lists for the surface are handed to the rules (an abort or an omit on a hidden claim sees no
 * value, the same as for a person who has none).
 */
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import {
  AUTHORIZATION_SERVER_COMPUTED_CLAIMS,
  isOidcFieldApplicableToScopes,
  loadDestinationProfileConsentDescriptor,
} from './destination-profile-consent';
import { PLATFORM_MAPPING_TENANT_ID } from './identity-mapping-owner';
import { resolveOidcIdentityMappingBinding } from './identity-mapping-resolution';
import { getTenantSettingsDocument } from '../utils/tenant-settings';
import { getIDTokenRBACClaims } from '../utils/rbac-claims';

export interface ServerClaimsDisclosureInput {
  env: Env;
  tenantId: string;
  clientId: string;
  selector?: OIDCIdentityMappingFieldMappingSelector | null;
  surface: 'id_token' | 'userinfo';
  /** Surfaces whose fields are released on `surface` as well (response_type=id_token). */
  alsoSurfaces?: ReadonlyArray<'id_token' | 'userinfo'>;
  /**
   * The scopes granted to the request: a field whose required scopes are not among them is not
   * disclosed, as in the real release. Left out: no scope check (as the release without scopes).
   */
  grantedScopes?: readonly string[];
  /** The computed claims; only names the profile lists for the surface are kept. */
  claims: Record<string, unknown>;
}

/**
 * A deep copy of the claims of `input.claims` that the app's Destination Profile lists for the
 * surface. An app with no mapping, no profile or a profile that cannot be read is disclosed none.
 * (The copy is the caller's to hand to an evaluator that edits values in place.)
 */
export async function resolveDisclosedServerClaims(
  input: ServerClaimsDisclosureInput
): Promise<Record<string, unknown>> {
  const names = Object.keys(input.claims).filter((name) =>
    AUTHORIZATION_SERVER_COMPUTED_CLAIMS.has(name)
  );
  if (names.length === 0) return {};
  try {
    const { binding } = await resolveOidcIdentityMappingBinding({
      env: input.env,
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSelector: input.selector,
    });
    if (!binding?.destinationProfileId || binding.destinationProfileIds.length !== 1) return {};
    const descriptor = await loadDestinationProfileConsentDescriptor(
      requireDedicatedAdminDatabaseAdapter(input.env, 'oidc-destination-profile-disclosure'),
      binding.tenantId === PLATFORM_MAPPING_TENANT_ID ? PLATFORM_MAPPING_TENANT_ID : input.tenantId,
      binding.destinationProfileId
    );
    if (descriptor?.destinationType !== 'oidc') return {};
    const surfaces: string[] = [input.surface, ...(input.alsoSurfaces ?? [])];
    const granted = input.grantedScopes ? new Set(input.grantedScopes) : null;
    const listed = new Set(
      descriptor.fields
        .filter(
          (field) => field.surfaces.length === 0 || surfaces.some((s) => field.surfaces.includes(s))
        )
        .filter((field) => isOidcFieldApplicableToScopes(field, granted))
        .map((field) => field.key)
    );
    return Object.fromEntries(
      names
        .filter((name) => listed.has(name))
        .map((name) => [name, structuredClone(input.claims[name])])
    );
  } catch {
    // The release itself reports an unusable mapping; here nothing is disclosed.
    return {};
  }
}

/**
 * The subject's server-computed claims under the tenant's ID token claim settings (the settings
 * UserInfo and the ID token share), as the token endpoint computes them. For the `id_token`
 * surface that is everything the ID token builder produces; UserInfo carries only authrim_roles
 * and authrim_groups.
 */
export async function loadSubjectServerClaims(
  env: Env,
  databases: { metadata: DatabaseAdapter; account: DatabaseAdapter },
  tenantId: string,
  subjectId: string,
  surface: 'id_token' | 'userinfo' = 'userinfo'
): Promise<Record<string, unknown>> {
  const settings = await getTenantSettingsDocument(env, tenantId, 'tokens');
  const configured = settings?.['tokens.rbac_id_token_claims'];
  const claims = await getIDTokenRBACClaims(databases, subjectId, {
    cache: env.REBAC_CACHE,
    env,
    claimsConfig: typeof configured === 'string' ? configured : env.RBAC_ID_TOKEN_CLAIMS,
    tenantId,
  });
  if (surface === 'id_token') return { ...claims };
  const result: Record<string, unknown> = {};
  if (claims.authrim_roles) result.authrim_roles = claims.authrim_roles;
  if (claims.authrim_groups) result.authrim_groups = claims.authrim_groups;
  return result;
}
