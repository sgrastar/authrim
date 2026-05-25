/**
 * Admin API for Provider Management
 * CRUD operations for upstream providers (admin only)
 */

import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  getTenantIdFromContext,
  hasAdminPermission,
  validateWebhookUrl,
} from '@authrim/ar-lib-core';
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

const OUTBOUND_PROVIDER_URL_FIELDS = [
  ['issuer', 'issuer'],
  ['authorization_endpoint', 'authorizationEndpoint'],
  ['token_endpoint', 'tokenEndpoint'],
  ['userinfo_endpoint', 'userinfoEndpoint'],
  ['jwks_uri', 'jwksUri'],
] as const;

const LOGIN_PROVIDER_ICON_NAMES = new Set([
  'buildings',
  'house',
  'house-simple',
  'bank',
  'building',
  'city',
  'graduation-cap',
  'student',
  'books',
  'chalkboard-teacher',
  'globe',
  'globe-hemisphere-east',
  'shield-check',
  'seal-check',
  'certificate',
  'identification-card',
  'fingerprint',
  'key',
  'briefcase',
  'users-three',
  'network',
  'share-network',
  'tree-structure',
  'handshake',
  'cloud',
  'cloud-check',
  'database',
  'hard-drives',
  'devices',
  'terminal-window',
  'book-open',
  'presentation-chart',
  'rocket-launch',
  'compass',
  'none',
]);

type AdminProviderContext = Context<{ Bindings: Env }>;
type AdminProviderAuthContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

async function requireAdminProviderPermission(
  c: AdminProviderContext,
  permission: string
): Promise<Response | null> {
  const auth = (c as unknown as AdminProviderAuthContext).get('adminAuth');
  if (!auth) {
    return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }
  if (!hasAdminPermission(auth.permissions || [], permission)) {
    return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
}

function validateProviderOutboundUrl(
  c: Context<{ Bindings: Env }>,
  value: unknown,
  field: string
): Response | Promise<Response> | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field, reason: 'must be a string' },
    });
  }

  const result = validateWebhookUrl(value, c.env.ENVIRONMENT === 'development');
  if (result.valid) {
    return null;
  }

  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field, reason: 'must be an external HTTPS URL' },
  });
}

function normalizeLoginProviderIconName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return LOGIN_PROVIDER_ICON_NAMES.has(normalized) ? normalized : undefined;
}

/**
 * List all providers (admin)
 * GET /external-idp/admin/providers
 */
export async function handleAdminListProviders(c: AdminProviderContext): Promise<Response> {
  const log = getLogger(c).module('ADMIN-PROVIDERS');
  const forbidden = await requireAdminProviderPermission(
    c,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ
  );
  if (forbidden) {
    return forbidden;
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    const providers = await listAllProviders(c.env, tenantId);

    // Remove encrypted secrets from response
    const sanitized = providers.map((p) => ({
      ...p,
      clientSecretEncrypted: undefined,
      hasSecret: !!p.clientSecretEncrypted,
    }));

    return c.json({ providers: sanitized });
  } catch (error) {
    log.error('Failed to list providers', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Create new provider
 * POST /external-idp/admin/providers
 */
export async function handleAdminCreateProvider(c: AdminProviderContext): Promise<Response> {
  const log = getLogger(c).module('ADMIN-PROVIDERS');
  const forbidden = await requireAdminProviderPermission(
    c,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE
  );
  if (forbidden) {
    return forbidden;
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
      enable_sso?: boolean;
      icon_url?: string | null;
      icon_name?: string | null;
      button_color?: string;
      button_color_dark?: string;
      button_text?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      userinfo_endpoint?: string;
      jwks_uri?: string;
      token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post';
      attribute_mapping?: Record<string, string>;
      provider_quirks?: Record<string, unknown>;
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
    const defaultButtonColorDark = (defaults.buttonColorDark as string | undefined) || undefined;
    const defaultButtonText = (defaults.buttonText as string | undefined) || undefined;

    const effectiveProviderUrls = {
      issuer: body.issuer || defaultIssuer,
      authorizationEndpoint:
        body.authorization_endpoint || (defaults.authorizationEndpoint as string | undefined),
      tokenEndpoint: body.token_endpoint || (defaults.tokenEndpoint as string | undefined),
      userinfoEndpoint: body.userinfo_endpoint || (defaults.userinfoEndpoint as string | undefined),
      jwksUri: body.jwks_uri || (defaults.jwksUri as string | undefined),
    };
    for (const [field, key] of OUTBOUND_PROVIDER_URL_FIELDS) {
      const validationResponse = validateProviderOutboundUrl(c, effectiveProviderUrls[key], field);
      if (validationResponse) {
        return validationResponse;
      }
    }

    const provider = await createProvider(c.env, {
      tenantId: getTenantIdFromContext(c),
      slug: body.slug,
      name: body.name,
      providerType: body.provider_type || 'oidc',
      enabled: body.enabled !== false,
      priority: body.priority || 0,
      issuer: effectiveProviderUrls.issuer,
      clientId: body.client_id,
      clientSecretEncrypted,
      authorizationEndpoint: effectiveProviderUrls.authorizationEndpoint,
      tokenEndpoint: effectiveProviderUrls.tokenEndpoint,
      userinfoEndpoint: effectiveProviderUrls.userinfoEndpoint,
      jwksUri: effectiveProviderUrls.jwksUri,
      scopes: body.scopes || defaultScopes,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
      attributeMapping: body.attribute_mapping || defaultAttributeMapping,
      autoLinkEmail: body.auto_link_email !== false,
      jitProvisioning: body.jit_provisioning !== false,
      requireEmailVerified: body.require_email_verified !== false,
      alwaysFetchUserinfo: body.always_fetch_userinfo === true,
      enableSso: body.enable_sso !== false,
      providerQuirks: body.provider_quirks || defaultProviderQuirks,
      iconUrl: body.icon_url || defaultIconUrl,
      iconName: normalizeLoginProviderIconName(body.icon_name),
      buttonColor: body.button_color || defaultButtonColor,
      buttonColorDark: body.button_color_dark || defaultButtonColorDark,
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
    log.error('Failed to create provider', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get provider details
 * GET /external-idp/admin/providers/:id
 */
export async function handleAdminGetProvider(c: AdminProviderContext): Promise<Response> {
  const log = getLogger(c).module('ADMIN-PROVIDERS');
  const forbidden = await requireAdminProviderPermission(
    c,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ
  );
  if (forbidden) {
    return forbidden;
  }

  const id = c.req.param('id');
  if (!id) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  try {
    const tenantId = getTenantIdFromContext(c);
    const provider = await getProvider(c.env, tenantId, id);
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
    log.error('Failed to get provider', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Update provider
 * PUT /external-idp/admin/providers/:id
 */
export async function handleAdminUpdateProvider(c: AdminProviderContext): Promise<Response> {
  const log = getLogger(c).module('ADMIN-PROVIDERS');
  const forbidden = await requireAdminProviderPermission(
    c,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE
  );
  if (forbidden) {
    return forbidden;
  }

  const id = c.req.param('id');
  if (!id) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

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
      enable_sso?: boolean;
      icon_url?: string | null;
      icon_name?: string | null;
      button_color?: string;
      button_color_dark?: string;
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
    const updateUrlFields = [
      ['issuer', body.issuer],
      ['authorization_endpoint', body.authorization_endpoint],
      ['token_endpoint', body.token_endpoint],
      ['userinfo_endpoint', body.userinfo_endpoint],
      ['jwks_uri', body.jwks_uri],
    ] as const;
    for (const [field, value] of updateUrlFields) {
      const validationResponse = validateProviderOutboundUrl(c, value, field);
      if (validationResponse) {
        return validationResponse;
      }
    }

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
    if (body.enable_sso !== undefined) updates.enableSso = body.enable_sso;
    if (body.icon_url !== undefined) updates.iconUrl = body.icon_url;
    if (body.icon_name !== undefined)
      updates.iconName = normalizeLoginProviderIconName(body.icon_name);
    if (body.button_color !== undefined) updates.buttonColor = body.button_color;
    if (body.button_color_dark !== undefined) updates.buttonColorDark = body.button_color_dark;
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

    const tenantId = getTenantIdFromContext(c);
    const provider = await updateProvider(c.env, tenantId, id, updates);
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
    log.error('Failed to update provider', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Delete provider
 * DELETE /external-idp/admin/providers/:id
 */
export async function handleAdminDeleteProvider(c: AdminProviderContext): Promise<Response> {
  const log = getLogger(c).module('ADMIN-PROVIDERS');
  const forbidden = await requireAdminProviderPermission(
    c,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE
  );
  if (forbidden) {
    return forbidden;
  }

  const id = c.req.param('id');
  if (!id) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  try {
    const tenantId = getTenantIdFromContext(c);
    const deleted = await deleteProvider(c.env, tenantId, id);
    if (!deleted) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete provider', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
