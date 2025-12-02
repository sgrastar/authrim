/**
 * SAML Provider Admin API
 *
 * CRUD operations for SAML IdP and SP configurations.
 * Uses the existing identity_providers table.
 *
 * GET    /saml/admin/providers     - List all SAML providers
 * POST   /saml/admin/providers     - Create new provider
 * GET    /saml/admin/providers/:id - Get provider details
 * PUT    /saml/admin/providers/:id - Update provider
 * DELETE /saml/admin/providers/:id - Delete provider
 * POST   /saml/admin/providers/:id/import-metadata - Import metadata
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import type {
  SAMLSPConfig,
  SAMLIdPConfig,
  SAMLProviderCreateRequest,
  SAMLProviderUpdateRequest,
  SAMLProviderResponse,
  MetadataImportRequest,
} from '@authrim/shared';
import {
  parseXml,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
} from '../common/xml-utils';
import { SAML_NAMESPACES, BINDING_URIS, NAMEID_FORMATS } from '../common/constants';

// ============================================================================
// Handlers
// ============================================================================

/**
 * List all SAML providers
 */
export async function handleListProviders(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  try {
    // Check admin authorization
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const providers = await env.DB.prepare(
      `SELECT id, name, provider_type, config_json, enabled, created_at, updated_at
       FROM identity_providers
       WHERE provider_type IN ('saml_idp', 'saml_sp')
       ORDER BY created_at DESC`
    ).all();

    const response = providers.results.map((row) => ({
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      config: JSON.parse(row.config_json as string),
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at as number).toISOString(),
      updatedAt: new Date(row.updated_at as number).toISOString(),
    }));

    return c.json({ providers: response });
  } catch (error) {
    console.error('List providers error:', error);
    return c.json({ error: 'Failed to list providers' }, 500);
  }
}

/**
 * Create new SAML provider
 */
export async function handleCreateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  try {
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = (await c.req.json()) as SAMLProviderCreateRequest;

    // Validate request
    if (!body.name || !body.providerType || !body.config) {
      return c.json({ error: 'Missing required fields: name, providerType, config' }, 400);
    }

    if (!['saml_idp', 'saml_sp'].includes(body.providerType)) {
      return c.json({ error: 'Invalid providerType. Must be saml_idp or saml_sp' }, 400);
    }

    // Validate config based on type
    if (body.providerType === 'saml_idp') {
      const config = body.config as SAMLIdPConfig;
      if (!config.entityId || !config.ssoUrl || !config.certificate) {
        return c.json({ error: 'IdP config requires entityId, ssoUrl, and certificate' }, 400);
      }
    } else {
      const config = body.config as SAMLSPConfig;
      if (!config.entityId || !config.acsUrl) {
        return c.json({ error: 'SP config requires entityId and acsUrl' }, 400);
      }
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO identity_providers (id, name, provider_type, config_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.name,
        body.providerType,
        JSON.stringify(body.config),
        body.enabled !== false ? 1 : 0,
        now,
        now
      )
      .run();

    return c.json(
      {
        id,
        name: body.name,
        providerType: body.providerType,
        config: body.config,
        enabled: body.enabled !== false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      201
    );
  } catch (error) {
    console.error('Create provider error:', error);
    return c.json({ error: 'Failed to create provider' }, 500);
  }
}

/**
 * Get provider by ID
 */
export async function handleGetProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const id = c.req.param('id');

  try {
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const provider = await env.DB.prepare(
      `SELECT id, name, provider_type, config_json, enabled, created_at, updated_at
       FROM identity_providers
       WHERE id = ? AND provider_type IN ('saml_idp', 'saml_sp')`
    )
      .bind(id)
      .first();

    if (!provider) {
      return c.json({ error: 'Provider not found' }, 404);
    }

    return c.json({
      id: provider.id,
      name: provider.name,
      providerType: provider.provider_type,
      config: JSON.parse(provider.config_json as string),
      enabled: provider.enabled === 1,
      createdAt: new Date(provider.created_at as number).toISOString(),
      updatedAt: new Date(provider.updated_at as number).toISOString(),
    });
  } catch (error) {
    console.error('Get provider error:', error);
    return c.json({ error: 'Failed to get provider' }, 500);
  }
}

/**
 * Update provider
 */
export async function handleUpdateProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const id = c.req.param('id');

  try {
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Get existing provider
    const existing = await env.DB.prepare(
      `SELECT id, name, provider_type, config_json, enabled
       FROM identity_providers
       WHERE id = ? AND provider_type IN ('saml_idp', 'saml_sp')`
    )
      .bind(id)
      .first();

    if (!existing) {
      return c.json({ error: 'Provider not found' }, 404);
    }

    const body = (await c.req.json()) as SAMLProviderUpdateRequest;
    const existingConfig = JSON.parse(existing.config_json as string);

    // Merge config updates
    const newConfig = body.config ? { ...existingConfig, ...body.config } : existingConfig;
    const now = Date.now();

    await env.DB.prepare(
      `UPDATE identity_providers
       SET name = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(
        body.name || existing.name,
        JSON.stringify(newConfig),
        body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
        now,
        id
      )
      .run();

    return c.json({
      id,
      name: body.name || existing.name,
      providerType: existing.provider_type,
      config: newConfig,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled === 1,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    console.error('Update provider error:', error);
    return c.json({ error: 'Failed to update provider' }, 500);
  }
}

/**
 * Delete provider
 */
export async function handleDeleteProvider(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const id = c.req.param('id');

  try {
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const result = await env.DB.prepare(
      `DELETE FROM identity_providers
       WHERE id = ? AND provider_type IN ('saml_idp', 'saml_sp')`
    )
      .bind(id)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Provider not found' }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Delete provider error:', error);
    return c.json({ error: 'Failed to delete provider' }, 500);
  }
}

/**
 * Import metadata from XML or URL
 */
export async function handleImportMetadata(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const id = c.req.param('id');

  try {
    if (!isAuthorized(c, env)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Get existing provider
    const existing = await env.DB.prepare(
      `SELECT id, provider_type, config_json
       FROM identity_providers
       WHERE id = ? AND provider_type IN ('saml_idp', 'saml_sp')`
    )
      .bind(id)
      .first();

    if (!existing) {
      return c.json({ error: 'Provider not found' }, 404);
    }

    const body = (await c.req.json()) as MetadataImportRequest;

    let metadataXml: string;

    if (body.metadataXml) {
      metadataXml = body.metadataXml;
    } else if (body.metadataUrl) {
      // Fetch metadata from URL
      const response = await fetch(body.metadataUrl);
      if (!response.ok) {
        return c.json({ error: `Failed to fetch metadata from URL: ${response.status}` }, 400);
      }
      metadataXml = await response.text();
    } else {
      return c.json({ error: 'Either metadataXml or metadataUrl is required' }, 400);
    }

    // Parse metadata based on provider type
    let newConfig: SAMLIdPConfig | SAMLSPConfig;

    if (existing.provider_type === 'saml_idp') {
      newConfig = parseIdPMetadata(metadataXml);
    } else {
      newConfig = parseSPMetadata(metadataXml);
    }

    // Merge with existing config (preserve custom settings)
    const existingConfig = JSON.parse(existing.config_json as string);
    const mergedConfig = {
      ...existingConfig,
      ...newConfig,
      metadataXml,
      metadataLastFetched: Date.now(),
    };

    const now = Date.now();

    await env.DB.prepare(
      `UPDATE identity_providers SET config_json = ?, updated_at = ? WHERE id = ?`
    )
      .bind(JSON.stringify(mergedConfig), now, id)
      .run();

    return c.json({
      success: true,
      config: mergedConfig,
    });
  } catch (error) {
    console.error('Import metadata error:', error);
    return c.json(
      {
        error: 'Failed to import metadata',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if request is authorized (Admin API)
 */
function isAuthorized(c: Context<{ Bindings: Env }>, env: Env): boolean {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);
  const adminSecret = env.ADMIN_API_SECRET || env.KEY_MANAGER_SECRET;

  return token === adminSecret;
}

/**
 * Parse IdP metadata XML
 */
function parseIdPMetadata(xml: string): SAMLIdPConfig {
  const doc = parseXml(xml);

  // Find IDPSSODescriptor
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new Error('Invalid metadata: missing EntityDescriptor');
  }

  const entityId = getAttribute(entityDescriptor, 'entityID');
  if (!entityId) {
    throw new Error('Invalid metadata: missing entityID');
  }

  const idpDescriptor = findElement(entityDescriptor, SAML_NAMESPACES.MD, 'IDPSSODescriptor');
  if (!idpDescriptor) {
    throw new Error('Invalid metadata: missing IDPSSODescriptor');
  }

  // Get SSO URL (prefer HTTP-POST)
  const ssoServices = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'SingleSignOnService');
  let ssoUrl = '';
  const allowedBindings: SAMLIdPConfig['allowedBindings'] = [];

  for (const sso of ssoServices) {
    const binding = getAttribute(sso, 'Binding');
    const location = getAttribute(sso, 'Location');

    if (binding === BINDING_URIS.HTTP_POST) {
      ssoUrl = ssoUrl || location || '';
      allowedBindings.push('post');
    } else if (binding === BINDING_URIS.HTTP_REDIRECT) {
      ssoUrl = ssoUrl || location || '';
      allowedBindings.push('redirect');
    }
  }

  if (!ssoUrl) {
    throw new Error('Invalid metadata: no supported SSO binding found');
  }

  // Get SLO URL (optional)
  const sloServices = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'SingleLogoutService');
  let sloUrl: string | undefined;

  for (const slo of sloServices) {
    const binding = getAttribute(slo, 'Binding');
    if (binding === BINDING_URIS.HTTP_POST || binding === BINDING_URIS.HTTP_REDIRECT) {
      sloUrl = getAttribute(slo, 'Location') || undefined;
      break;
    }
  }

  // Get certificate
  const keyDescriptors = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'KeyDescriptor');
  let certificate = '';

  for (const kd of keyDescriptors) {
    const use = getAttribute(kd, 'use');
    if (use === 'signing' || !use) {
      const x509Cert = findElement(kd, SAML_NAMESPACES.DS, 'X509Certificate');
      if (x509Cert) {
        const certText = getTextContent(x509Cert)?.replace(/\s+/g, '') || '';
        certificate = `-----BEGIN CERTIFICATE-----\n${certText}\n-----END CERTIFICATE-----`;
        break;
      }
    }
  }

  if (!certificate) {
    throw new Error('Invalid metadata: no signing certificate found');
  }

  // Get NameID formats
  const nameIdFormats = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'NameIDFormat');
  const nameIdFormat =
    nameIdFormats.length > 0
      ? (getTextContent(nameIdFormats[0]) as SAMLIdPConfig['nameIdFormat']) || NAMEID_FORMATS.EMAIL
      : NAMEID_FORMATS.EMAIL;

  return {
    entityId,
    ssoUrl,
    sloUrl,
    certificate,
    nameIdFormat,
    attributeMapping: {},
    allowedBindings,
  };
}

/**
 * Parse SP metadata XML
 */
function parseSPMetadata(xml: string): SAMLSPConfig {
  const doc = parseXml(xml);

  // Find SPSSODescriptor
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new Error('Invalid metadata: missing EntityDescriptor');
  }

  const entityId = getAttribute(entityDescriptor, 'entityID');
  if (!entityId) {
    throw new Error('Invalid metadata: missing entityID');
  }

  const spDescriptor = findElement(entityDescriptor, SAML_NAMESPACES.MD, 'SPSSODescriptor');
  if (!spDescriptor) {
    throw new Error('Invalid metadata: missing SPSSODescriptor');
  }

  // Get ACS URL (prefer HTTP-POST)
  const acsServices = findElements(spDescriptor, SAML_NAMESPACES.MD, 'AssertionConsumerService');
  let acsUrl = '';
  const allowedBindings: SAMLSPConfig['allowedBindings'] = [];

  for (const acs of acsServices) {
    const binding = getAttribute(acs, 'Binding');
    const location = getAttribute(acs, 'Location');
    const isDefault = getAttribute(acs, 'isDefault');

    if (binding === BINDING_URIS.HTTP_POST) {
      if (!acsUrl || isDefault === 'true') {
        acsUrl = location || '';
      }
      allowedBindings.push('post');
    } else if (binding === BINDING_URIS.HTTP_REDIRECT) {
      if (!acsUrl) {
        acsUrl = location || '';
      }
      allowedBindings.push('redirect');
    }
  }

  if (!acsUrl) {
    throw new Error('Invalid metadata: no supported ACS binding found');
  }

  // Get SLO URL (optional)
  const sloServices = findElements(spDescriptor, SAML_NAMESPACES.MD, 'SingleLogoutService');
  let sloUrl: string | undefined;

  for (const slo of sloServices) {
    const binding = getAttribute(slo, 'Binding');
    if (binding === BINDING_URIS.HTTP_POST || binding === BINDING_URIS.HTTP_REDIRECT) {
      sloUrl = getAttribute(slo, 'Location') || undefined;
      break;
    }
  }

  // Get certificate (optional for SP)
  let certificate: string | undefined;
  const keyDescriptors = findElements(spDescriptor, SAML_NAMESPACES.MD, 'KeyDescriptor');

  for (const kd of keyDescriptors) {
    const use = getAttribute(kd, 'use');
    if (use === 'signing' || !use) {
      const x509Cert = findElement(kd, SAML_NAMESPACES.DS, 'X509Certificate');
      if (x509Cert) {
        const certText = getTextContent(x509Cert)?.replace(/\s+/g, '') || '';
        certificate = `-----BEGIN CERTIFICATE-----\n${certText}\n-----END CERTIFICATE-----`;
        break;
      }
    }
  }

  // Get NameID formats
  const nameIdFormats = findElements(spDescriptor, SAML_NAMESPACES.MD, 'NameIDFormat');
  const nameIdFormat =
    nameIdFormats.length > 0
      ? (getTextContent(nameIdFormats[0]) as SAMLSPConfig['nameIdFormat']) || NAMEID_FORMATS.EMAIL
      : NAMEID_FORMATS.EMAIL;

  // Check if assertions should be signed
  const wantAssertionsSigned = getAttribute(spDescriptor, 'WantAssertionsSigned') === 'true';

  return {
    entityId,
    acsUrl,
    sloUrl,
    certificate,
    nameIdFormat,
    attributeMapping: {},
    signAssertions: wantAssertionsSigned,
    signResponses: true,
    allowedBindings,
  };
}

// ============================================================================
// Public Helper Functions (used by other modules)
// ============================================================================

/**
 * Get SP configuration by Entity ID
 */
export async function getSPConfig(env: Env, entityId: string): Promise<SAMLSPConfig | null> {
  const result = await env.DB.prepare(
    `SELECT config_json FROM identity_providers
     WHERE provider_type = 'saml_sp' AND enabled = 1`
  ).all();

  for (const row of result.results) {
    const config = JSON.parse(row.config_json as string) as SAMLSPConfig;
    if (config.entityId === entityId) {
      return config;
    }
  }

  return null;
}

/**
 * Get IdP configuration by provider ID
 */
export async function getIdPConfig(env: Env, providerId: string): Promise<SAMLIdPConfig | null> {
  const result = await env.DB.prepare(
    `SELECT config_json FROM identity_providers
     WHERE id = ? AND provider_type = 'saml_idp' AND enabled = 1`
  )
    .bind(providerId)
    .first();

  if (!result) {
    return null;
  }

  return JSON.parse(result.config_json as string) as SAMLIdPConfig;
}

/**
 * Get IdP configuration by Entity ID
 */
export async function getIdPConfigByEntityId(
  env: Env,
  entityId: string
): Promise<SAMLIdPConfig | null> {
  const result = await env.DB.prepare(
    `SELECT config_json FROM identity_providers
     WHERE provider_type = 'saml_idp' AND enabled = 1`
  ).all();

  for (const row of result.results) {
    const config = JSON.parse(row.config_json as string) as SAMLIdPConfig;
    if (config.entityId === entityId) {
      return config;
    }
  }

  return null;
}

/**
 * List all SP configurations
 */
export async function listSPConfigs(
  env: Env
): Promise<Array<{ id: string; name: string; entityId: string }>> {
  const result = await env.DB.prepare(
    `SELECT id, name, config_json FROM identity_providers
     WHERE provider_type = 'saml_sp' AND enabled = 1`
  ).all();

  return result.results.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    entityId: (JSON.parse(row.config_json as string) as SAMLSPConfig).entityId,
  }));
}

/**
 * List all IdP configurations
 */
export async function listIdPConfigs(
  env: Env
): Promise<Array<{ id: string; name: string; entityId: string }>> {
  const result = await env.DB.prepare(
    `SELECT id, name, config_json FROM identity_providers
     WHERE provider_type = 'saml_idp' AND enabled = 1`
  ).all();

  return result.results.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    entityId: (JSON.parse(row.config_json as string) as SAMLIdPConfig).entityId,
  }));
}
