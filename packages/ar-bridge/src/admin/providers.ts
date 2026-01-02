/**
 * Admin API for Provider Management
 * CRUD operations for upstream providers (admin only)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { timingSafeEqual, createErrorResponse, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  listAllProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from '../services/provider-store';
import { GOOGLE_DEFAULT_CONFIG } from '../providers/google';
import {
  MICROSOFT_DEFAULT_CONFIG,
  getMicrosoftIssuer,
  validateMicrosoftConfig,
} from '../providers/microsoft';
import {
  GITHUB_DEFAULT_CONFIG,
  validateGitHubConfig,
  getGitHubEffectiveEndpoints,
  type GitHubProviderQuirks,
} from '../providers/github';
import { LINKEDIN_DEFAULT_CONFIG, validateLinkedInConfig } from '../providers/linkedin';
import {
  FACEBOOK_DEFAULT_CONFIG,
  validateFacebookConfig,
  getFacebookEffectiveEndpoints,
  type FacebookProviderQuirks,
} from '../providers/facebook';
import {
  TWITTER_DEFAULT_CONFIG,
  validateTwitterConfig,
  getTwitterEffectiveEndpoints,
  type TwitterProviderQuirks,
} from '../providers/twitter';
import {
  APPLE_DEFAULT_CONFIG,
  validateAppleConfig,
  type AppleProviderQuirks,
} from '../providers/apple';
import { encrypt, getEncryptionKey } from '../utils/crypto';

/**
 * Verify admin authentication
 */
function verifyAdmin(c: Context<{ Bindings: Env }>): boolean {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  // Use timing-safe comparison to prevent timing attacks
  return !!c.env.ADMIN_API_SECRET && timingSafeEqual(token, c.env.ADMIN_API_SECRET);
}

/**
 * List all providers (admin)
 * GET /external-idp/admin/providers
 */
export async function handleAdminListProviders(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  try {
    const tenantId = c.req.query('tenant_id') || 'default';
    const providers = await listAllProviders(c.env, tenantId);

    // Remove encrypted secrets from response
    const sanitized = providers.map((p) => ({
      ...p,
      clientSecretEncrypted: undefined,
      hasSecret: !!p.clientSecretEncrypted,
    }));

    return c.json({ providers: sanitized });
  } catch (error) {
    console.error('Failed to list providers:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Create new provider
 * POST /external-idp/admin/providers
 */
export async function handleAdminCreateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  try {
    const body = await c.req.json<{
      slug?: string;
      name: string;
      provider_type: 'oidc' | 'oauth2';
      client_id: string;
      client_secret: string;
      issuer?: string;
      scopes?: string;
      enabled?: boolean;
      priority?: number;
      auto_link_email?: boolean;
      jit_provisioning?: boolean;
      require_email_verified?: boolean;
      always_fetch_userinfo?: boolean;
      icon_url?: string;
      button_color?: string;
      button_text?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      userinfo_endpoint?: string;
      jwks_uri?: string;
      token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post';
      attribute_mapping?: Record<string, string>;
      provider_quirks?: Record<string, unknown>;
      tenant_id?: string;
      template?: 'google' | 'github' | 'microsoft' | 'linkedin' | 'facebook' | 'twitter' | 'apple';
      // Request Object (JAR - RFC 9101) settings
      use_request_object?: boolean;
      request_object_signing_alg?: string;
      private_key_jwk?: Record<string, unknown>;
      public_key_jwk?: Record<string, unknown>;
    }>();

    // Validate required fields
    if (!body.name || !body.client_id || !body.client_secret) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'name, client_id, client_secret' },
      });
    }

    // Apply template defaults if specified
    let defaults: Record<string, unknown> = {};
    if (body.template === 'google') {
      defaults = { ...GOOGLE_DEFAULT_CONFIG };
    } else if (body.template === 'microsoft') {
      // Apply Microsoft defaults with tenant type from quirks
      const quirks = body.provider_quirks as { tenantType?: string } | undefined;
      const tenantType = quirks?.tenantType || 'common';

      // Validate tenant type before using it in URL construction
      const validationErrors = validateMicrosoftConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder', // Will be set later
        scopes: body.scopes || 'openid email profile',
        providerQuirks: { tenantType },
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      defaults = {
        ...MICROSOFT_DEFAULT_CONFIG,
        issuer: getMicrosoftIssuer(tenantType),
        providerQuirks: { tenantType },
      };
    } else if (body.template === 'github') {
      // Apply GitHub defaults
      const quirks = body.provider_quirks as GitHubProviderQuirks | undefined;

      // Validate GitHub configuration
      const validationErrors = validateGitHubConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder', // Will be set later
        scopes: body.scopes || 'read:user user:email',
        providerQuirks: (quirks || {}) as Record<string, unknown>,
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Get effective endpoints (handles GitHub Enterprise if configured)
      const endpoints = getGitHubEffectiveEndpoints({
        providerQuirks: (quirks || {}) as Record<string, unknown>,
      });

      defaults = {
        ...GITHUB_DEFAULT_CONFIG,
        authorizationEndpoint: endpoints.authorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        userinfoEndpoint: endpoints.userinfoEndpoint,
        providerQuirks: quirks || GITHUB_DEFAULT_CONFIG.providerQuirks,
      };
    } else if (body.template === 'linkedin') {
      // Apply LinkedIn defaults (standard OIDC)
      const validationErrors = validateLinkedInConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder',
        scopes: body.scopes || 'openid profile email',
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      defaults = { ...LINKEDIN_DEFAULT_CONFIG };
    } else if (body.template === 'facebook') {
      // Apply Facebook defaults
      const quirks = body.provider_quirks as FacebookProviderQuirks | undefined;

      const validationErrors = validateFacebookConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder',
        scopes: body.scopes || 'email public_profile',
        providerQuirks: (quirks || {}) as Record<string, unknown>,
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Get effective endpoints with API version
      const endpoints = getFacebookEffectiveEndpoints(quirks);

      defaults = {
        ...FACEBOOK_DEFAULT_CONFIG,
        authorizationEndpoint: endpoints.authorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        userinfoEndpoint: endpoints.userinfoEndpoint,
        providerQuirks: quirks || FACEBOOK_DEFAULT_CONFIG.providerQuirks,
      };
    } else if (body.template === 'twitter') {
      // Apply Twitter defaults
      const quirks = body.provider_quirks as TwitterProviderQuirks | undefined;

      const validationErrors = validateTwitterConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder',
        scopes: body.scopes || 'users.read tweet.read offline.access',
        providerQuirks: (quirks || {}) as Record<string, unknown>,
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Get effective endpoints with user.fields
      const endpoints = getTwitterEffectiveEndpoints(quirks);

      defaults = {
        ...TWITTER_DEFAULT_CONFIG,
        authorizationEndpoint: endpoints.authorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        userinfoEndpoint: endpoints.userinfoEndpoint,
        providerQuirks: quirks || TWITTER_DEFAULT_CONFIG.providerQuirks,
      };
    } else if (body.template === 'apple') {
      // Apply Apple defaults
      const quirks = body.provider_quirks as AppleProviderQuirks | undefined;

      const validationErrors = validateAppleConfig({
        clientId: body.client_id,
        clientSecretEncrypted: 'placeholder',
        scopes: body.scopes || 'openid name email',
        providerQuirks: (quirks || {}) as Record<string, unknown>,
      });
      if (validationErrors.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      defaults = {
        ...APPLE_DEFAULT_CONFIG,
        providerQuirks: quirks || APPLE_DEFAULT_CONFIG.providerQuirks,
      };
    }

    // Encrypt client secret (required)
    const encryptionKey = getEncryptionKey(c.env);
    const clientSecretEncrypted = await encrypt(body.client_secret, encryptionKey);

    // Encrypt private key JWK if provided (for request object signing)
    let privateKeyJwkEncrypted: string | undefined;
    if (body.private_key_jwk) {
      privateKeyJwkEncrypted = await encrypt(JSON.stringify(body.private_key_jwk), encryptionKey);
    }

    // Merge defaults with explicit body values (body values take precedence)
    const defaultIssuer = (defaults.issuer as string | undefined) || undefined;
    const defaultScopes = (defaults.scopes as string | undefined) || 'openid email profile';
    const defaultAttributeMapping =
      (defaults.attributeMapping as Record<string, string> | undefined) || {};
    const defaultProviderQuirks =
      (defaults.providerQuirks as Record<string, unknown> | undefined) || {};
    const defaultIconUrl = (defaults.iconUrl as string | undefined) || undefined;
    const defaultButtonColor = (defaults.buttonColor as string | undefined) || undefined;
    const defaultButtonText = (defaults.buttonText as string | undefined) || undefined;

    const provider = await createProvider(c.env, {
      tenantId: body.tenant_id || 'default',
      slug: body.slug,
      name: body.name,
      providerType: body.provider_type || 'oidc',
      enabled: body.enabled !== false,
      priority: body.priority || 0,
      issuer: body.issuer || defaultIssuer,
      clientId: body.client_id,
      clientSecretEncrypted,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      userinfoEndpoint: body.userinfo_endpoint,
      jwksUri: body.jwks_uri,
      scopes: body.scopes || defaultScopes,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
      attributeMapping: body.attribute_mapping || defaultAttributeMapping,
      autoLinkEmail: body.auto_link_email !== false,
      jitProvisioning: body.jit_provisioning !== false,
      requireEmailVerified: body.require_email_verified !== false,
      alwaysFetchUserinfo: body.always_fetch_userinfo === true,
      providerQuirks: body.provider_quirks || defaultProviderQuirks,
      iconUrl: body.icon_url || defaultIconUrl,
      buttonColor: body.button_color || defaultButtonColor,
      buttonText: body.button_text || defaultButtonText,
      // Request Object (JAR - RFC 9101) settings
      useRequestObject: body.use_request_object,
      requestObjectSigningAlg: body.request_object_signing_alg,
      privateKeyJwkEncrypted,
      publicKeyJwk: body.public_key_jwk,
    });

    // Remove secret from response
    const response = {
      ...provider,
      clientSecretEncrypted: undefined,
      hasSecret: true,
    };

    return c.json(response, 201);
  } catch (error) {
    console.error('Failed to create provider:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get provider details
 * GET /external-idp/admin/providers/:id
 */
export async function handleAdminGetProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  const id = c.req.param('id');

  try {
    const provider = await getProvider(c.env, id);
    if (!provider) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Remove secret from response
    const response = {
      ...provider,
      clientSecretEncrypted: undefined,
      hasSecret: !!provider.clientSecretEncrypted,
    };

    return c.json(response);
  } catch (error) {
    console.error('Failed to get provider:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Update provider
 * PUT /external-idp/admin/providers/:id
 */
export async function handleAdminUpdateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  const id = c.req.param('id');

  try {
    const body = await c.req.json<{
      slug?: string;
      name?: string;
      provider_type?: 'oidc' | 'oauth2';
      client_id?: string;
      client_secret?: string;
      issuer?: string;
      scopes?: string;
      enabled?: boolean;
      priority?: number;
      auto_link_email?: boolean;
      jit_provisioning?: boolean;
      require_email_verified?: boolean;
      always_fetch_userinfo?: boolean;
      icon_url?: string;
      button_color?: string;
      button_text?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      userinfo_endpoint?: string;
      jwks_uri?: string;
      token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post';
      attribute_mapping?: Record<string, string>;
      provider_quirks?: Record<string, unknown>;
      // Request Object (JAR - RFC 9101) settings
      use_request_object?: boolean;
      request_object_signing_alg?: string;
      private_key_jwk?: Record<string, unknown>;
      public_key_jwk?: Record<string, unknown>;
    }>();

    // Build updates object
    const updates: Record<string, unknown> = {};

    if (body.slug !== undefined) updates.slug = body.slug;
    if (body.name !== undefined) updates.name = body.name;
    if (body.provider_type !== undefined) updates.providerType = body.provider_type;
    if (body.client_id !== undefined) updates.clientId = body.client_id;
    if (body.client_secret !== undefined) {
      // Encrypt client secret (required)
      const encryptionKey = getEncryptionKey(c.env);
      updates.clientSecretEncrypted = await encrypt(body.client_secret, encryptionKey);
    }
    if (body.issuer !== undefined) updates.issuer = body.issuer;
    if (body.scopes !== undefined) updates.scopes = body.scopes;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.auto_link_email !== undefined) updates.autoLinkEmail = body.auto_link_email;
    if (body.jit_provisioning !== undefined) updates.jitProvisioning = body.jit_provisioning;
    if (body.require_email_verified !== undefined)
      updates.requireEmailVerified = body.require_email_verified;
    if (body.always_fetch_userinfo !== undefined)
      updates.alwaysFetchUserinfo = body.always_fetch_userinfo;
    if (body.icon_url !== undefined) updates.iconUrl = body.icon_url;
    if (body.button_color !== undefined) updates.buttonColor = body.button_color;
    if (body.button_text !== undefined) updates.buttonText = body.button_text;
    if (body.authorization_endpoint !== undefined)
      updates.authorizationEndpoint = body.authorization_endpoint;
    if (body.token_endpoint !== undefined) updates.tokenEndpoint = body.token_endpoint;
    if (body.userinfo_endpoint !== undefined) updates.userinfoEndpoint = body.userinfo_endpoint;
    if (body.jwks_uri !== undefined) updates.jwksUri = body.jwks_uri;
    if (body.token_endpoint_auth_method !== undefined)
      updates.tokenEndpointAuthMethod = body.token_endpoint_auth_method;
    if (body.attribute_mapping !== undefined) updates.attributeMapping = body.attribute_mapping;
    if (body.provider_quirks !== undefined) {
      // Validate Microsoft tenant type if present
      const quirks = body.provider_quirks as { tenantType?: string } | undefined;
      if (quirks?.tenantType) {
        const validTenantTypes = ['common', 'organizations', 'consumers'];
        const isValidBuiltIn = validTenantTypes.includes(quirks.tenantType);
        const isValidGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          quirks.tenantType
        );
        const isValidDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(quirks.tenantType);

        if (!isValidBuiltIn && !isValidGuid && !isValidDomain) {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
      }
      updates.providerQuirks = body.provider_quirks;
    }

    // Request Object (JAR - RFC 9101) settings
    if (body.use_request_object !== undefined) updates.useRequestObject = body.use_request_object;
    if (body.request_object_signing_alg !== undefined)
      updates.requestObjectSigningAlg = body.request_object_signing_alg;
    if (body.private_key_jwk !== undefined) {
      const encryptionKey = getEncryptionKey(c.env);
      updates.privateKeyJwkEncrypted = await encrypt(
        JSON.stringify(body.private_key_jwk),
        encryptionKey
      );
    }
    if (body.public_key_jwk !== undefined) updates.publicKeyJwk = body.public_key_jwk;

    const provider = await updateProvider(c.env, id, updates);
    if (!provider) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Remove secret from response
    const response = {
      ...provider,
      clientSecretEncrypted: undefined,
      hasSecret: !!provider.clientSecretEncrypted,
    };

    return c.json(response);
  } catch (error) {
    console.error('Failed to update provider:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Delete provider
 * DELETE /external-idp/admin/providers/:id
 */
export async function handleAdminDeleteProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  const id = c.req.param('id');

  try {
    const deleted = await deleteProvider(c.env, id);
    if (!deleted) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete provider:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
