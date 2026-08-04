/**
 * Identity Stitching Service
 * Handles automatic linking of external identities to existing users
 * with JIT Provisioning, policy evaluation, and organization auto-join
 */

import type { Env } from '@authrim/ar-lib-core';
import {
  createAuditLog,
  createLogger,
  type DatabaseAdapter,
  type DatabaseSource,
  ensureDatabaseAdapter,
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
  validateCustomClaimWrite,
  persistCustomClaimWrite,
  syncUserLifecycleState,
  type ValidatedCustomClaimWriteResult,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveTenantUserStoreSourcesFromEnv,
  CanonicalRuntimeUserStore,
  resolveAccountDataContext,
  resolveAccountDataContextByIdentifier,
  resolveTenantMetadataContext,
  type AuthAccountProvisioningInput,
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
  activatePendingLinkedIdentity,
  findPendingLinkedIdentityProvisioning,
} from './linked-identity-store';
import { decrypt, encrypt, getEncryptionKey } from '../utils/crypto';

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
    enabled: env.ENABLE_IDENTITY_STITCHING === 'true',
    requireVerifiedEmail: env.ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL !== 'false',
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
  const { provider, userInfo, tokens, linkingUserId, tenantId } = params;
  const tenantD1 = true;
  const defaultUserStoreSources = await resolveTenantUserStoreSourcesFromEnv(env, tenantId);

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

    const accountContext = tenantD1
      ? await resolveAccountDataContext(env, {
          tenantId,
          accountId: `account:${linkingUserId}`,
        })
      : undefined;
    if (accountContext && accountContext.legacyUserId !== linkingUserId) {
      throw new Error('external_idp_link_account_mismatch');
    }
    const existingIdentity = accountContext
      ? await findLinkedIdentity(env, tenantId, provider.id, userInfo.sub, accountContext.piiDb)
      : null;
    if (existingIdentity && existingIdentity.userId !== linkingUserId) {
      throw new Error('external_idp_link_authority_conflict');
    }
    const identityInput = {
      userId: linkingUserId,
      providerId: provider.id,
      providerUserId: userInfo.sub,
      providerEmail: userInfo.email,
      emailVerified: userInfo.email_verified,
      tokens,
      rawClaims: userInfo,
      tenantId,
    };
    const linkedIdentityId =
      existingIdentity?.id ??
      (accountContext
        ? await createLinkedIdentity(env, identityInput, accountContext.piiDb)
        : await createLinkedIdentity(env, identityInput, defaultUserStoreSources.piiDb));
    if (accountContext) {
      await publishTenantD1ExternalIdpRoute(env, {
        accountContext,
        linkedIdentityId,
        providerId: provider.id,
        providerUserId: userInfo.sub,
      });
    }

    // Log audit event
    await logAuditEvent(env, {
      tenantId,
      userId: linkingUserId,
      action: 'identity_linked',
      resourceType: 'linked_identity',
      resourceId: linkedIdentityId,
      metadata: { providerId: provider.id },
    });

    return {
      status: 'ready',
      userId: linkingUserId,
      isNewUser: false,
      linkedIdentityId,
      stitchedFromExisting: false,
    };
  }

  // 2. Check for existing linked identity
  let externalRoute: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>> | undefined;
  if (tenantD1) {
    try {
      externalRoute = await resolveAccountDataContextByIdentifier(env, {
        tenantId,
        indexKind: 'external_subject',
        identifier: { issuer: provider.id, subject: userInfo.sub },
      });
    } catch (routeError) {
      if (!(routeError instanceof Error && routeError.message === 'account_data_route_not_found')) {
        throw routeError;
      }
    }
  }
  const existingLink = externalRoute
    ? await findLinkedIdentity(env, tenantId, provider.id, userInfo.sub, externalRoute.piiDb)
    : await findLinkedIdentity(
        env,
        tenantId,
        provider.id,
        userInfo.sub,
        defaultUserStoreSources.piiDb
      );
  if (existingLink) {
    // Update tokens and last login
    const updates = { tokens, lastLoginAt: Date.now(), rawClaims: userInfo };
    if (externalRoute) {
      await updateLinkedIdentity(
        env,
        existingLink.tenantId,
        existingLink.id,
        updates,
        externalRoute.piiDb
      );
    } else {
      await updateLinkedIdentity(
        env,
        existingLink.tenantId,
        existingLink.id,
        updates,
        defaultUserStoreSources.piiDb
      );
    }

    return {
      status: 'ready',
      userId: existingLink.userId,
      isNewUser: false,
      linkedIdentityId: existingLink.id,
      stitchedFromExisting: false,
    };
  }
  if (tenantD1 && externalRoute) {
    const completed = await completeTenantD1ExternalIdpJIT(env, {
      tenantId,
      userId: externalRoute.legacyUserId,
      providerId: provider.id,
      providerUserId: userInfo.sub,
    });
    if (!completed.linkedIdentityId) {
      throw new Error('external_idp_jit_identity_activation_failed');
    }
    await updateLinkedIdentity(
      env,
      tenantId,
      completed.linkedIdentityId,
      {
        tokens,
        lastLoginAt: Date.now(),
        rawClaims: userInfo,
      },
      externalRoute.piiDb
    );
    return {
      status: 'ready',
      userId: externalRoute.legacyUserId,
      isNewUser: false,
      linkedIdentityId: completed.linkedIdentityId,
      stitchedFromExisting: false,
      roles_assigned: completed.roles_assigned,
      orgs_joined: completed.orgs_joined,
    };
  }

  // 3. Try identity stitching by email
  const stitchingConfig = await getStitchingConfig(env);

  // Check if user with this email already exists
  let emailRoute: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>> | undefined;
  if (tenantD1 && userInfo.email) {
    try {
      emailRoute = await resolveAccountDataContextByIdentifier(env, {
        tenantId,
        indexKind: 'email_exact',
        identifier: userInfo.email,
      });
    } catch (routeError) {
      if (!(routeError instanceof Error && routeError.message === 'account_data_route_not_found')) {
        throw routeError;
      }
    }
  }
  const existingUser = userInfo.email
    ? await findUserByEmail(env, userInfo.email, tenantId, emailRoute)
    : null;

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

      const existingIdentity = emailRoute
        ? await findLinkedIdentity(env, tenantId, provider.id, userInfo.sub, emailRoute.piiDb)
        : null;
      if (existingIdentity && existingIdentity.userId !== existingUser.id) {
        throw new Error('external_idp_stitch_authority_conflict');
      }
      const identityInput = {
        userId: existingUser.id,
        providerId: provider.id,
        providerUserId: userInfo.sub,
        providerEmail: userInfo.email,
        emailVerified: userInfo.email_verified,
        tokens,
        rawClaims: userInfo,
        tenantId,
      };
      const linkedIdentityId =
        existingIdentity?.id ??
        (emailRoute
          ? await createLinkedIdentity(env, identityInput, emailRoute.piiDb)
          : await createLinkedIdentity(env, identityInput, defaultUserStoreSources.piiDb));
      if (emailRoute) {
        await publishTenantD1ExternalIdpRoute(env, {
          accountContext: emailRoute,
          linkedIdentityId,
          providerId: provider.id,
          providerUserId: userInfo.sub,
        });
      }

      // Log audit event for automatic stitching
      await logAuditEvent(env, {
        tenantId,
        userId: existingUser.id,
        action: 'identity_stitched',
        resourceType: 'linked_identity',
        resourceId: linkedIdentityId,
        metadata: {
          providerId: provider.id,
          stitchReason: 'email_match',
        },
      });

      return {
        status: 'ready',
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

    const jitParams: JITProvisioningParams = {
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
      customClaims: extractMappedCustomClaims(userInfo, provider.attributeMapping),
    };
    const jitResult = tenantD1
      ? await createTenantD1UserWithJITProvisioning(env, {
          ...jitParams,
          providerUserId: userInfo.sub,
          tokens,
        })
      : await createUserWithJITProvisioning(env, jitParams);

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

    if (jitResult.pending) {
      return {
        status: 'pending',
        userId: jitResult.userId,
        isNewUser: true,
        stitchedFromExisting: false,
        accountId: jitResult.pending.accountId,
        operationId: jitResult.pending.operationId,
        providerId: jitResult.pending.providerId,
        providerUserId: jitResult.pending.providerUserId,
      };
    }

    const linkedIdentityId =
      jitResult.linkedIdentityId ??
      (await createLinkedIdentity(
        env,
        {
          userId: jitResult.userId,
          providerId: provider.id,
          providerUserId: userInfo.sub,
          providerEmail: userInfo.email,
          emailVerified: userInfo.email_verified,
          tokens,
          rawClaims: userInfo,
          tenantId,
        },
        defaultUserStoreSources.piiDb
      ));

    // Log audit event for JIT provisioning
    await logAuditEvent(env, {
      tenantId,
      userId: jitResult.userId,
      action: 'user_jit_provisioned',
      resourceType: 'user',
      resourceId: jitResult.userId,
      metadata: {
        providerId: provider.id,
        roles_assigned: jitResult.roles_assigned,
        orgs_joined: jitResult.orgs_joined,
        matched_rules: jitResult.matched_rules,
      },
    });

    return {
      status: 'ready',
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

async function resolveUserStoreAdapters(
  env: Env,
  tenantId: string,
  accountContext?: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>>
): Promise<{
  coreSource: DatabaseSource;
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
}> {
  if (accountContext) {
    return {
      coreSource: accountContext.coreDb,
      coreAdapter: ensureDatabaseAdapter(accountContext.coreDb, 'identity-stitching-core'),
      piiAdapter: ensureDatabaseAdapter(accountContext.piiDb, 'identity-stitching-pii'),
    };
  }
  const sources = await resolveTenantUserStoreSourcesFromEnv(env, tenantId);
  return {
    coreSource: sources.coreDb,
    coreAdapter: ensureDatabaseAdapter(sources.coreDb, 'identity-stitching-core'),
    piiAdapter: sources.piiDb
      ? ensureDatabaseAdapter(sources.piiDb, 'identity-stitching-pii')
      : null,
  };
}

/**
 * Find user by email
 * PII/Non-PII DB separation: email lookup uses PII DB, status verification uses Core DB
 */
async function findUserByEmail(
  env: Env,
  email: string,
  tenantId: string,
  accountContext?: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>>
): Promise<ExistingUser | null> {
  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, tenantId, accountContext);
  if (!piiAdapter) return null;
  const runtimeUsers = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
  const user = await runtimeUsers.findByEmail(email.toLowerCase());
  if (!user) return null;

  return {
    id: user.id,
    email: user.email ?? email.toLowerCase(),
    email_verified: user.email_verified === 1,
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

const CUSTOM_CLAIM_TARGET_PREFIXES = ['custom_claims.', 'custom_fields.'] as const;

function getCustomClaimFieldKey(targetClaim: string): string | null {
  for (const prefix of CUSTOM_CLAIM_TARGET_PREFIXES) {
    if (targetClaim.startsWith(prefix) && targetClaim.length > prefix.length) {
      return targetClaim.slice(prefix.length);
    }
  }

  return null;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function normalizeCustomClaimValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeCustomClaimValue(entry);
      if (normalized !== undefined) {
        return normalized;
      }
    }
    return undefined;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  return undefined;
}

/**
 * Provider attributeMapping can target both standard OIDC claims and
 * custom Authrim claims. Reserve:
 * - custom_claims.<field_key>
 * - custom_fields.<field_key>
 */
function extractMappedCustomClaims(
  userInfo: UserInfo,
  attributeMapping: Record<string, string>
): Record<string, unknown> {
  const customClaims: Record<string, unknown> = {};

  for (const [targetClaim, sourcePath] of Object.entries(attributeMapping)) {
    const fieldKey = getCustomClaimFieldKey(targetClaim);
    if (!fieldKey) {
      continue;
    }

    const normalized = normalizeCustomClaimValue(getNestedValue(userInfo, sourcePath));
    if (normalized !== undefined) {
      customClaims[fieldKey] = normalized;
    }
  }

  return customClaims;
}

async function validateProvisionedCustomClaims(
  env: Env,
  tenantId: string,
  submitted: Record<string, unknown>,
  customClaimSources?: Awaited<ReturnType<typeof resolveCustomClaimRuntimeSourcesFromEnv>>
): Promise<ValidatedCustomClaimWriteResult> {
  const resolvedCustomClaimSources =
    customClaimSources ?? (await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId));
  if (!resolvedCustomClaimSources.nonPiiDb || !resolvedCustomClaimSources.piiDb) {
    throw new Error('identity_stitching_account_runtime_sources_required');
  }
  const validation = await validateCustomClaimWrite({
    db: resolvedCustomClaimSources.nonPiiDb,
    dbPii: resolvedCustomClaimSources.piiDb,
    schemaDb: resolvedCustomClaimSources.schemaDb,
    tenantId,
    submitted,
    requireCompleteRecord: true,
  });

  if (!validation.ok) {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.REQUIRED_CUSTOM_CLAIMS_MISSING,
      'Automatic account creation requires additional profile attributes that are not available from the external provider.',
      {
        validationError: validation.error,
        missingRequiredFields: validation.missingRequiredFields,
      }
    );
  }

  return validation;
}

/**
 * Create user from external identity
 * PII/Non-PII DB separation: creates records in both Core DB and PII DB
 */
async function createUserFromExternalIdentity(
  env: Env,
  params: CreateUserParams
): Promise<{ id: string }> {
  await validateProvisionedCustomClaims(env, params.tenantId, {});

  const id = crypto.randomUUID();

  // Generate a placeholder email if not provided
  const email = params.email || `${id}@external.authrim.local`;

  const { coreAdapter, piiAdapter } = await resolveUserStoreAdapters(env, params.tenantId);
  if (!piiAdapter) {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.ACCOUNT_CREATION_FAILED,
      'Canonical runtime user creation requires a PII database.'
    );
  }
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter,
    tenantId: params.tenantId,
  });
  await runtimeUsers.syncUser({
    userId: id,
    email: email.toLowerCase(),
    name: params.name || null,
    active: true,
    emailVerified: params.emailVerified,
    userType: 'end_user',
    sourceRef: `external-idp:${params.identityProviderId}`,
    piiFields: {
      given_name: params.givenName !== undefined,
      family_name: params.familyName !== undefined,
      picture: params.picture !== undefined,
      locale: params.locale !== undefined,
    },
    sensitiveValues: {
      given_name: params.givenName ?? null,
      family_name: params.familyName ?? null,
      picture: params.picture ?? null,
      locale: params.locale ?? null,
    },
  });

  return { id };
}

interface AuditEventParams {
  tenantId: string;
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
    await createAuditLog(env, {
      userId: params.userId,
      tenantId: params.tenantId,
      action: params.action,
      resource: params.resourceType,
      resourceId: params.resourceId,
      ipAddress: 'system',
      userAgent: 'identity-stitching',
      metadata: JSON.stringify(params.metadata || {}),
      severity: 'info',
    });
  } catch (error) {
    // Don't fail the main operation if audit logging fails
    // PII Protection: Don't log full error (may contain DB details)
    const log = createLogger().module('IDENTITY-STITCHING');
    log.error('Failed to log audit event', {
      action: 'audit_log',
      errorName: error instanceof Error ? error.name : 'Unknown error',
    });
  }
}

/**
 * Check if user has passkey credentials
 */
export async function hasPasskeyCredential(
  env: Env,
  tenantId: string,
  userId: string,
  accountContext?: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>>
): Promise<boolean> {
  const { coreAdapter } = await resolveUserStoreAdapters(env, tenantId, accountContext);
  const result = await coreAdapter.queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM passkeys WHERE tenant_id = ? AND user_id = ?',
    [tenantId, userId]
  );

  return (result?.count || 0) > 0;
}

// =============================================================================
// JIT Provisioning with Policy Evaluation
// =============================================================================

interface JITProvisioningParams extends CreateUserParams {
  rawClaims: Record<string, unknown>;
  jitConfig: JITProvisioningConfig;
  customClaims: Record<string, unknown>;
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
  linkedIdentityId?: string;
  pending?: {
    accountId: string;
    operationId: string;
    providerId: string;
    providerUserId: string;
  };
}

interface TenantD1JITProvisioningParams extends JITProvisioningParams {
  providerUserId: string;
  tokens: TokenResponse;
}

interface TenantD1JITPlan {
  schemaVersion: 1;
  customClaimValidation: ValidatedCustomClaimWriteResult;
  organizationIds: string[];
  roleAssignments: Array<{ roleId: string; scopeType: string; scopeTarget: string }>;
  defaultRoleId: string | null;
  matchedRules: string[];
  attributesSet: Array<{ name: string; value: string }>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('external_idp_jit_value_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('external_idp_jit_value_invalid');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function publishTenantD1ExternalIdpRoute(
  env: Env,
  input: {
    accountContext: Awaited<ReturnType<typeof resolveAccountDataContextByIdentifier>>;
    linkedIdentityId: string;
    providerId: string;
    providerUserId: string;
  }
): Promise<void> {
  const provisioner = env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
  if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
  const stableInput = canonicalJson({
    tenantId: input.accountContext.tenantId,
    accountId: input.accountContext.accountId,
    userId: input.accountContext.legacyUserId,
    linkedIdentityId: input.linkedIdentityId,
    providerId: input.providerId,
    providerUserId: input.providerUserId,
  });
  const digest = await sha256Hex(stableInput);
  const operationId = `external-idp-route-${digest.slice(0, 32)}`;
  const result = await provisioner.publishExternalIdpRoute({
    schemaVersion: 1,
    operationId,
    idempotencyKey: `auth-external-idp-route:${digest}`,
    tenantId: input.accountContext.tenantId,
    accountId: input.accountContext.accountId,
    userId: input.accountContext.legacyUserId,
    linkedIdentityId: input.linkedIdentityId,
    providerId: input.providerId,
    providerUserId: input.providerUserId,
  });
  if (
    result.operationId !== operationId ||
    result.accountId !== input.accountContext.accountId ||
    (result.status !== 201 && result.status !== 202)
  ) {
    throw new Error('external_idp_route_publication_response_invalid');
  }
}

async function applyTenantD1JITPlan(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    providerId: string;
    providerUserId: string;
    plan: TenantD1JITPlan;
  }
): Promise<Pick<JITProvisioningResult, 'linkedIdentityId' | 'roles_assigned' | 'orgs_joined'>> {
  const account = await resolveAccountDataContextByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'external_subject',
    identifier: { issuer: input.providerId, subject: input.providerUserId },
  });
  if (account.legacyUserId !== input.userId) {
    throw new Error('external_idp_jit_account_route_mismatch');
  }
  const pending = await findPendingLinkedIdentityProvisioning(
    env,
    input.tenantId,
    input.providerId,
    input.providerUserId,
    account.piiDb
  );
  if (!pending) {
    const active = await findLinkedIdentity(
      env,
      input.tenantId,
      input.providerId,
      input.providerUserId,
      account.piiDb
    );
    if (active?.userId === input.userId) {
      return { linkedIdentityId: active.id, roles_assigned: [], orgs_joined: [] };
    }
  }
  if (!pending || pending.userId !== input.userId) {
    throw new Error('external_idp_jit_pending_identity_not_found');
  }

  await persistCustomClaimWrite({
    db: account.coreDb,
    dbPii: account.piiDb,
    tenantId: input.tenantId,
    userId: input.userId,
    validation: input.plan.customClaimValidation,
  });

  const orgsJoined: string[] = [];
  for (const orgId of input.plan.organizationIds) {
    const joined = await joinOrganization(
      account.coreDb,
      input.userId,
      orgId,
      input.tenantId,
      'member'
    );
    if (joined.success) orgsJoined.push(orgId);
  }

  const rolesAssigned: JITProvisioningResult['roles_assigned'] = [];
  for (const role of input.plan.roleAssignments) {
    const assigned = await assignRoleToUserInternal(
      account.coreDb,
      input.userId,
      role.roleId,
      role.scopeType,
      role.scopeTarget,
      input.tenantId
    );
    if (assigned.success) {
      rolesAssigned.push({
        role_id: role.roleId,
        scope_type: role.scopeType,
        scope_target: role.scopeTarget,
      });
    }
  }
  if (rolesAssigned.length === 0 && input.plan.defaultRoleId) {
    const scopeTarget = orgsJoined.length > 0 ? `org:${orgsJoined[0]}` : 'global';
    const scopeType = orgsJoined.length > 0 ? 'org' : 'global';
    const assigned = await assignRoleToUserInternal(
      account.coreDb,
      input.userId,
      input.plan.defaultRoleId,
      scopeType,
      scopeTarget,
      input.tenantId
    );
    if (assigned.success) {
      rolesAssigned.push({
        role_id: input.plan.defaultRoleId,
        scope_type: scopeType,
        scope_target: scopeTarget,
      });
    }
  }

  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(env, input.tenantId);
  await syncUserLifecycleState({
    db: account.coreDb,
    dbPii: account.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: ensureDatabaseAdapter(account.coreDb, 'external-idp-jit-lifecycle'),
    tenantId: input.tenantId,
    userId: input.userId,
    accountAuthenticationEnv: env,
  });
  await activatePendingLinkedIdentity(env, pending, account.piiDb);
  return { linkedIdentityId: pending.id, roles_assigned: rolesAssigned, orgs_joined: orgsJoined };
}

function parseTenantD1JITPlan(value: string): TenantD1JITPlan {
  if (new TextEncoder().encode(value).byteLength > 20 * 1024) {
    throw new Error('external_idp_jit_plan_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('external_idp_jit_plan_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('external_idp_jit_plan_invalid');
  }
  const plan = parsed as Record<string, unknown>;
  const validation = plan.customClaimValidation as Record<string, unknown> | undefined;
  const boundedString = (candidate: unknown, maximumLength = 256): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maximumLength;
  const boundedStringArray = (candidate: unknown, maximumEntries: number): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.length <= maximumEntries &&
    candidate.every((entry) => boundedString(entry));
  const boundedStringMap = (candidate: unknown): candidate is Record<string, string> =>
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    Object.keys(candidate).length <= 64 &&
    Object.entries(candidate).every(
      ([key, entry]) => boundedString(key, 128) && boundedString(entry, 16 * 1024)
    );
  if (
    plan.schemaVersion !== 1 ||
    Object.keys(plan).length !== 7 ||
    !validation ||
    validation.ok !== true ||
    !Array.isArray(validation.schemas) ||
    validation.schemas.length > 64 ||
    !validation.schemas.every(
      (schema) =>
        schema !== null &&
        typeof schema === 'object' &&
        !Array.isArray(schema) &&
        boundedString((schema as Record<string, unknown>).field_key, 128) &&
        boundedString((schema as Record<string, unknown>).field_type, 64)
    ) ||
    !boundedStringMap(validation.nonPiiValues) ||
    !boundedStringMap(validation.piiValues) ||
    !boundedStringArray(validation.nonPiiKeysToDelete, 64) ||
    !boundedStringArray(validation.piiKeysToDelete, 64) ||
    !Array.isArray(plan.organizationIds) ||
    plan.organizationIds.length > 64 ||
    !plan.organizationIds.every((entry) => boundedString(entry)) ||
    !Array.isArray(plan.roleAssignments) ||
    plan.roleAssignments.length > 128 ||
    !plan.roleAssignments.every(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 3 &&
        boundedString((value as Record<string, unknown>).roleId) &&
        boundedString((value as Record<string, unknown>).scopeType, 64) &&
        boundedString((value as Record<string, unknown>).scopeTarget)
    ) ||
    (plan.defaultRoleId !== null && !boundedString(plan.defaultRoleId)) ||
    !boundedStringArray(plan.matchedRules, 128) ||
    !Array.isArray(plan.attributesSet) ||
    plan.attributesSet.length > 128 ||
    !plan.attributesSet.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 2 &&
        boundedString((entry as Record<string, unknown>).name, 128) &&
        boundedString((entry as Record<string, unknown>).value, 4096)
    )
  ) {
    throw new Error('external_idp_jit_plan_invalid');
  }
  return parsed as TenantD1JITPlan;
}

export async function completeTenantD1ExternalIdpJIT(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    providerId: string;
    providerUserId: string;
  }
): Promise<Pick<JITProvisioningResult, 'linkedIdentityId' | 'roles_assigned' | 'orgs_joined'>> {
  const account = await resolveAccountDataContextByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'external_subject',
    identifier: { issuer: input.providerId, subject: input.providerUserId },
  });
  if (account.legacyUserId !== input.userId) {
    throw new Error('external_idp_jit_account_route_mismatch');
  }
  const pending = await findPendingLinkedIdentityProvisioning(
    env,
    input.tenantId,
    input.providerId,
    input.providerUserId,
    account.piiDb
  );
  if (!pending) {
    const active = await findLinkedIdentity(
      env,
      input.tenantId,
      input.providerId,
      input.providerUserId,
      account.piiDb
    );
    if (active?.userId === input.userId) {
      return { linkedIdentityId: active.id, roles_assigned: [], orgs_joined: [] };
    }
  }
  if (!pending || pending.userId !== input.userId) {
    throw new Error('external_idp_jit_pending_identity_not_found');
  }
  const plan = parseTenantD1JITPlan(
    await decrypt(pending.profileDataEncrypted, getEncryptionKey(env))
  );
  return applyTenantD1JITPlan(env, { ...input, plan });
}

export const completeExternalIdpJIT = completeTenantD1ExternalIdpJIT;

async function createTenantD1UserWithJITProvisioning(
  env: Env,
  params: TenantD1JITProvisioningParams
): Promise<JITProvisioningResult> {
  if (!env.EXTERNAL_IDP_ACCOUNT_PROVISIONER) {
    throw new Error('external_idp_account_provisioner_unavailable');
  }
  const userStoreSources = await resolveTenantUserStoreSourcesFromEnv(env, params.tenantId);
  const customClaimSources = {
    schemaDb: (await resolveTenantMetadataContext(env, params.tenantId)).coreDb,
    nonPiiDb: userStoreSources.coreDb,
    piiDb: userStoreSources.piiDb,
  };
  const tenantMetadata = await resolveTenantMetadataContext(env, params.tenantId);
  const customClaimValidation = await validateProvisionedCustomClaims(
    env,
    params.tenantId,
    params.customClaims,
    customClaimSources
  );
  const result: JITProvisioningResult = {
    userId: '',
    denied: false,
    matched_rules: [],
    roles_assigned: [],
    orgs_joined: [],
    attributes_set: [],
  };

  let emailDomainHash: string | undefined;
  let emailDomainHashVersion: number | undefined;
  if (params.email?.includes('@')) {
    const hashConfig = await getEmailDomainHashConfig(env);
    const hashResult = await generateEmailDomainHashWithVersion(params.email, hashConfig);
    emailDomainHash = hashResult.hash;
    emailDomainHashVersion = hashResult.version;
  }
  const ruleResult = await createRuleEvaluator(tenantMetadata.coreDb, env.SETTINGS).evaluate({
    email_domain_hash: emailDomainHash,
    email_domain_hash_version: emailDomainHashVersion,
    email_verified: params.emailVerified,
    idp_claims: params.rawClaims,
    provider_id: params.identityProviderId,
    user_type: 'end_user',
    tenant_id: params.tenantId,
  });
  if (ruleResult.denied) {
    return {
      ...result,
      denied: true,
      deny_code: ruleResult.deny_code,
      deny_description: ruleResult.deny_description,
      matched_rules: ruleResult.matched_rules,
    };
  }

  const organizationIds = ruleResult.orgs_to_join.filter((orgId) => orgId !== 'auto');
  if (emailDomainHash) {
    const matches = params.jitConfig.join_all_matching_orgs
      ? await resolveAllOrgsByDomainHash(
          tenantMetadata.coreDb,
          emailDomainHash,
          params.tenantId,
          params.jitConfig
        )
      : [
          await resolveOrgByDomainHash(
            tenantMetadata.coreDb,
            emailDomainHash,
            params.tenantId,
            params.jitConfig
          ),
        ].filter((value): value is ResolvedOrganization => value !== null);
    for (const organization of matches) {
      if (!organizationIds.includes(organization.org_id)) {
        organizationIds.push(organization.org_id);
      }
    }
  }
  if (organizationIds.length === 0 && !params.jitConfig.allow_user_without_org) {
    return {
      ...result,
      denied: true,
      deny_code: 'access_denied',
      deny_description: 'No organization found for this user and standalone users are not allowed.',
      matched_rules: ruleResult.matched_rules,
    };
  }

  const roleAssignments = ruleResult.roles_to_assign
    .map((role) => ({
      roleId: role.role_id,
      scopeType: role.scope_type,
      scopeTarget:
        role.scope_target === 'auto' && organizationIds.length > 0
          ? `org:${organizationIds[0]}`
          : role.scope_target,
    }))
    .filter((role) => role.scopeTarget !== 'auto');
  const plan: TenantD1JITPlan = {
    schemaVersion: 1,
    customClaimValidation,
    organizationIds,
    roleAssignments,
    defaultRoleId: params.jitConfig.default_role_id ?? null,
    matchedRules: ruleResult.matched_rules,
    attributesSet: ruleResult.attributes_to_set,
  };
  const planJson = canonicalJson(plan);
  if (new TextEncoder().encode(planJson).byteLength > 20 * 1024) {
    throw new Error('external_idp_jit_plan_too_large');
  }
  const identityDigest = await sha256Hex(
    `${params.tenantId}\u0000${params.identityProviderId}\u0000${params.providerUserId}`
  );
  const candidateUserId = crypto.randomUUID();
  const email = (params.email ?? `${identityDigest}@external.authrim.local`).toLowerCase();
  const runtimeUser: AuthAccountProvisioningInput['runtimeUser'] = {
    active: true,
    emailVerified: params.emailVerified,
    userType: 'end_user',
    displayName: params.name ?? null,
    sourceRef: 'auth:external_idp',
    piiFields: {
      email: true,
      given_name: params.givenName !== undefined,
      family_name: params.familyName !== undefined,
      picture: params.picture !== undefined,
      locale: params.locale !== undefined,
    },
    sensitiveValues: {
      email,
      given_name: params.givenName ?? null,
      family_name: params.familyName ?? null,
      picture: params.picture ?? null,
      locale: params.locale ?? null,
    },
    inlineProfileFields: {
      ...(emailDomainHash ? { email_domain_hash: emailDomainHash } : {}),
      ...(emailDomainHashVersion ? { email_domain_hash_version: emailDomainHashVersion } : {}),
    },
  };
  const stableRequest = canonicalJson({
    schemaVersion: 1,
    tenantId: params.tenantId,
    flow: 'external_idp',
    email,
    externalSubject: { issuer: params.identityProviderId, subject: params.providerUserId },
    runtimeUser,
    plan,
  });
  const encryptionKey = getEncryptionKey(env);
  const now = Date.now();
  const request: AuthAccountProvisioningInput = {
    schemaVersion: 1,
    operationId: `account-create-${crypto.randomUUID()}`,
    idempotencyKey: `auth-account:${await sha256Hex(stableRequest)}`,
    tenantId: params.tenantId,
    candidateUserId,
    flow: 'external_idp',
    email,
    externalSubject: { issuer: params.identityProviderId, subject: params.providerUserId },
    externalIdentity: {
      id: `external-link-${identityDigest.slice(0, 32)}`,
      providerId: params.identityProviderId,
      providerUserId: params.providerUserId,
      providerEmail: params.email?.toLowerCase() ?? null,
      emailVerified: params.emailVerified,
      accessTokenEncrypted: await encrypt(params.tokens.access_token, encryptionKey),
      refreshTokenEncrypted: params.tokens.refresh_token
        ? await encrypt(params.tokens.refresh_token, encryptionKey)
        : null,
      tokenExpiresAt: params.tokens.expires_in ? now + params.tokens.expires_in * 1000 : null,
      rawClaimsJson: JSON.stringify(params.rawClaims),
      profileDataEncrypted: await encrypt(planJson, encryptionKey),
    },
    runtimeUser,
  };
  const provisioned =
    await env.EXTERNAL_IDP_ACCOUNT_PROVISIONER.provisionExternalIdpAccount(request);
  result.userId = provisioned.userId;
  result.matched_rules = ruleResult.matched_rules;
  result.attributes_set = ruleResult.attributes_to_set;
  if (provisioned.status === 202) {
    result.pending = {
      accountId: provisioned.accountId,
      operationId: provisioned.operationId,
      providerId: params.identityProviderId,
      providerUserId: params.providerUserId,
    };
    return result;
  }
  const applied = await applyTenantD1JITPlan(env, {
    tenantId: params.tenantId,
    userId: provisioned.userId,
    providerId: params.identityProviderId,
    providerUserId: params.providerUserId,
    plan,
  });
  return { ...result, ...applied };
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
  const userStoreSources = await resolveTenantUserStoreSourcesFromEnv(env, params.tenantId);
  const customClaimSources = {
    schemaDb: (await resolveTenantMetadataContext(env, params.tenantId)).coreDb,
    nonPiiDb: userStoreSources.coreDb,
    piiDb: userStoreSources.piiDb,
  };
  const { coreSource, coreAdapter, piiAdapter } = await resolveUserStoreAdapters(
    env,
    params.tenantId
  );
  if (!piiAdapter) {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.ACCOUNT_CREATION_FAILED,
      'Canonical runtime user creation requires a PII database.'
    );
  }
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter,
    tenantId: params.tenantId,
  });
  const customClaimValidation = await validateProvisionedCustomClaims(
    env,
    params.tenantId,
    params.customClaims,
    customClaimSources
  );

  const result: JITProvisioningResult = {
    userId: '',
    denied: false,
    matched_rules: [],
    roles_assigned: [],
    orgs_joined: [],
    attributes_set: [],
  };

  const id = crypto.randomUUID();
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

  await runtimeUsers.syncUser({
    userId: id,
    email: email.toLowerCase(),
    name: params.name || null,
    active: true,
    emailVerified: params.emailVerified,
    userType: 'end_user',
    sourceRef: `external-idp:${params.identityProviderId}`,
    piiFields: {
      given_name: params.givenName !== undefined,
      family_name: params.familyName !== undefined,
      picture: params.picture !== undefined,
      locale: params.locale !== undefined,
    },
    sensitiveValues: {
      given_name: params.givenName ?? null,
      family_name: params.familyName ?? null,
      picture: params.picture ?? null,
      locale: params.locale ?? null,
    },
    inlineProfileFields: {
      ...(emailDomainHash ? { email_domain_hash: emailDomainHash } : {}),
      ...(emailDomainHashVersion ? { email_domain_hash_version: emailDomainHashVersion } : {}),
    },
  });

  result.userId = id;

  try {
    await persistCustomClaimWrite({
      db: customClaimSources.nonPiiDb,
      dbPii: customClaimSources.piiDb,
      tenantId: params.tenantId,
      userId: id,
      validation: customClaimValidation,
    });
  } catch (persistError) {
    try {
      await runtimeUsers.deleteUser(id);
      await ensureDatabaseAdapter(
        customClaimSources.nonPiiDb,
        'identity-stitching-custom-claim-cleanup'
      ).execute('DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?', [
        params.tenantId,
        id,
      ]);
    } catch (cleanupError) {
      const log = createLogger().module('IDENTITY-STITCHING');
      log.error(
        'Failed to cleanup user after custom claim persistence failure',
        {
          action: 'cleanup_user',
          errorName: cleanupError instanceof Error ? cleanupError.name : 'Unknown error',
        },
        cleanupError as Error
      );
    }

    throw persistError;
  }

  // Step 4: Evaluate policy rules
  const ruleEvaluator = createRuleEvaluator(coreSource, env.SETTINGS);

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
      await runtimeUsers.deleteUser(id);
      await ensureDatabaseAdapter(
        customClaimSources.nonPiiDb,
        'identity-stitching-policy-cleanup'
      ).execute('DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?', [
        params.tenantId,
        id,
      ]);
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
        coreSource,
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
        coreSource,
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
      await runtimeUsers.deleteUser(id);
      await ensureDatabaseAdapter(
        customClaimSources.nonPiiDb,
        'identity-stitching-org-cleanup'
      ).execute('DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?', [
        params.tenantId,
        id,
      ]);
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
      coreSource,
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
      coreSource,
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
      coreSource,
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

  await syncUserLifecycleState({
    db: customClaimSources.nonPiiDb,
    dbPii: customClaimSources.piiDb,
    schemaDb: customClaimSources.schemaDb,
    stateDb: coreAdapter,
    tenantId: params.tenantId,
    userId: id,
    accountAuthenticationEnv: env,
  });

  return result;
}

/**
 * Assign role to user (internal helper)
 */
async function assignRoleToUserInternal(
  db: DatabaseSource,
  userId: string,
  roleId: string,
  scopeType: string,
  scopeTarget: string,
  tenantId: string
): Promise<{ success: boolean; assignment_id?: string; error?: string }> {
  const assignmentId = `ra_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const coreAdapter = ensureDatabaseAdapter(db, 'identity-stitching-role-assignment');

    // Check if role exists
    const roleCheck = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM roles WHERE id = ? AND tenant_id = ?',
      [roleId, tenantId]
    );

    if (!roleCheck) {
      // SECURITY: Do not expose role ID to prevent enumeration
      return { success: false, error: 'Role not found' };
    }

    // Check if already assigned
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE tenant_id = ? AND user_id = ? AND role_id = ? AND scope_type = ? AND scope_target = ?`,
      [tenantId, userId, roleId, scopeType, scopeTarget]
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
