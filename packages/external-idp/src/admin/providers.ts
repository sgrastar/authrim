/**
 * Admin API for Provider Management
 * CRUD operations for upstream providers (admin only)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import {
  listAllProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from '../services/provider-store';
import { GOOGLE_DEFAULT_CONFIG } from '../providers/google';
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
  return token === c.env.ADMIN_API_SECRET;
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
    let defaults = {};
    if (body.template === 'google') {
      defaults = GOOGLE_DEFAULT_CONFIG;
    }

    // Encrypt client secret (required)
    const encryptionKey = getEncryptionKey(c.env);
    const clientSecretEncrypted = await encrypt(body.client_secret, encryptionKey);

    const provider = await createProvider(c.env, {
      tenantId: body.tenant_id || 'default',
      name: body.name,
      providerType: body.provider_type || 'oidc',
      enabled: body.enabled !== false,
      priority: body.priority || 0,
      issuer: body.issuer,
      clientId: body.client_id,
      clientSecretEncrypted,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      userinfoEndpoint: body.userinfo_endpoint,
      jwksUri: body.jwks_uri,
      scopes: body.scopes || 'openid email profile',
      attributeMapping: body.attribute_mapping || {},
      autoLinkEmail: body.auto_link_email !== false,
      jitProvisioning: body.jit_provisioning !== false,
      requireEmailVerified: body.require_email_verified !== false,
      providerQuirks: {},
      iconUrl: body.icon_url,
      buttonColor: body.button_color,
      buttonText: body.button_text,
      ...defaults,
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
    }>();

    // Build updates object
    const updates: Record<string, unknown> = {};

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
