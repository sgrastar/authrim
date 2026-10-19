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
