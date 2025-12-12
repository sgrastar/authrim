/**
 * Identity Stitching Service
 * Handles automatic linking of external identities to existing users
 */

import type { Env } from '@authrim/shared';
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
    if (stitchingConfig.requireVerifiedEmail && userInfo.email && !userInfo.email_verified) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.EMAIL_NOT_VERIFIED,
        'The email from your external account is not verified. Please verify your email with the provider first.',
        { providerName: provider.name }
      );
    }

    const newUser = await createUserFromExternalIdentity(env, {
      email: userInfo.email,
      emailVerified: userInfo.email_verified || false,
      name: userInfo.name,
      givenName: userInfo.given_name,
      familyName: userInfo.family_name,
      picture: userInfo.picture,
      locale: userInfo.locale,
      identityProviderId: provider.id,
      tenantId,
    });

    const linkedIdentityId = await createLinkedIdentity(env, {
      userId: newUser.id,
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
      userId: newUser.id,
      action: 'user_jit_provisioned',
      resourceType: 'user',
      resourceId: newUser.id,
      metadata: {
        providerId: provider.id,
        providerEmail: userInfo.email,
      },
    });

    return {
      userId: newUser.id,
      isNewUser: true,
      linkedIdentityId,
      stitchedFromExisting: false,
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
 */
async function findUserByEmail(
  env: Env,
  email: string,
  tenantId: string
): Promise<ExistingUser | null> {
  const result = await env.DB.prepare(
    `SELECT id, email, email_verified FROM users WHERE email = ? AND tenant_id = ?`
  )
    .bind(email, tenantId)
    .first<{ id: string; email: string; email_verified: number }>();

  if (!result) return null;

  return {
    id: result.id,
    email: result.email,
    email_verified: result.email_verified === 1,
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
 */
async function createUserFromExternalIdentity(
  env: Env,
  params: CreateUserParams
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Generate a placeholder email if not provided
  const email = params.email || `${id}@external.authrim.local`;

  await env.DB.prepare(
    `INSERT INTO users (
      id, tenant_id, email, email_verified,
      name, given_name, family_name, picture, locale,
      identity_provider_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      params.tenantId,
      email,
      params.emailVerified ? 1 : 0,
      params.name || null,
      params.givenName || null,
      params.familyName || null,
      params.picture || null,
      params.locale || null,
      params.identityProviderId,
      now,
      now
    )
    .run();

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

    await env.DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        params.userId,
        params.action,
        params.resourceType,
        params.resourceId,
        JSON.stringify(params.metadata || {}),
        now
      )
      .run();
  } catch (error) {
    // Don't fail the main operation if audit logging fails
    console.error('Failed to log audit event:', error);
  }
}

/**
 * Check if user has passkey credentials
 */
export async function hasPasskeyCredential(env: Env, userId: string): Promise<boolean> {
  const result = await env.DB.prepare(`SELECT COUNT(*) as count FROM passkeys WHERE user_id = ?`)
    .bind(userId)
    .first<{ count: number }>();

  return (result?.count || 0) > 0;
}
