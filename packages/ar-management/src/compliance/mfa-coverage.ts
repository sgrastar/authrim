/**
 * Multi-factor authentication for a tenant: whether sign-in requires it, and who has it.
 *
 * - Enforcement: the assurance settings that make authorization require AAL2 or above (the
 *   default AAL, or a scope's requirement). AAL2 means a passkey, or a password with TOTP.
 * - Admins: those who can administer the tenant (an unexpired global role, or a tenant role for
 *   it, as admin sign-in grants them) and are active. Admin sign-in is passkey only, so an admin
 *   has MFA when they have a passkey (`mfa_enabled` is not set for every admin and not used).
 * - Users: active registered users of the tenant, over every store its accounts live in, with a
 *   passkey or an active TOTP. Guests, and accounts being deleted, are counted apart.
 */
import {
  DEFAULT_ADMIN_SIGN_IN_ROLES,
  ensureDatabaseAdapter,
  meetsAAL,
  parseScopeAALRequirements,
  isAssuranceLevel,
  resolveEffectiveSettings,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type AssuranceLevel,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export interface MfaEnforcement {
  /** Sign-in requires AAL2 or above for some or every authorization. */
  enforced: boolean;
  assurance_enabled: boolean;
  default_aal: AssuranceLevel | null;
  /** Scopes that require AAL2 or above. */
  scopes_requiring_mfa: string[];
}

export interface AdminMfaCoverage {
  admins: number;
  with_passkey: number;
}

export interface UserMfaCoverage {
  users: number;
  with_passkey: number;
  with_totp: number;
  /** A passkey or an active TOTP. */
  with_any: number;
  guests: number;
  /** Accounts whose deletion has started and not finished. */
  deleting: number;
}

/** What makes sign-in require MFA for the tenant (assurance off: nothing does). */
export async function readMfaEnforcement(env: Env, tenantId: string): Promise<MfaEnforcement> {
  const assurance = await resolveEffectiveSettings(env, 'assurance', { tenantId, fresh: true });
  const enabled = assurance['assurance.enabled'] === true;
  const rawDefault = assurance['assurance.default_aal'];
  const defaultAal = isAssuranceLevel(rawDefault) ? rawDefault : null;
  const scopes = Object.entries(
    parseScopeAALRequirements(assurance['assurance.scope_aal_requirements'])
  )
    .filter(([, level]) => meetsAAL(level, 'AAL2'))
    .map(([scope]) => scope)
    .sort();
  return {
    enforced:
      enabled && ((defaultAal !== null && meetsAAL(defaultAal, 'AAL2')) || scopes.length > 0),
    assurance_enabled: enabled,
    default_aal: defaultAal,
    scopes_requiring_mfa: enabled ? scopes : [],
  };
}

/** Admins who can administer the tenant, and those with a passkey. */
export async function countAdminMfa(
  adminAdapter: DatabaseAdapter,
  tenantId: string,
  now = Date.now()
): Promise<AdminMfaCoverage> {
  // The grant rule of admin session authentication (ar-lib-core admin-auth): assignments made in
  // the admin's own tenant, with a role of that tenant or a built-in one that admin sign-in
  // accepts, global or for the tenant (a NULL scope means the assignment's tenant), not expired.
  const roleNames = DEFAULT_ADMIN_SIGN_IN_ROLES;
  const row = await adminAdapter.queryOne<{ admins: number | null; with_passkey: number | null }>(
    `SELECT COUNT(*) AS admins,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM admin_passkeys p WHERE p.admin_user_id = u.id
            ) THEN 1 ELSE 0 END) AS with_passkey
       FROM admin_users u
      WHERE u.is_active = 1
        AND u.status = 'active'
        AND EXISTS (
          SELECT 1
            FROM admin_role_assignments ra
            JOIN admin_roles r ON ra.admin_role_id = r.id
           WHERE ra.admin_user_id = u.id
             AND ra.tenant_id = u.tenant_id
             AND (r.tenant_id = u.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
             AND r.name IN (${roleNames.map(() => '?').join(', ')})
             AND (
               ra.scope_type = 'global'
               OR (
                 ra.scope_type = 'tenant'
                 AND (ra.scope_id = ? OR (ra.scope_id IS NULL AND ra.tenant_id = ?))
               )
             )
             AND (ra.expires_at IS NULL OR ra.expires_at > ?)
        )`,
    [...roleNames, tenantId, tenantId, now]
  );
  return { admins: Number(row?.admins ?? 0), with_passkey: Number(row?.with_passkey ?? 0) };
}

const USER_MFA_SQL = `
  SELECT
    SUM(CASE WHEN active = 1 AND registered = 1 THEN 1 ELSE 0 END) AS users,
    SUM(CASE WHEN active = 1 AND registered = 1 AND has_passkey = 1 THEN 1 ELSE 0 END) AS with_passkey,
    SUM(CASE WHEN active = 1 AND registered = 1 AND has_totp = 1 THEN 1 ELSE 0 END) AS with_totp,
    SUM(CASE WHEN active = 1 AND registered = 1 AND (has_passkey = 1 OR has_totp = 1) THEN 1 ELSE 0 END) AS with_any,
    SUM(CASE WHEN active = 1 AND registered = 0 THEN 1 ELSE 0 END) AS guests,
    SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS deleting
  FROM (
    SELECT
      CASE WHEN a.lifecycle_state = 'active' THEN 1 ELSE 0 END AS active,
      CASE WHEN a.registration_state = 'guest' THEN 0 ELSE 1 END AS registered,
      CASE WHEN EXISTS (
        SELECT 1 FROM passkeys p WHERE p.tenant_id = a.tenant_id AND p.user_id = a.legacy_user_id
      ) THEN 1 ELSE 0 END AS has_passkey,
      CASE WHEN EXISTS (
        SELECT 1 FROM totp_credentials t
         WHERE t.tenant_id = a.tenant_id AND t.user_id = a.legacy_user_id AND t.status = 'active'
      ) THEN 1 ELSE 0 END AS has_totp
    FROM identity_accounts a
    WHERE a.tenant_id = ? AND a.account_type = 'user' AND a.lifecycle_state IN ('active', 'deleting')
  ) accounts`;

/** Active users of the tenant over every store its accounts live in, and their factors. */
export async function countUserMfa(
  env: Env,
  tenantId: string,
  options: { routed: boolean }
): Promise<UserMfaCoverage> {
  // A routed tenant's accounts live in its user stores (up to 32, besides its default store);
  // otherwise in its default store.
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    ...(options.routed ? { dataRole: 'tenant_core/users' as const } : {}),
    maxStores: 32,
    concurrency: 4,
  });
  const rows = await Promise.all(
    stores.map((store) =>
      ensureDatabaseAdapter(store.source, `compliance-mfa:${store.bindingRef}`).queryOne<
        Record<keyof UserMfaCoverage, number | null>
      >(USER_MFA_SQL, [tenantId])
    )
  );
  const total: UserMfaCoverage = {
    users: 0,
    with_passkey: 0,
    with_totp: 0,
    with_any: 0,
    guests: 0,
    deleting: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(total) as Array<keyof UserMfaCoverage>) {
      total[key] += Number(row?.[key] ?? 0);
    }
  }
  return total;
}
