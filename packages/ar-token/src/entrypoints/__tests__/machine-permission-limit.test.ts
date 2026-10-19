import { describe, expect, it, vi } from 'vitest';
import { hasAdminPermission, type DatabaseAdapter } from '@authrim/ar-lib-core';

const adapterHolder = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, requireDedicatedAdminDatabaseAdapter: () => adapterHolder.current };
});

import { defaultModeBPermissionLimit } from '../AgentDownscopeEntrypoint';

/**
 * A machine principal the Admin moves between two states it may legitimately store:
 *   R: permissions `admin:clients:read`, scope `allow tenant-b`
 *   L: permissions `*`, scope `allow tenant-a`
 * The credential inherits the permissions and is allowed in tenant-a and tenant-b. The change from R
 * to L lands right after the scope is read, so code that reads the scope and the permissions
 * separately sees R's scope with L's permissions: `admin:clients:write` for tenant-b, which no
 * stored state grants. A single-statement snapshot sees one state.
 */
function movingPrincipalAdapter() {
  const R = {
    permissions: ['admin:clients:read'],
    scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-b' }],
  };
  const L = { permissions: ['*'], scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-a' }] };
  let state = R;
  const principal = {
    id: 'amp_agent',
    client_id: 'agent-client',
    display_name: 'Agent',
    description: null,
    principal_type: 'ai_agent',
    status: 'active',
    default_audience: 'authrim:admin-api',
    token_ttl_seconds: 600,
    created_by_actor_type: null,
    created_by_actor_id: null,
    created_at: 1,
    updated_at: 1,
    disabled_at: null,
    disabled_by_actor_type: null,
    disabled_by_actor_id: null,
  };
  const credential = {
    id: 'amk_agent',
    principal_id: 'amp_agent',
    kid: 'kid',
    public_jwk_json: '{}',
    alg: 'ES256',
    display_name: 'Key',
    description: null,
    status: 'active',
    not_before: null,
    expires_at: null,
    last_used_at: null,
    last_used_ip: null,
    last_used_user_agent: null,
    created_by_actor_type: null,
    created_by_actor_id: null,
    created_at: 1,
    updated_at: 1,
    revoked_at: null,
    revoked_by_actor_type: null,
    revoked_by_actor_id: null,
    revoke_reason: null,
  };
  const credentialScopes = [
    { scope_mode: 'allow', tenant_id: 'tenant-a' },
    { scope_mode: 'allow', tenant_id: 'tenant-b' },
  ];
  return {
    async queryOne(sql: string) {
      if (sql.includes('principal_permissions_json')) {
        const joined = sql.includes('credential_permissions_json');
        const snapshot = {
          ...principal,
          principal_permissions_json: JSON.stringify(state.permissions),
          principal_scopes_json: JSON.stringify(state.scopes),
          ...(joined
            ? {
                ...Object.fromEntries(
                  Object.entries(credential).map(([key, value]) => [`credential_${key}`, value])
                ),
                credential_permissions_json: '[]',
                credential_scopes_json: JSON.stringify(credentialScopes),
              }
            : {}),
        };
        // The change lands right after the one read.
        state = L;
        return snapshot;
      }
      if (sql.includes('FROM admin_machine_credentials')) return credential;
      if (sql.includes('FROM admin_machine_principals')) return principal;
      return null;
    },
    async query(sql: string) {
      if (sql.includes('admin_machine_principal_tenant_scopes')) {
        const scopes = state.scopes;
        state = L;
        return scopes;
      }
      if (sql.includes('admin_machine_principal_permissions')) {
        return state.permissions.map((permission) => ({ permission }));
      }
      if (sql.includes('admin_machine_credential_tenant_scopes')) return credentialScopes;
      if (sql.includes('admin_machine_credential_permissions')) return [];
      return [];
    },
  };
}

describe('the Mode B permission limit of the agent token exchange', () => {
  it.each([[undefined], ['amk_agent']])(
    "is one stored state of the principal, not R's scope with L's permissions (credential %s)",
    async (credentialId) => {
      adapterHolder.current = movingPrincipalAdapter() as unknown as DatabaseAdapter;

      const limit = await defaultModeBPermissionLimit(
        {} as never,
        'tenant-b',
        'amp_agent',
        credentialId
      );

      expect(limit === null || !hasAdminPermission(limit, 'admin:clients:write')).toBe(true);
      expect(limit).toEqual(['admin:clients:read']);
    }
  );
});
