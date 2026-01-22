/**
 * Provider Store
 * CRUD operations for upstream provider configurations
 */

import type { Env } from '@authrim/ar-lib-core';
import { D1Adapter, type DatabaseAdapter } from '@authrim/ar-lib-core';
import type { UpstreamProvider, TokenEndpointAuthMethod } from '../types';

/**
 * Get provider by ID
 */
export async function getProvider(env: Env, id: string): Promise<UpstreamProvider | null> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<DbUpstreamProvider>(
    'SELECT * FROM upstream_providers WHERE id = ?',
    [id]
  );

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
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });

  // First try by slug (case-insensitive)
  let result = await coreAdapter.queryOne<DbUpstreamProvider>(
    'SELECT * FROM upstream_providers WHERE LOWER(slug) = LOWER(?) AND tenant_id = ?',
    [idOrSlug, tenantId]
  );

  // If not found by slug, try by ID
  if (!result) {
    result = await coreAdapter.queryOne<DbUpstreamProvider>(
      'SELECT * FROM upstream_providers WHERE id = ?',
      [idOrSlug]
    );
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
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.queryOne<DbUpstreamProvider>(
    'SELECT * FROM upstream_providers WHERE name = ? AND tenant_id = ? AND enabled = 1',
    [name, tenantId]
  );

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
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.query<DbUpstreamProvider>(
    'SELECT * FROM upstream_providers WHERE tenant_id = ? AND enabled = 1 ORDER BY priority ASC, name ASC',
    [tenantId]
  );

  return result.map(mapDbToProvider);
}

/**
 * List all providers (for admin)
 */
export async function listAllProviders(
  env: Env,
  tenantId = 'default'
): Promise<UpstreamProvider[]> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.query<DbUpstreamProvider>(
    'SELECT * FROM upstream_providers WHERE tenant_id = ? ORDER BY priority ASC, name ASC',
    [tenantId]
  );

  return result.map(mapDbToProvider);
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

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  await coreAdapter.execute(
    `INSERT INTO upstream_providers (
      id, tenant_id, slug, name, provider_type, enabled, priority,
      issuer, client_id, client_secret_encrypted,
      authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri,
      scopes, token_endpoint_auth_method, attribute_mapping, auto_link_email, jit_provisioning, require_email_verified, always_fetch_userinfo,
      provider_quirks, icon_url, button_color, button_text,
      use_request_object, request_object_signing_alg, private_key_jwk_encrypted, public_key_jwk,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
      provider.tokenEndpointAuthMethod || 'client_secret_post',
      JSON.stringify(provider.attributeMapping || {}),
      provider.autoLinkEmail ? 1 : 0,
      provider.jitProvisioning ? 1 : 0,
      provider.requireEmailVerified ? 1 : 0,
      provider.alwaysFetchUserinfo ? 1 : 0,
      JSON.stringify(provider.providerQuirks || {}),
      provider.iconUrl || null,
      provider.buttonColor || null,
      provider.buttonText || null,
      provider.useRequestObject ? 1 : 0,
      provider.requestObjectSigningAlg || null,
      provider.privateKeyJwkEncrypted || null,
      provider.publicKeyJwk ? JSON.stringify(provider.publicKeyJwk) : null,
      now,
      now,
    ]
  );

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

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  await coreAdapter.execute(
    `UPDATE upstream_providers SET
      slug = ?, name = ?, provider_type = ?, enabled = ?, priority = ?,
      issuer = ?, client_id = ?, client_secret_encrypted = ?,
      authorization_endpoint = ?, token_endpoint = ?, userinfo_endpoint = ?, jwks_uri = ?,
      scopes = ?, token_endpoint_auth_method = ?, attribute_mapping = ?, auto_link_email = ?, jit_provisioning = ?, require_email_verified = ?, always_fetch_userinfo = ?,
      provider_quirks = ?, icon_url = ?, button_color = ?, button_text = ?,
      use_request_object = ?, request_object_signing_alg = ?, private_key_jwk_encrypted = ?, public_key_jwk = ?,
      updated_at = ?
    WHERE id = ?`,
    [
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
      updated.tokenEndpointAuthMethod || 'client_secret_post',
      JSON.stringify(updated.attributeMapping || {}),
      updated.autoLinkEmail ? 1 : 0,
      updated.jitProvisioning ? 1 : 0,
      updated.requireEmailVerified ? 1 : 0,
      updated.alwaysFetchUserinfo ? 1 : 0,
      JSON.stringify(updated.providerQuirks || {}),
      updated.iconUrl || null,
      updated.buttonColor || null,
      updated.buttonText || null,
      updated.useRequestObject ? 1 : 0,
      updated.requestObjectSigningAlg || null,
      updated.privateKeyJwkEncrypted || null,
      updated.publicKeyJwk ? JSON.stringify(updated.publicKeyJwk) : null,
      now,
      id,
    ]
  );

  return updated;
}

/**
 * Delete provider
 */
export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
  const result = await coreAdapter.execute('DELETE FROM upstream_providers WHERE id = ?', [id]);
  return result.rowsAffected > 0;
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
  token_endpoint_auth_method: string | null;
  attribute_mapping: string;
  auto_link_email: number;
  jit_provisioning: number;
  require_email_verified: number;
  always_fetch_userinfo: number;
  provider_quirks: string;
  icon_url: string | null;
  button_color: string | null;
  button_text: string | null;
  // Request Object (JAR - RFC 9101) fields
  use_request_object: number | null;
  request_object_signing_alg: string | null;
  private_key_jwk_encrypted: string | null;
  public_key_jwk: string | null;
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
    tokenEndpointAuthMethod:
      (db.token_endpoint_auth_method as TokenEndpointAuthMethod) || undefined,
    attributeMapping: JSON.parse(db.attribute_mapping || '{}'),
    autoLinkEmail: db.auto_link_email === 1,
    jitProvisioning: db.jit_provisioning === 1,
    requireEmailVerified: db.require_email_verified === 1,
    alwaysFetchUserinfo: db.always_fetch_userinfo === 1,
    providerQuirks: JSON.parse(db.provider_quirks || '{}'),
    iconUrl: db.icon_url || undefined,
    buttonColor: db.button_color || undefined,
    buttonText: db.button_text || undefined,
    // Request Object (JAR - RFC 9101) fields
    useRequestObject: db.use_request_object === 1,
    requestObjectSigningAlg: db.request_object_signing_alg || undefined,
    privateKeyJwkEncrypted: db.private_key_jwk_encrypted || undefined,
    publicKeyJwk: db.public_key_jwk ? JSON.parse(db.public_key_jwk) : undefined,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}
