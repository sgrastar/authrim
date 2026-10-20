/**
 * The part of saving `identity_mapping.oidc_default_set_id` that needs the Admin database: the
 * Mapping Set the value names must exist, belong to someone allowed to be named at that scope, and
 * be usable (see validateOidcMappingSetReference). The form of the value is judged earlier, without
 * the database (patch-validation.ts).
 */
import {
  IDENTITY_MAPPING_NONE,
  PLATFORM_MAPPING_TENANT_ID,
  requireDedicatedAdminDatabaseAdapter,
  validateOidcMappingSetReference,
  type DatabaseAdapter,
  type Env,
  type SettingsPatchRequest,
} from '@authrim/ar-lib-core';

const OIDC_DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';

export type IdentityMappingReferenceProblem =
  | { status: 400; reason: string; message: string }
  | { status: 503; reason: string; message: string };

/**
 * The problem with the Mapping Set a PATCH names as the default, or null (nothing to check:
 * the PATCH does not set the key, or sets the tenant's `none`, which names no set).
 *
 * `adapter` is for tests; the routes leave it out and the Admin database is taken from `env`.
 */
export async function identityMappingReferenceProblem(
  env: Env,
  body: SettingsPatchRequest,
  scope: { type: 'platform' } | { type: 'tenant'; tenantId: string },
  adapter?: DatabaseAdapter
): Promise<IdentityMappingReferenceProblem | null> {
  const value = body.set?.[OIDC_DEFAULT_SET_KEY];
  // A value of another form has been refused by now; a non-string would be refused here too.
  if (typeof value !== 'string' || value === IDENTITY_MAPPING_NONE) return null;

  let adminAdapter: DatabaseAdapter;
  try {
    adminAdapter = adapter ?? requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical');
  } catch {
    return {
      status: 503,
      reason: 'identity_mapping_admin_database_unavailable',
      message: 'The Mapping Set cannot be checked right now; try again',
    };
  }
  const result = await validateOidcMappingSetReference({
    adminAdapter,
    contextTenantId: scope.type === 'platform' ? PLATFORM_MAPPING_TENANT_ID : scope.tenantId,
    scope: scope.type,
    setId: value,
  });
  if (result.ok) return null;
  if (result.code === 'admin_database_unavailable') {
    return {
      status: 503,
      reason: 'identity_mapping_admin_database_unavailable',
      message: 'The Mapping Set cannot be checked right now; try again',
    };
  }
  return {
    status: 400,
    reason: `identity_mapping_${result.code}`,
    message: `${OIDC_DEFAULT_SET_KEY}: ${result.message}`,
  };
}
