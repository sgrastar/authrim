/**
 * What a machine credential ends up with on its principal. The token endpoint, the Admin API
 * authentication and the routes that decide who may hand out a credential all apply these two
 * rules, so they live in one place.
 */

import { hasAdminPermission } from '../../types/admin-user';

export interface AdminMachineTenantScopeEntry {
  scopeMode: 'none' | 'all' | 'allow';
  tenantId: string | null;
}

/**
 * The permissions a machine credential ends up with: the principal's, narrowed by the
 * credential's own when it has any. This is the rule the token endpoint and the middleware both
 * apply, so a route that decides whether an actor may hand out a credential asks the same thing.
 */
export function intersectMachinePermissionSets(
  principalPermissions: string[],
  credentialPermissions: string[]
): string[] {
  const result = new Set<string>();
  for (const principalPermission of principalPermissions) {
    for (const credentialPermission of credentialPermissions) {
      if (hasAdminPermission([principalPermission], credentialPermission)) {
        result.add(credentialPermission);
      } else if (hasAdminPermission([credentialPermission], principalPermission)) {
        result.add(principalPermission);
      }
    }
  }
  return Array.from(result);
}

/**
 * The tenants a machine credential ends up reaching (`'*'` for all of them): the principal's
 * scopes narrowed by the credential's, or the principal's own when the credential has none.
 */
export function resolveMachineTenantScope(
  principalScopes: AdminMachineTenantScopeEntry[],
  credentialScopes: AdminMachineTenantScopeEntry[]
): string[] {
  const effectiveCredentialScopes =
    credentialScopes.length > 0 ? credentialScopes : principalScopes;
  const principalAll = principalScopes.some((scope) => scope.scopeMode === 'all');
  const credentialAll = effectiveCredentialScopes.some((scope) => scope.scopeMode === 'all');

  if (principalAll && credentialAll) {
    return ['*'];
  }

  const principalTenants = principalAll
    ? null
    : new Set(
        principalScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );
  const credentialTenants = credentialAll
    ? null
    : new Set(
        effectiveCredentialScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );

  if (principalTenants === null) {
    return Array.from(credentialTenants ?? []);
  }
  if (credentialTenants === null) {
    return Array.from(principalTenants);
  }

  return Array.from(principalTenants).filter((tenantId) => credentialTenants.has(tenantId));
}

/**
 * The tenants a machine credential names one by one, as an `allow` entry of both the principal and
 * the credential (or of the principal alone when the credential has no scope of its own). An `all`
 * entry next to them does not hide them: `resolveMachineTenantScope` says `'*'`, and this says
 * which tenants were also named. Platform settings that exclude tenants from an all-tenants scope
 * accept a credential for such a tenant only when it is in this list.
 */
export function resolveMachineExplicitTenantScope(
  principalScopes: AdminMachineTenantScopeEntry[],
  credentialScopes: AdminMachineTenantScopeEntry[]
): string[] {
  const allowed = (scopes: AdminMachineTenantScopeEntry[]): Set<string> =>
    new Set(
      scopes
        .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
        .map((scope) => scope.tenantId as string)
    );
  const principalTenants = allowed(principalScopes);
  const credentialTenants = allowed(
    credentialScopes.length > 0 ? credentialScopes : principalScopes
  );
  return Array.from(principalTenants).filter((tenantId) => credentialTenants.has(tenantId));
}

/** The principal types that act for the platform (see `isPlatformMachinePrincipal`). */
export const PLATFORM_MACHINE_PRINCIPAL_TYPES: ReadonlySet<string> = new Set([
  'setup_tool',
  'admin_ui_bff',
  'internal_service',
]);

/** The principals the setup bootstrap writes, by their fixed IDs. */
export const PLATFORM_MACHINE_PRINCIPAL_IDS: ReadonlySet<string> = new Set([
  'amp_authrim_setup',
  'amp_authrim_admin_ui_bff',
]);

const SETUP_TOOL_CLIENT_ID = 'authrim-setup';

/**
 * Whether the principal acts for the platform (the setup tool, the Admin console relay, an
 * internal service). Only a platform administrator can create one (the machine access routes
 * refuse it to anyone else) and its type is never changed afterwards, so what a principal is, is
 * not something a stolen key of another principal can change.
 */
export function isPlatformMachinePrincipal(principal: {
  id?: string | null;
  clientId?: string | null;
  principalType?: string | null;
}): boolean {
  return (
    (principal.id != null && PLATFORM_MACHINE_PRINCIPAL_IDS.has(principal.id)) ||
    (principal.principalType != null &&
      PLATFORM_MACHINE_PRINCIPAL_TYPES.has(principal.principalType)) ||
    principal.clientId === SETUP_TOOL_CLIENT_ID
  );
}
