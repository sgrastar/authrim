/**
 * Provider Store
 * CRUD operations for upstream provider configurations
 */

import type { Env } from '@authrim/shared';
import type { UpstreamProvider } from '../types';

/**
 * Get provider by ID
 */
export async function getProvider(env: Env, id: string): Promise<UpstreamProvider | null> {
  const result = await env.DB.prepare(`SELECT * FROM upstream_providers WHERE id = ?`)
    .bind(id)
    .first<DbUpstreamProvider>();

  if (!result) return null;
  return mapDbToProvider(result);
}

/**
 * Get provider by ID or slug (for routing)
 * Tries to find by slug first, then by ID
 */
export async function getProviderByIdOrSlug(
  env: Env,
  idOrSlug: string,
  tenantId = 'default'
): Promise<UpstreamProvider | null> {
  // First try by slug (case-insensitive)
  let result = await env.DB.prepare(
    `SELECT * FROM upstream_providers WHERE LOWER(slug) = LOWER(?) AND tenant_id = ?`
  )
    .bind(idOrSlug, tenantId)
    .first<DbUpstreamProvider>();

  // If not found by slug, try by ID
  if (!result) {
    result = await env.DB.prepare(`SELECT * FROM upstream_providers WHERE id = ?`)
      .bind(idOrSlug)
      .first<DbUpstreamProvider>();
  }

  if (!result) return null;
  return mapDbToProvider(result);
}

/**
 * Get provider by name (for routing)
 */
export async function getProviderByName(
  env: Env,
  name: string,
  tenantId = 'default'
): Promise<UpstreamProvider | null> {
  const result = await env.DB.prepare(
    `SELECT * FROM upstream_providers WHERE name = ? AND tenant_id = ? AND enabled = 1`
  )
    .bind(name, tenantId)
    .first<DbUpstreamProvider>();

  if (!result) return null;
  return mapDbToProvider(result);
}

/**
 * List all enabled providers (for login UI)
 */
export async function listEnabledProviders(
  env: Env,
  tenantId = 'default'
): Promise<UpstreamProvider[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM upstream_providers WHERE tenant_id = ? AND enabled = 1 ORDER BY priority ASC, name ASC`
  )
    .bind(tenantId)
    .all<DbUpstreamProvider>();

  return (result.results || []).map(mapDbToProvider);
}

/**
 * List all providers (for admin)
 */
export async function listAllProviders(
  env: Env,
  tenantId = 'default'
): Promise<UpstreamProvider[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM upstream_providers WHERE tenant_id = ? ORDER BY priority ASC, name ASC`
  )
    .bind(tenantId)
    .all<DbUpstreamProvider>();

  return (result.results || []).map(mapDbToProvider);
}

/**
 * Create new provider
 */
export async function createProvider(
  env: Env,
  provider: Omit<UpstreamProvider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<UpstreamProvider> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO upstream_providers (
      id, tenant_id, slug, name, provider_type, enabled, priority,
      issuer, client_id, client_secret_encrypted,
      authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri,
      scopes, attribute_mapping, auto_link_email, jit_provisioning, require_email_verified,
      provider_quirks, icon_url, button_color, button_text,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      provider.tenantId || 'default',
      provider.slug || null,
      provider.name,
      provider.providerType,
      provider.enabled ? 1 : 0,
      provider.priority || 0,
      provider.issuer || null,
      provider.clientId,
      provider.clientSecretEncrypted,
      provider.authorizationEndpoint || null,
      provider.tokenEndpoint || null,
      provider.userinfoEndpoint || null,
      provider.jwksUri || null,
      provider.scopes,
      JSON.stringify(provider.attributeMapping || {}),
      provider.autoLinkEmail ? 1 : 0,
      provider.jitProvisioning ? 1 : 0,
      provider.requireEmailVerified ? 1 : 0,
      JSON.stringify(provider.providerQuirks || {}),
      provider.iconUrl || null,
      provider.buttonColor || null,
      provider.buttonText || null,
      now,
      now
    )
    .run();

  return {
    ...provider,
    id,
    tenantId: provider.tenantId || 'default',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update provider
 */
export async function updateProvider(
  env: Env,
  id: string,
  updates: Partial<Omit<UpstreamProvider, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<UpstreamProvider | null> {
  const existing = await getProvider(env, id);
  if (!existing) return null;

  const now = Date.now();
  const updated = { ...existing, ...updates, updatedAt: now };

  await env.DB.prepare(
    `UPDATE upstream_providers SET
      slug = ?, name = ?, provider_type = ?, enabled = ?, priority = ?,
      issuer = ?, client_id = ?, client_secret_encrypted = ?,
      authorization_endpoint = ?, token_endpoint = ?, userinfo_endpoint = ?, jwks_uri = ?,
      scopes = ?, attribute_mapping = ?, auto_link_email = ?, jit_provisioning = ?, require_email_verified = ?,
      provider_quirks = ?, icon_url = ?, button_color = ?, button_text = ?,
      updated_at = ?
    WHERE id = ?`
  )
    .bind(
      updated.slug || null,
      updated.name,
      updated.providerType,
      updated.enabled ? 1 : 0,
      updated.priority,
      updated.issuer || null,
      updated.clientId,
      updated.clientSecretEncrypted,
      updated.authorizationEndpoint || null,
      updated.tokenEndpoint || null,
      updated.userinfoEndpoint || null,
      updated.jwksUri || null,
      updated.scopes,
      JSON.stringify(updated.attributeMapping || {}),
      updated.autoLinkEmail ? 1 : 0,
      updated.jitProvisioning ? 1 : 0,
      updated.requireEmailVerified ? 1 : 0,
      JSON.stringify(updated.providerQuirks || {}),
      updated.iconUrl || null,
      updated.buttonColor || null,
      updated.buttonText || null,
      now,
      id
    )
    .run();

  return updated;
}

/**
 * Delete provider
 */
export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM upstream_providers WHERE id = ?`).bind(id).run();
  return (result.meta.changes || 0) > 0;
}

// =============================================================================
// Internal Types and Mappers
// =============================================================================

interface DbUpstreamProvider {
  id: string;
  tenant_id: string;
  slug: string | null;
  name: string;
  provider_type: string;
  enabled: number;
  priority: number;
  issuer: string | null;
  client_id: string;
  client_secret_encrypted: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  jwks_uri: string | null;
  scopes: string;
  attribute_mapping: string;
  auto_link_email: number;
  jit_provisioning: number;
  require_email_verified: number;
  provider_quirks: string;
  icon_url: string | null;
  button_color: string | null;
  button_text: string | null;
  created_at: number;
  updated_at: number;
}

function mapDbToProvider(db: DbUpstreamProvider): UpstreamProvider {
  return {
    id: db.id,
    tenantId: db.tenant_id,
    slug: db.slug || undefined,
    name: db.name,
    providerType: db.provider_type as 'oidc' | 'oauth2',
    enabled: db.enabled === 1,
    priority: db.priority,
    issuer: db.issuer || undefined,
    clientId: db.client_id,
    clientSecretEncrypted: db.client_secret_encrypted,
    authorizationEndpoint: db.authorization_endpoint || undefined,
    tokenEndpoint: db.token_endpoint || undefined,
    userinfoEndpoint: db.userinfo_endpoint || undefined,
    jwksUri: db.jwks_uri || undefined,
    scopes: db.scopes,
    attributeMapping: JSON.parse(db.attribute_mapping || '{}'),
    autoLinkEmail: db.auto_link_email === 1,
    jitProvisioning: db.jit_provisioning === 1,
    requireEmailVerified: db.require_email_verified === 1,
    providerQuirks: JSON.parse(db.provider_quirks || '{}'),
    iconUrl: db.icon_url || undefined,
    buttonColor: db.button_color || undefined,
    buttonText: db.button_text || undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}
