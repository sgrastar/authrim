/**
 * Identity Stitching Service
 * Handles automatic linking of external identities to existing users
 * with JIT Provisioning, policy evaluation, and organization auto-join
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  createLogger,
  D1Adapter,
  type DatabaseAdapter,
  type JITProvisioningConfig,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
  type DenyErrorCode,
  DEFAULT_JIT_CONFIG,
  createRuleEvaluator,
  resolveOrgByDomainHash,
  resolveAllOrgsByDomainHash,
  joinOrganization,
  assignRoleToUser,
  generateEmailDomainHashWithVersion,
  getEmailDomainHashConfig,
  type ResolvedOrganization,
} from '@authrim/ar-lib-core';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type HandleIdentityParams,
  type HandleIdentityResult,
  type StitchingConfig,
  type UpstreamProvider,
  type UserInfo,
  type TokenResponse,
} from '../types';
import {
  findLinkedIdentity,
  createLinkedIdentity,
  updateLinkedIdentity,
} from './linked-identity-store';

/**
 * Get identity stitching configuration
 * Priority: Cache → KV → Environment Variables → Default
 */
export async function getStitchingConfig(env: Env): Promise<StitchingConfig> {
  // Try KV first
  if (env.SETTINGS) {
    try {
      const kvConfig = await env.SETTINGS.get('identity_stitching');
      if (kvConfig) {
        return JSON.parse(kvConfig);
      }
    } catch {
      // Ignore KV errors, fall through to env vars
    }
  }

  // Fall back to env vars
  return {
    enabled: env.IDENTITY_STITCHING_ENABLED === 'true',
    requireVerifiedEmail: env.IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL !== 'false',
  };
}

/**
 * Get JIT Provisioning configuration
 * Priority: KV → Default
 */
export async function getJITConfig(env: Env): Promise<JITProvisioningConfig> {
  if (env.SETTINGS) {
    try {
      const kvConfig = await env.SETTINGS.get('jit_provisioning_config');
      if (kvConfig) {
        return JSON.parse(kvConfig);
      }
    } catch {
      // Ignore KV errors, fall through to default
    }
  }

  return DEFAULT_JIT_CONFIG;
}

/**
 * Handle identity after successful provider authentication
 *
 * Flow:
 * 1. If linkingUserId provided → link to that user
 * 2. If existing linked identity → return that user
 * 3. If stitching enabled + email matches verified user → auto-link
 * 4. If JIT provisioning enabled → create new user
 * 5. Error: no account found
 */
export async function handleIdentity(
  env: Env,
  params: HandleIdentityParams
): Promise<HandleIdentityResult> {
  const { provider, userInfo, tokens, linkingUserId, tenantId = 'default' } = params;

  // 1. Explicit linking to existing account
  if (linkingUserId) {
    // SECURITY: Check if provider requires verified email even for explicit linking
    if (provider.requireEmailVerified && userInfo.email && !userInfo.email_verified) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.EMAIL_NOT_VERIFIED,
        'The email from your external account is not verified. Please verify your email with the provider first.',
        { providerName: provider.name }
      );
    }

    const linkedIdentityId = await createLinkedIdentity(env, {
      userId: linkingUserId,
      providerId: provider.id,
      providerUserId: userInfo.sub,
      providerEmail: userInfo.email,
      emailVerified: userInfo.email_verified,
      tokens,
      rawClaims: userInfo,
      tenantId,
    });

    // Log audit event
    await logAuditEvent(env, {
      userId: linkingUserId,
      action: 'identity_linked',
      resourceType: 'linked_identity',
      resourceId: linkedIdentityId,
      metadata: { providerId: provider.id, providerEmail: userInfo.email },
    });

    return {
      userId: linkingUserId,
      isNewUser: false,
      linkedIdentityId,
      stitchedFromExisting: false,
    };
  }

  // 2. Check for existing linked identity
  const existingLink = await findLinkedIdentity(env, provider.id, userInfo.sub);
  if (existingLink) {
    // Update tokens and last login
    await updateLinkedIdentity(env, existingLink.id, {
      tokens,
      lastLoginAt: Date.now(),
      rawClaims: userInfo,
    });

    return {
      userId: existingLink.userId,
      isNewUser: false,
      linkedIdentityId: existingLink.id,
      stitchedFromExisting: false,
    };
  }

  // 3. Try identity stitching by email
  const stitchingConfig = await getStitchingConfig(env);

  // Check if user with this email already exists
  const existingUser = userInfo.email ? await findUserByEmail(env, userInfo.email, tenantId) : null;

  if (existingUser) {
    // User with this email exists - check if we can auto-link
    if (
      stitchingConfig.enabled &&
      provider.autoLinkEmail &&
      userInfo.email &&
      userInfo.email_verified
    ) {
      // Check if local email is verified
      if (!existingUser.email_verified) {
        // Local account email not verified - cannot safely auto-link
        throw new ExternalIdPError(
          ExternalIdPErrorCode.LOCAL_EMAIL_NOT_VERIFIED,
          'Your existing account email is not verified. Please verify your email first.',
          { email: userInfo.email }
        );
      }

      // Auto-link to existing user
      const linkedIdentityId = await createLinkedIdentity(env, {
        userId: existingUser.id,
        providerId: provider.id,
        providerUserId: userInfo.sub,
        providerEmail: userInfo.email,
        emailVerified: userInfo.email_verified,
        tokens,
        rawClaims: userInfo,
        tenantId,
      });

      // Log audit event for automatic stitching
      await logAuditEvent(env, {
        userId: existingUser.id,
        action: 'identity_stitched',
        resourceType: 'linked_identity',
        resourceId: linkedIdentityId,
        metadata: {
          providerId: provider.id,
          providerEmail: userInfo.email,
          stitchReason: 'email_match',
        },
      });

      return {
        userId: existingUser.id,
        isNewUser: false,
        linkedIdentityId,
        stitchedFromExisting: true,
      };
    }

    // Stitching disabled or conditions not met - user must link manually
    throw new ExternalIdPError(
      ExternalIdPErrorCode.ACCOUNT_EXISTS_LINK_REQUIRED,
      'An account with this email already exists. Please log in with your existing credentials first, then link your account.',
      { email: userInfo.email, providerName: provider.name }
    );
  }

  // 4. No existing user - try JIT Provisioning
  if (provider.jitProvisioning) {
    // Check if provider email is verified (if we require it)
    // SECURITY: Check both global setting AND per-provider setting
    const requireVerified = stitchingConfig.requireVerifiedEmail || provider.requireEmailVerified;

    if (requireVerified && userInfo.email && !userInfo.email_verified) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.EMAIL_NOT_VERIFIED,
        'The email from your external account is not verified. Please verify your email with the provider first.',
        { providerName: provider.name }
      );
    }

    // Get JIT provisioning configuration
    const jitConfig = await getJITConfig(env);

    // Check if JIT is enabled
    if (!jitConfig.enabled) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED,
        'JIT Provisioning is currently disabled. Please contact your administrator.',
        { providerName: provider.name }
      );
    }

    // Check if provider is allowed
    if (
      jitConfig.allowed_provider_ids &&
      jitConfig.allowed_provider_ids.length > 0 &&
      !jitConfig.allowed_provider_ids.includes(provider.id)
    ) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED,
        'This provider is not allowed for automatic account creation.',
        { providerName: provider.name, providerId: provider.id }
      );
    }

    // Check verified email requirement from JIT config
    if (jitConfig.require_verified_email && userInfo.email && !userInfo.email_verified) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.EMAIL_NOT_VERIFIED,
        'A verified email is required for automatic account creation.',
        { providerName: provider.name }
      );
    }

    // Create user with extended JIT provisioning
    const jitResult = await createUserWithJITProvisioning(env, {
      email: userInfo.email,
      emailVerified: userInfo.email_verified || false,
      name: userInfo.name,
      givenName: userInfo.given_name,
      familyName: userInfo.family_name,
      picture: userInfo.picture,
      locale: userInfo.locale,
      identityProviderId: provider.id,
      tenantId,
      rawClaims: userInfo,
      jitConfig,
    });

    // Check if access was denied by policy
    if (jitResult.denied) {
      const errorCode = mapDenyCodeToErrorCode(jitResult.deny_code);
      throw new ExternalIdPError(
        errorCode,
        jitResult.deny_description || 'Access denied by policy.',
        {
          providerName: provider.name,
          deny_code: jitResult.deny_code,
        }
      );
    }

    const linkedIdentityId = await createLinkedIdentity(env, {
      userId: jitResult.userId,
      providerId: provider.id,
      providerUserId: userInfo.sub,
      providerEmail: userInfo.email,
      emailVerified: userInfo.email_verified,
      tokens,
      rawClaims: userInfo,
      tenantId,
    });

    // Log audit event for JIT provisioning
    await logAuditEvent(env, {
      userId: jitResult.userId,
      action: 'user_jit_provisioned',
      resourceType: 'user',
      resourceId: jitResult.userId,
      metadata: {
        providerId: provider.id,
        providerEmail: userInfo.email,
        roles_assigned: jitResult.roles_assigned,
        orgs_joined: jitResult.orgs_joined,
        matched_rules: jitResult.matched_rules,
      },
    });

    return {
      userId: jitResult.userId,
      isNewUser: true,
      linkedIdentityId,
      stitchedFromExisting: false,
      roles_assigned: jitResult.roles_assigned,
      orgs_joined: jitResult.orgs_joined,
      attributes_set: jitResult.attributes_set,
    };
  }

  // 5. JIT disabled and no existing account
  throw new ExternalIdPError(
    ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED,
    'New account registration via external providers is not available. Please register first or contact your administrator.',
    { providerName: provider.name }
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

interface ExistingUser {
  id: string;
  email: string;
  email_verified: boolean;
}

/**
 * Find user by email
 * PII/Non-PII DB separation: email lookup uses PII DB, status verification uses Core DB
 */
async function findUserByEmail(
  env: Env,
  email: string,
  tenantId: string
): Promise<ExistingUser | null> {
  // Search by email in PII DB
  if (!env.DB_PII) return null;

  const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
  const userPII = await piiAdapter.queryOne<{ id: string; email: string }>(
    'SELECT id, email FROM users_pii WHERE tenant_id = ? AND email = ?',
    [tenantId, email.toLowerCase()]
  );

  if (!userPII) return null;

  // Verify user is active and get email_verified from Core DB
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const userCore = await coreAdapter.queryOne<{ id: string; email_verified: number }>(
    'SELECT id, email_verified FROM users_core WHERE id = ? AND is_active = 1',
    [userPII.id]
  );

  if (!userCore) return null;

  return {
    id: userCore.id,
    email: userPII.email,
    email_verified: userCore.email_verified === 1,
  };
}

interface CreateUserParams {
  email?: string;
  emailVerified: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  identityProviderId: string;
  tenantId: string;
}

/**
 * Create user from external identity
 * PII/Non-PII DB separation: creates records in both Core DB and PII DB
 */
async function createUserFromExternalIdentity(
  env: Env,
  params: CreateUserParams
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Generate a placeholder email if not provided
  const email = params.email || `${id}@external.authrim.local`;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

  // Step 1: Insert into users_core with pii_status='pending'
  await coreAdapter.execute(
    `INSERT INTO users_core (
      id, tenant_id, email_verified, user_type, pii_partition, pii_status, created_at, updated_at
    ) VALUES (?, ?, ?, 'end_user', 'default', 'pending', ?, ?)`,
    [id, params.tenantId, params.emailVerified ? 1 : 0, now, now]
  );

  // Step 2: Insert into users_pii (if DB_PII is configured)
  if (env.DB_PII) {
    const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
    await piiAdapter.execute(
      `INSERT INTO users_pii (
        id, tenant_id, email, name, given_name, family_name, picture, locale, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.tenantId,
        email.toLowerCase(),
        params.name || null,
        params.givenName || null,
        params.familyName || null,
        params.picture || null,
        params.locale || null,
        now,
        now,
      ]
    );

    // Step 3: Update pii_status to 'active'
    await coreAdapter.execute('UPDATE users_core SET pii_status = ? WHERE id = ?', ['active', id]);
  }

  return { id };
}

interface AuditEventParams {
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log audit event
 */
async function logAuditEvent(env: Env, params: AuditEventParams): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const now = Date.now();

    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    await coreAdapter.execute(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.userId,
        params.action,
        params.resourceType,
        params.resourceId,
        JSON.stringify(params.metadata || {}),
        now,
      ]
    );
  } catch (error) {
    // Don't fail the main operation if audit logging fails
    // PII Protection: Don't log full error (may contain DB details)
    const log = createLogger().module('IDENTITY-STITCHING');
    log.error(
      'Failed to log audit event',
      { action: 'audit_log', errorName: error instanceof Error ? error.name : 'Unknown error' },
      error as Error
    );
  }
}

/**
 * Check if user has passkey credentials
 */
export async function hasPasskeyCredential(env: Env, userId: string): Promise<boolean> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?`,
    [userId]
  );

  return (result?.count || 0) > 0;
}

// =============================================================================
// JIT Provisioning with Policy Evaluation
// =============================================================================

interface JITProvisioningParams extends CreateUserParams {
  rawClaims: Record<string, unknown>;
  jitConfig: JITProvisioningConfig;
}

interface JITProvisioningResult {
  userId: string;
  denied: boolean;
  deny_code?: DenyErrorCode;
  deny_description?: string;
  matched_rules: string[];
  roles_assigned: Array<{
    role_id: string;
    scope_type: string;
    scope_target: string;
  }>;
  orgs_joined: string[];
  attributes_set: Array<{
    name: string;
    value: string;
  }>;
}

/**
 * Create user with JIT Provisioning
 *
 * This function:
 * 1. Generates email_domain_hash for the user
 * 2. Creates the user in Core/PII databases
 * 3. Evaluates policy rules
 * 4. Resolves and joins organizations based on domain mapping
 * 5. Assigns roles based on rule evaluation
 *
 * @param env - Environment bindings
 * @param params - User creation parameters with JIT config
 * @returns JIT provisioning result
 */
async function createUserWithJITProvisioning(
  env: Env,
  params: JITProvisioningParams
): Promise<JITProvisioningResult> {
  const result: JITProvisioningResult = {
    userId: '',
    denied: false,
    matched_rules: [],
    roles_assigned: [],
    orgs_joined: [],
    attributes_set: [],
  };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const email = params.email || `${id}@external.authrim.local`;

  // Step 1: Generate email_domain_hash
  let emailDomainHash: string | undefined;
  let emailDomainHashVersion: number | undefined;

  if (params.email && params.email.includes('@')) {
    try {
      const hashConfig = await getEmailDomainHashConfig(env);
      const hashResult = await generateEmailDomainHashWithVersion(params.email, hashConfig);
      emailDomainHash = hashResult.hash;
      emailDomainHashVersion = hashResult.version;
    } catch (error) {
      // If hash generation fails (no secret configured), continue without hash
      // PII Protection: Don't log full error (may contain email or config details)
      const log = createLogger().module('IDENTITY-STITCHING');
      log.warn('Failed to generate email_domain_hash', {
        action: 'generate_hash',
        errorName: error instanceof Error ? error.name : 'Unknown error',
      });
    }
  }

  // Step 2: Create user in Core DB
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

  await coreAdapter.execute(
    `INSERT INTO users_core (
      id, tenant_id, email_verified, email_domain_hash, email_domain_hash_version,
      user_type, pii_partition, pii_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'end_user', 'default', 'pending', ?, ?)`,
    [
      id,
      params.tenantId,
      params.emailVerified ? 1 : 0,
      emailDomainHash || null,
      emailDomainHashVersion || null,
      now,
      now,
    ]
  );

  // Step 3: Create user in PII DB
  if (env.DB_PII) {
    const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
    await piiAdapter.execute(
      `INSERT INTO users_pii (
        id, tenant_id, email, name, given_name, family_name, picture, locale, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.tenantId,
        email.toLowerCase(),
        params.name || null,
        params.givenName || null,
        params.familyName || null,
        params.picture || null,
        params.locale || null,
        now,
        now,
      ]
    );

    // Update pii_status to 'active'
    await coreAdapter.execute('UPDATE users_core SET pii_status = ? WHERE id = ?', ['active', id]);
  }

  result.userId = id;

  // Step 4: Evaluate policy rules
  const ruleEvaluator = createRuleEvaluator(env.DB, env.SETTINGS);

  const evaluationContext: RuleEvaluationContext = {
    email_domain_hash: emailDomainHash,
    email_domain_hash_version: emailDomainHashVersion,
    email_verified: params.emailVerified,
    idp_claims: params.rawClaims,
    provider_id: params.identityProviderId,
    user_type: 'end_user',
    tenant_id: params.tenantId,
  };

  const ruleResult = await ruleEvaluator.evaluate(evaluationContext);

  // Check if access was denied
  if (ruleResult.denied) {
    result.denied = true;
    result.deny_code = ruleResult.deny_code;
    result.deny_description = ruleResult.deny_description;
    result.matched_rules = ruleResult.matched_rules;

    // Clean up: delete the user we just created
    try {
      if (env.DB_PII) {
        const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
        await piiAdapter.execute('DELETE FROM users_pii WHERE id = ?', [id]);
      }
      await coreAdapter.execute('DELETE FROM users_core WHERE id = ?', [id]);
    } catch (cleanupError) {
      // PII Protection: Don't log full error (may contain DB details)
      const log = createLogger().module('IDENTITY-STITCHING');
      log.error(
        'Failed to cleanup user after policy denial',
        {
          action: 'cleanup_user',
          errorName: cleanupError instanceof Error ? cleanupError.name : 'Unknown error',
        },
        cleanupError as Error
      );
    }

    return result;
  }

  result.matched_rules = ruleResult.matched_rules;
  result.attributes_set = ruleResult.attributes_to_set;

  // Step 5: Resolve and join organizations
  const orgsToJoin: string[] = [];

  // Organizations from rule evaluation
  for (const orgId of ruleResult.orgs_to_join) {
    if (orgId === 'auto') {
      // 'auto' means use domain hash mapping
      continue;
    }
    orgsToJoin.push(orgId);
  }

  // Organizations from domain hash mapping
  if (emailDomainHash) {
    if (params.jitConfig.join_all_matching_orgs) {
      // Join all matching orgs
      const matchedOrgs = await resolveAllOrgsByDomainHash(
        env.DB,
        emailDomainHash,
        params.tenantId,
        params.jitConfig
      );
      for (const org of matchedOrgs) {
        if (!orgsToJoin.includes(org.org_id)) {
          orgsToJoin.push(org.org_id);
        }
      }
    } else {
      // Join first matching org only
      const matchedOrg = await resolveOrgByDomainHash(
        env.DB,
        emailDomainHash,
        params.tenantId,
        params.jitConfig
      );
      if (matchedOrg && !orgsToJoin.includes(matchedOrg.org_id)) {
        orgsToJoin.push(matchedOrg.org_id);
      }
    }
  }

  // Check if user needs org but no org found
  if (orgsToJoin.length === 0 && !params.jitConfig.allow_user_without_org) {
    result.denied = true;
    result.deny_code = 'access_denied';
    result.deny_description =
      'No organization found for this user and standalone users are not allowed.';

    // Clean up
    try {
      if (env.DB_PII) {
        const piiAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB_PII });
        await piiAdapter.execute('DELETE FROM users_pii WHERE id = ?', [id]);
      }
      await coreAdapter.execute('DELETE FROM users_core WHERE id = ?', [id]);
    } catch (cleanupError) {
      // PII Protection: Don't log full error (may contain DB details)
      const log = createLogger().module('IDENTITY-STITCHING');
      log.error(
        'Failed to cleanup user after no-org denial',
        {
          action: 'cleanup_user',
          errorName: cleanupError instanceof Error ? cleanupError.name : 'Unknown error',
        },
        cleanupError as Error
      );
    }

    return result;
  }

  // Actually join the organizations
  for (const orgId of orgsToJoin) {
    const joinResult = await joinOrganization(
      env.DB,
      id,
      orgId,
      params.tenantId,
      'member' // Default membership type
    );
    if (joinResult.success) {
      result.orgs_joined.push(orgId);
    }
  }

  // Step 6: Assign roles from rule evaluation
  for (const roleAssignment of ruleResult.roles_to_assign) {
    let scopeTarget = roleAssignment.scope_target;

    // Resolve 'auto' scope target to first joined org
    if (scopeTarget === 'auto' && result.orgs_joined.length > 0) {
      scopeTarget = `org:${result.orgs_joined[0]}`;
    }

    // Skip if scope is 'auto' but no org was joined
    if (scopeTarget === 'auto') {
      continue;
    }

    const assignResult = await assignRoleToUserInternal(
      env.DB,
      id,
      roleAssignment.role_id,
      roleAssignment.scope_type,
      scopeTarget,
      params.tenantId
    );

    if (assignResult.success) {
      result.roles_assigned.push({
        role_id: roleAssignment.role_id,
        scope_type: roleAssignment.scope_type,
        scope_target: scopeTarget,
      });
    }
  }

  // Step 7: Assign default role if no roles were assigned
  if (result.roles_assigned.length === 0 && params.jitConfig.default_role_id) {
    const defaultScopeTarget =
      result.orgs_joined.length > 0 ? `org:${result.orgs_joined[0]}` : 'global';
    const defaultScopeType = result.orgs_joined.length > 0 ? 'org' : 'global';

    const assignResult = await assignRoleToUserInternal(
      env.DB,
      id,
      params.jitConfig.default_role_id,
      defaultScopeType,
      defaultScopeTarget,
      params.tenantId
    );

    if (assignResult.success) {
      result.roles_assigned.push({
        role_id: params.jitConfig.default_role_id,
        scope_type: defaultScopeType,
        scope_target: defaultScopeTarget,
      });
    }
  }

  return result;
}

/**
 * Assign role to user (internal helper)
 */
async function assignRoleToUserInternal(
  db: D1Database,
  userId: string,
  roleId: string,
  scopeType: string,
  scopeTarget: string,
  tenantId: string
): Promise<{ success: boolean; assignment_id?: string; error?: string }> {
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db });

    // Check if role exists
    const roleCheck = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM roles WHERE id = ? AND tenant_id = ?`,
      [roleId, tenantId]
    );

    if (!roleCheck) {
      // SECURITY: Do not expose role ID to prevent enumeration
      return { success: false, error: 'Role not found' };
    }

    // Check if already assigned
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE user_id = ? AND role_id = ? AND scope_type = ? AND scope_target = ? AND tenant_id = ?`,
      [userId, roleId, scopeType, scopeTarget, tenantId]
    );

    if (existing) {
      return { success: true, assignment_id: existing.id, error: 'Already assigned' };
    }

    // Create assignment
    await coreAdapter.execute(
      `INSERT INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, scope_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [assignmentId, tenantId, userId, roleId, scopeType, scopeTarget, now, now]
    );

    return { success: true, assignment_id: assignmentId };
  } catch (error) {
    const log = createLogger().module('IDENTITY-STITCHING');
    log.error(
      'Database error in assignRoleToUserInternal',
      { action: 'assign_role' },
      error as Error
    );
    return {
      success: false,
      // SECURITY: Do not expose internal error details
      error: 'Failed to assign role',
    };
  }
}

/**
 * Map deny_code to ExternalIdPErrorCode
 */
function mapDenyCodeToErrorCode(denyCode?: DenyErrorCode): ExternalIdPErrorCode {
  switch (denyCode) {
    case 'interaction_required':
      return ExternalIdPErrorCode.POLICY_INTERACTION_REQUIRED;
    case 'login_required':
      return ExternalIdPErrorCode.POLICY_LOGIN_REQUIRED;
    case 'access_denied':
    default:
      return ExternalIdPErrorCode.POLICY_ACCESS_DENIED;
  }
}
