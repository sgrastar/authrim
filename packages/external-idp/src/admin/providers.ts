/**
 * Admin API for Provider Management
 * CRUD operations for upstream providers (admin only)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { timingSafeEqual } from '@authrim/shared';
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
    return c.json({ error: 'unauthorized' }, 401);
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
    return c.json({ error: 'internal_error' }, 500);
  }
}

/**
 * Create new provider
 * POST /external-idp/admin/providers
 */
export async function handleAdminCreateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return c.json({ error: 'unauthorized' }, 401);
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
      icon_url?: string;
      button_color?: string;
      button_text?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      userinfo_endpoint?: string;
      jwks_uri?: string;
      attribute_mapping?: Record<string, string>;
      provider_quirks?: Record<string, unknown>;
      tenant_id?: string;
      template?: 'google' | 'github' | 'microsoft';
    }>();

    // Validate required fields
    if (!body.name || !body.client_id || !body.client_secret) {
      return c.json(
        { error: 'invalid_request', message: 'name, client_id, and client_secret are required' },
        400
      );
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
        return c.json({ error: 'invalid_request', message: validationErrors.join(', ') }, 400);
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
        return c.json({ error: 'invalid_request', message: validationErrors.join(', ') }, 400);
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
    }

    // Encrypt client secret (required)
    const encryptionKey = getEncryptionKey(c.env);
    const clientSecretEncrypted = await encrypt(body.client_secret, encryptionKey);

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
      attributeMapping: body.attribute_mapping || defaultAttributeMapping,
      autoLinkEmail: body.auto_link_email !== false,
      jitProvisioning: body.jit_provisioning !== false,
      requireEmailVerified: body.require_email_verified !== false,
      providerQuirks: body.provider_quirks || defaultProviderQuirks,
      iconUrl: body.icon_url || defaultIconUrl,
      buttonColor: body.button_color || defaultButtonColor,
      buttonText: body.button_text || defaultButtonText,
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
    return c.json({ error: 'internal_error' }, 500);
  }
}

/**
 * Get provider details
 * GET /external-idp/admin/providers/:id
 */
export async function handleAdminGetProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const id = c.req.param('id');

  try {
    const provider = await getProvider(c.env, id);
    if (!provider) {
      return c.json({ error: 'not_found' }, 404);
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
    return c.json({ error: 'internal_error' }, 500);
  }
}

/**
 * Update provider
 * PUT /external-idp/admin/providers/:id
 */
export async function handleAdminUpdateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return c.json({ error: 'unauthorized' }, 401);
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
      icon_url?: string;
      button_color?: string;
      button_text?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
      userinfo_endpoint?: string;
      jwks_uri?: string;
      attribute_mapping?: Record<string, string>;
      provider_quirks?: Record<string, unknown>;
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
    if (body.icon_url !== undefined) updates.iconUrl = body.icon_url;
    if (body.button_color !== undefined) updates.buttonColor = body.button_color;
    if (body.button_text !== undefined) updates.buttonText = body.button_text;
    if (body.authorization_endpoint !== undefined)
      updates.authorizationEndpoint = body.authorization_endpoint;
    if (body.token_endpoint !== undefined) updates.tokenEndpoint = body.token_endpoint;
    if (body.userinfo_endpoint !== undefined) updates.userinfoEndpoint = body.userinfo_endpoint;
    if (body.jwks_uri !== undefined) updates.jwksUri = body.jwks_uri;
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
          return c.json(
            {
              error: 'invalid_request',
              message:
                'tenantType must be "common", "organizations", "consumers", a valid tenant ID (GUID), or domain',
            },
            400
          );
        }
      }
      updates.providerQuirks = body.provider_quirks;
    }

    const provider = await updateProvider(c.env, id, updates);
    if (!provider) {
      return c.json({ error: 'not_found' }, 404);
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
    return c.json({ error: 'internal_error' }, 500);
  }
}

/**
 * Delete provider
 * DELETE /external-idp/admin/providers/:id
 */
export async function handleAdminDeleteProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!verifyAdmin(c)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const id = c.req.param('id');

  try {
    const deleted = await deleteProvider(c.env, id);
    if (!deleted) {
      return c.json({ error: 'not_found' }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete provider:', error);
    return c.json({ error: 'internal_error' }, 500);
  }
}
