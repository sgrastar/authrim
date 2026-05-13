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
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import type {
  SAMLSPConfig,
  SAMLIdPConfig,
  SAMLProviderCreateRequest,
  SAMLProviderUpdateRequest,
  SAMLProviderResponse,
  MetadataImportRequest,
  SAMLSPProfile,
  SAMLAttributeReleaseRule,
  SAMLMetadataRequestedAttribute,
  SAMLMetadataRefreshStatus,
  SAMLAttributePresetId,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  validateExternalUrl,
  safeFetchText,
  createAuthContextFromHono,
  resolveAuthCorePersistenceAdapterFromEnv,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  createAuditLog,
  hasAdminPermission,
} from '@authrim/ar-lib-core';
import {
  parseXml,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
} from '../common/xml-utils';
import { SAML_NAMESPACES, BINDING_URIS, NAMEID_FORMATS } from '../common/constants';
import { resolveSAMLTenantIdFromContext } from '../common/tenant';
import {
  SAML_BUILTIN_ATTRIBUTE_PRESETS,
  applySAMLAttributePresetToSPConfig,
  normalizeSAMLSPAttributePresetConfig,
} from '../idp/attribute-presets';
import { applySAMLSPProfileDefaults } from './profile-defaults';
import {
  analyzeSAMLMetadata,
  buildSAMLMetadataRefreshStatus,
  type SAMLMetadataAnalysis,
} from './metadata-refresh';
import {
  promoteSAMLNextSigningCertificate,
  publishSAMLNextSigningCertificate,
  retireSAMLBackupSigningCertificate,
} from './signing-rollover';

export class SAMLMetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SAMLMetadataValidationError';
  }
}

type AdminSAMLContext = Context<{ Bindings: Env }>;
type AdminSAMLAuthContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

async function requireSAMLAdminPermission(
  c: AdminSAMLContext,
  permission: string
): Promise<Response | null> {
  const auth = (c as unknown as AdminSAMLAuthContext).get('adminAuth');
  if (!auth) {
    return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }
  if (!hasAdminPermission(auth.permissions || [], permission)) {
    return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  return null;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * List all SAML providers
 */
export async function handleListProviders(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_LIST);
    if (forbidden) {
      return forbidden;
    }
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const providers = await coreAdapter.query<{
      id: string;
      name: string;
      provider_type: string;
      config_json: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, name, provider_type, config_json, enabled, created_at, updated_at
       FROM identity_providers
       WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')
       ORDER BY created_at DESC`,
      [tenantId]
    );

    const response = providers.map((row) => ({
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      config: JSON.parse(row.config_json),
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));

    return c.json({ providers: response });
  } catch (error) {
    log.error('List providers error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * List built-in SAML attribute presets.
 */
export async function handleListAttributePresets(
  c: AdminSAMLContext
): Promise<Response> {
  const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_ATTRIBUTE_PRESETS_READ);
  if (forbidden) {
    return forbidden;
  }

  return c.json({
    presets: SAML_BUILTIN_ATTRIBUTE_PRESETS.map((preset) => ({
      id: preset.id,
      version: preset.version,
      profile: preset.profile,
      label: preset.label,
      description: preset.description,
      stability: preset.stability,
      applicationMode: preset.applicationMode,
      attributeReleasePolicy: {
        attributes: preset.buildRules(),
      },
    })),
  });
}

/**
 * Create new SAML provider
 */
export async function handleCreateProvider(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE);
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as SAMLProviderCreateRequest;

    // Validate request
    if (!body.name || !body.providerType || !body.config) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'name, providerType, config' },
      });
    }

    if (!['saml_idp', 'saml_sp'].includes(body.providerType)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate config based on type
    if (body.providerType === 'saml_idp') {
      const config = body.config as SAMLIdPConfig;
      if (!config.entityId || !config.ssoUrl || !config.certificate) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'entityId, ssoUrl, certificate' },
        });
      }
    } else {
      const config = body.config as SAMLSPConfig;
      if (!config.entityId || !config.acsUrl) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'entityId, acsUrl' },
        });
      }
    }

    const normalizedConfig =
      body.providerType === 'saml_sp'
        ? normalizeSAMLSPAttributePresetConfig(body.config as SAMLSPConfig)
        : body.config;
    const id = crypto.randomUUID();
    const now = Date.now();

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    await coreAdapter.execute(
      `INSERT INTO identity_providers (id, tenant_id, name, provider_type, config_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.name,
        body.providerType,
        JSON.stringify(normalizedConfig),
        body.enabled !== false ? 1 : 0,
        now,
        now,
      ]
    );

    return c.json(
      {
        id,
        name: body.name,
        providerType: body.providerType,
        config: normalizedConfig,
        enabled: body.enabled !== false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      201
    );
  } catch (error) {
    log.error('Create provider error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get provider by ID
 */
export async function handleGetProvider(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_READ);
    if (forbidden) {
      return forbidden;
    }
    if (!id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const provider = await coreAdapter.queryOne<{
      id: string;
      name: string;
      provider_type: string;
      config_json: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, name, provider_type, config_json, enabled, created_at, updated_at
       FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (!provider) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({
      id: provider.id,
      name: provider.name,
      providerType: provider.provider_type,
      config: JSON.parse(provider.config_json),
      enabled: provider.enabled === 1,
      createdAt: new Date(provider.created_at).toISOString(),
      updatedAt: new Date(provider.updated_at).toISOString(),
    });
  } catch (error) {
    log.error('Get provider error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Update provider
 */
export async function handleUpdateProvider(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) {
      return forbidden;
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;

    // Get existing provider
    const existing = await coreAdapter.queryOne<{
      id: string;
      name: string;
      provider_type: string;
      config_json: string;
      enabled: number;
    }>(
      `SELECT id, name, provider_type, config_json, enabled
       FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = (await c.req.json()) as SAMLProviderUpdateRequest;
    const existingConfig = JSON.parse(existing.config_json);

    // Merge config updates
    const mergedConfig = body.config ? { ...existingConfig, ...body.config } : existingConfig;
    const newConfig =
      existing.provider_type === 'saml_sp'
        ? normalizeSAMLSPAttributePresetConfig(mergedConfig as SAMLSPConfig)
        : mergedConfig;
    const now = Date.now();

    await coreAdapter.execute(
      `UPDATE identity_providers
       SET name = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        body.name || existing.name,
        JSON.stringify(newConfig),
        body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
        now,
        id,
        tenantId,
      ]
    );

    return c.json({
      id,
      name: body.name || existing.name,
      providerType: existing.provider_type,
      config: newConfig,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled === 1,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    log.error('Update provider error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Delete provider
 */
export async function handleDeleteProvider(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_DELETE);
    if (forbidden) {
      return forbidden;
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const result = await coreAdapter.execute(
      `DELETE FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (result.rowsAffected === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Delete provider error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Import metadata from XML or URL
 */
export async function handleImportMetadata(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_IMPORT
    );
    if (forbidden) {
      return forbidden;
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;

    // Get existing provider
    const existing = await coreAdapter.queryOne<{
      id: string;
      provider_type: string;
      config_json: string;
    }>(
      `SELECT id, provider_type, config_json
       FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = (await c.req.json()) as MetadataImportRequest;

    let metadataXml: string;

    if (body.metadataXml) {
      metadataXml = body.metadataXml;
    } else if (body.metadataUrl) {
      // SSRF protection: Validate URL before fetching
      const ssrfError = validateExternalUrl(body.metadataUrl, {
        requireHttps: true,
        allowLocalhost: false,
        errorType: 'invalid_request',
        fieldName: 'metadataUrl',
      });
      if (ssrfError) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      try {
        metadataXml = await safeFetchText(body.metadataUrl, {
          timeoutMs: 10000,
          maxResponseSize: 1024 * 1024,
        });
      } catch {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'metadataXml or metadataUrl' },
      });
    }

    const metadataUrl = body.metadataUrl || undefined;
    const existingConfig = JSON.parse(existing.config_json) as SAMLIdPConfig | SAMLSPConfig;
    const previousAnalysis = buildPreviousMetadataAnalysis(existingConfig);
    const currentAnalysis = analyzeSAMLMetadata(metadataXml);
    const refreshStatus = buildSAMLMetadataRefreshStatus(previousAnalysis, currentAnalysis);
    const newConfig = buildConfigFromMetadata(
      existing.provider_type,
      metadataXml,
      body.samlProfile,
      body.attributePresetId
    );

    // Merge with existing config (preserve custom settings)
    const mergedConfig = {
      ...existingConfig,
      ...newConfig,
      metadataXml,
      ...(metadataUrl ? { metadataUrl } : {}),
      metadataHash: currentAnalysis.hash,
      metadataCriticalFields: currentAnalysis.criticalFields,
      metadataRefreshStatus: refreshStatus,
      metadataLastFetched: Date.now(),
    };

    const now = Date.now();

    await coreAdapter.execute(
      'UPDATE identity_providers SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(mergedConfig), now, id, tenantId]
    );

    return c.json({
      success: true,
      config: mergedConfig,
      metadataRefreshStatus: refreshStatus,
    });
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      log.warn('Import metadata validation failed', { providerId: id }, error);
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    log.error('Import metadata error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Refresh metadata from configured metadata URL.
 */
export async function handleRefreshMetadata(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH
    );
    if (forbidden) {
      return forbidden;
    }
    if (!id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const existing = await coreAdapter.queryOne<{
      id: string;
      provider_type: string;
      config_json: string;
    }>(
      `SELECT id, provider_type, config_json
       FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await readOptionalJson(c);
    const existingConfig = JSON.parse(existing.config_json) as SAMLIdPConfig | SAMLSPConfig;
    const metadataUrl = body.metadataUrl || existingConfig.metadataUrl;
    if (!metadataUrl) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'metadataUrl' },
      });
    }

    const ssrfError = validateExternalUrl(metadataUrl, {
      requireHttps: true,
      allowLocalhost: false,
      errorType: 'invalid_request',
      fieldName: 'metadataUrl',
    });
    if (ssrfError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    let metadataXml: string;
    try {
      metadataXml = await safeFetchText(metadataUrl, {
        timeoutMs: 10000,
        maxResponseSize: 1024 * 1024,
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const previousAnalysis = buildPreviousMetadataAnalysis(existingConfig);
    const currentAnalysis = analyzeSAMLMetadata(metadataXml);
    const refreshStatus = buildSAMLMetadataRefreshStatus(previousAnalysis, currentAnalysis);
    const now = Date.now();

    if (refreshStatus.diff.expired) {
      const expiredConfig = {
        ...existingConfig,
        metadataXml,
        metadataUrl,
        metadataHash: currentAnalysis.hash,
        metadataCriticalFields: currentAnalysis.criticalFields,
        metadataRefreshStatus: refreshStatus,
        metadataLastFetched: now,
      };

      await coreAdapter.execute(
        'UPDATE identity_providers SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        [JSON.stringify(expiredConfig), now, id, tenantId]
      );

      await createSAMLMetadataRefreshAudit(c, {
        tenantId,
        providerId: id,
        providerType: existing.provider_type,
        refreshStatus,
      });

      return c.json({
        success: true,
        changed: refreshStatus.diff.changed,
        expired: true,
        config: expiredConfig,
        metadataRefreshStatus: refreshStatus,
      });
    }

    const profile =
      existing.provider_type === 'saml_sp'
        ? (existingConfig as SAMLSPConfig).samlProfile
        : undefined;
    const refreshedConfig = buildConfigFromMetadata(existing.provider_type, metadataXml, profile);
    const mergedConfig = {
      ...existingConfig,
      ...refreshedConfig,
      metadataXml,
      metadataUrl,
      metadataHash: currentAnalysis.hash,
      metadataCriticalFields: currentAnalysis.criticalFields,
      metadataRefreshStatus: refreshStatus,
      metadataLastFetched: now,
    };

    await coreAdapter.execute(
      'UPDATE identity_providers SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(mergedConfig), now, id, tenantId]
    );

    await createSAMLMetadataRefreshAudit(c, {
      tenantId,
      providerId: id,
      providerType: existing.provider_type,
      refreshStatus,
    });

    return c.json({
      success: true,
      changed: refreshStatus.diff.changed,
      config: mergedConfig,
      metadataRefreshStatus: refreshStatus,
    });
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      log.warn('Refresh metadata validation failed', { providerId: id }, error);
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    log.error('Refresh metadata error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handlePublishSigningNext(c: AdminSAMLContext): Promise<Response> {
  return updateProviderSigningPolicy(
    c,
    (input) =>
      publishSAMLNextSigningCertificate(input.policy, {
        tenantId: input.tenantId,
        role: input.role,
        counterpartyEntityId: input.config.entityId,
        keyRef: input.body.keyRef,
        kid: input.body.kid,
        certificate: input.body.certificate,
        metadataPublishFrom: input.body.metadataPublishFrom,
        plannedActivationAt: input.body.plannedActivationAt,
        metadataCertificatePublication: input.body.metadataCertificatePublication,
      }),
    {
      permission: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_PUBLISH_NEXT,
      requireCertificate: true,
    }
  );
}

export async function handlePromoteSigningNext(c: AdminSAMLContext): Promise<Response> {
  return updateProviderSigningPolicy(
    c,
    (input) =>
      promoteSAMLNextSigningCertificate(input.policy, {
        tenantId: input.tenantId,
        role: input.role,
        counterpartyEntityId: input.config.entityId,
        promotedAt: input.body.promotedAt,
        keepPreviousAsBackup: input.body.keepPreviousAsBackup,
      }),
    { permission: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_PROMOTE }
  );
}

export async function handleRetireSigningBackup(c: AdminSAMLContext): Promise<Response> {
  return updateProviderSigningPolicy(
    c,
    (input) => retireSAMLBackupSigningCertificate(input.policy),
    { permission: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_RETIRE_BACKUP }
  );
}

interface SigningRolloverRequestBody {
  keyRef?: string;
  kid?: string;
  certificate: string;
  metadataPublishFrom?: number;
  plannedActivationAt?: number;
  metadataCertificatePublication?: 'active_next' | 'active_next_backup';
  promotedAt?: number;
  keepPreviousAsBackup?: boolean;
}

async function updateProviderSigningPolicy(
  c: AdminSAMLContext,
  updatePolicy: (input: {
    tenantId: string;
    role: 'idp' | 'sp';
    config: SAMLIdPConfig | SAMLSPConfig;
    policy: NonNullable<(SAMLIdPConfig | SAMLSPConfig)['signingKeyPolicy']>;
    body: SigningRolloverRequestBody;
  }) => NonNullable<(SAMLIdPConfig | SAMLSPConfig)['signingKeyPolicy']>,
  options: { permission: string; requireCertificate?: boolean }
): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, options.permission);
    if (forbidden) {
      return forbidden;
    }
    if (!id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const existing = await coreAdapter.queryOne<{
      id: string;
      provider_type: string;
      config_json: string;
    }>(
      `SELECT id, provider_type, config_json
       FROM identity_providers
       WHERE id = ? AND tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [id, tenantId]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = (await c.req.json()) as SigningRolloverRequestBody;
    if (options.requireCertificate && !body.certificate) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'certificate' },
      });
    }

    const config = JSON.parse(existing.config_json) as SAMLIdPConfig | SAMLSPConfig;
    const role = existing.provider_type === 'saml_sp' ? 'idp' : 'sp';
    const signingKeyPolicy = updatePolicy({
      tenantId,
      role,
      config,
      policy: config.signingKeyPolicy ?? {},
      body,
    });
    const updatedConfig = {
      ...config,
      signingKeyPolicy,
    };
    const now = Date.now();

    await coreAdapter.execute(
      'UPDATE identity_providers SET config_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(updatedConfig), now, id, tenantId]
    );

    return c.json({
      success: true,
      config: updatedConfig,
      signingKeyPolicy,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    log.error('Update SAML signing policy error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function buildConfigFromMetadata(
  providerType: string,
  metadataXml: string,
  profile?: SAMLSPProfile,
  attributePresetId?: SAMLAttributePresetId
): SAMLIdPConfig | SAMLSPConfig {
  if (providerType === 'saml_idp') {
    return parseIdPMetadata(metadataXml);
  }

  const profiledConfig = applySAMLSPProfileDefaults(parseSPMetadata(metadataXml, profile), profile);
  return attributePresetId
    ? applySAMLAttributePresetToSPConfig(profiledConfig, attributePresetId)
    : normalizeSAMLSPAttributePresetConfig(profiledConfig);
}

function buildPreviousMetadataAnalysis(
  config: SAMLIdPConfig | SAMLSPConfig
): SAMLMetadataAnalysis | undefined {
  if (!config.metadataHash || !config.metadataCriticalFields) {
    return undefined;
  }

  return {
    hash: config.metadataHash,
    criticalFields: config.metadataCriticalFields,
  };
}

async function readOptionalJson(c: Context<{ Bindings: Env }>): Promise<{ metadataUrl?: string }> {
  const contentType = c.req.header('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return {};
  }

  return ((await c.req.json()) as { metadataUrl?: string }) ?? {};
}

async function createSAMLMetadataRefreshAudit(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    providerId: string;
    providerType: string;
    refreshStatus: SAMLMetadataRefreshStatus;
  }
): Promise<void> {
  await createAuditLog(c.env, {
    tenantId: input.tenantId,
    userId: 'saml-admin',
    action: 'saml.metadata.refreshed',
    resource: input.providerType,
    resourceId: input.providerId,
    ipAddress: getRequestIp(c),
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata: JSON.stringify({
      protocol: 'saml',
      provider_type: input.providerType,
      changed: input.refreshStatus.diff.changed,
      expired: input.refreshStatus.diff.expired,
      previous_hash: input.refreshStatus.previousHash,
      current_hash: input.refreshStatus.currentHash,
      valid_until: input.refreshStatus.diff.validUntil,
      expires_in_seconds: input.refreshStatus.diff.expiresInSeconds,
      entity_id_changed: input.refreshStatus.diff.entityIdChanged,
      valid_until_changed: input.refreshStatus.diff.validUntilChanged,
      certificates_added: input.refreshStatus.diff.certificatesAdded.length,
      certificates_removed: input.refreshStatus.diff.certificatesRemoved.length,
      endpoints_added: input.refreshStatus.diff.endpointsAdded.length,
      endpoints_removed: input.refreshStatus.diff.endpointsRemoved.length,
    }),
    severity:
      input.refreshStatus.diff.changed || input.refreshStatus.diff.expired ? 'warning' : 'info',
  });
}

function getRequestIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse IdP metadata XML
 */
export function parseIdPMetadata(xml: string): SAMLIdPConfig {
  const doc = parseXml(xml);

  // Find IDPSSODescriptor
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new Error('Invalid metadata: missing EntityDescriptor');
  }
  assertMetadataIsCurrent(entityDescriptor);

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
export function parseSPMetadata(xml: string, profile?: SAMLSPProfile): SAMLSPConfig {
  const doc = parseXml(xml);

  // Find SPSSODescriptor
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new Error('Invalid metadata: missing EntityDescriptor');
  }
  assertMetadataIsCurrent(entityDescriptor);

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
  const allowedBindings = new Set<SAMLSPConfig['allowedBindings'][number]>();
  const acsUrls: string[] = [];
  const indexedAcsServices: NonNullable<SAMLSPConfig['acsServices']> = [];

  for (const acs of acsServices) {
    const binding = getAttribute(acs, 'Binding');
    const location = getAttribute(acs, 'Location');
    const isDefault = getAttribute(acs, 'isDefault');
    const index = parseOptionalNonNegativeInteger(getAttribute(acs, 'index'));

    if (binding === BINDING_URIS.HTTP_POST) {
      if (location) {
        acsUrls.push(location);
        if (index !== null) {
          indexedAcsServices.push({
            index,
            binding: 'post',
            location,
            isDefault: isDefault === 'true',
          });
        }
      }
      if (!acsUrl || isDefault === 'true') {
        acsUrl = location || '';
      }
      allowedBindings.add('post');
    } else if (binding === BINDING_URIS.HTTP_REDIRECT) {
      if (location) {
        acsUrls.push(location);
        if (index !== null) {
          indexedAcsServices.push({
            index,
            binding: 'redirect',
            location,
            isDefault: isDefault === 'true',
          });
        }
      }
      if (!acsUrl) {
        acsUrl = location || '';
      }
      allowedBindings.add('redirect');
    }
  }

  if (!acsUrl) {
    throw new Error('Invalid metadata: no supported ACS binding found');
  }

  // Get SLO URL (optional)
  const sloServices = findElements(spDescriptor, SAML_NAMESPACES.MD, 'SingleLogoutService');
  const selectedSloService = selectSPMetadataSLOService(sloServices, profile);

  // Get signing/encryption certificates (optional for SP)
  const certificates: string[] = [];
  const encryptionCertificates: string[] = [];
  const keyDescriptors = findElements(spDescriptor, SAML_NAMESPACES.MD, 'KeyDescriptor');

  for (const kd of keyDescriptors) {
    const use = getAttribute(kd, 'use');
    const x509Cert = findElement(kd, SAML_NAMESPACES.DS, 'X509Certificate');
    if (!x509Cert) {
      continue;
    }

    const certText = getTextContent(x509Cert)?.replace(/\s+/g, '') || '';
    if (!certText) {
      continue;
    }

    const certificate = `-----BEGIN CERTIFICATE-----\n${certText}\n-----END CERTIFICATE-----`;
    if (use === 'signing' || !use) {
      certificates.push(certificate);
    }
    if (use === 'encryption' || !use) {
      encryptionCertificates.push(certificate);
    }
  }
  const deduplicatedCertificates = Array.from(new Set(certificates));
  const deduplicatedEncryptionCertificates = Array.from(new Set(encryptionCertificates));

  // Get NameID formats
  const nameIdFormats = findElements(spDescriptor, SAML_NAMESPACES.MD, 'NameIDFormat');
  const nameIdFormat =
    nameIdFormats.length > 0
      ? (getTextContent(nameIdFormats[0]) as SAMLSPConfig['nameIdFormat']) || NAMEID_FORMATS.EMAIL
      : NAMEID_FORMATS.EMAIL;
  const metadataRequestedAttributes = parseSPMetadataRequestedAttributes(spDescriptor);
  const metadataAttributeReleasePolicySuggestion = buildAttributeReleasePolicySuggestion(
    metadataRequestedAttributes
  );

  // Check if assertions should be signed
  const authnRequestsSigned = getAttribute(spDescriptor, 'AuthnRequestsSigned') === 'true';
  const wantAssertionsSigned = getAttribute(spDescriptor, 'WantAssertionsSigned') === 'true';

  return {
    entityId,
    acsUrl,
    acsUrls: Array.from(new Set(acsUrls)),
    acsServices: deduplicateAcsServices(indexedAcsServices),
    sloUrl: selectedSloService?.location,
    sloResponseUrl: selectedSloService?.responseLocation,
    sloBinding: selectedSloService?.binding,
    certificate: deduplicatedCertificates[0],
    certificates: deduplicatedCertificates.length > 0 ? deduplicatedCertificates : undefined,
    encryptionCertificate: deduplicatedEncryptionCertificates[0],
    encryptionCertificates:
      deduplicatedEncryptionCertificates.length > 0
        ? deduplicatedEncryptionCertificates
        : undefined,
    authnRequestSignaturePolicy: authnRequestsSigned ? 'required' : 'optional',
    nameIdFormat,
    attributeMapping: {},
    metadataRequestedAttributes:
      metadataRequestedAttributes.length > 0 ? metadataRequestedAttributes : undefined,
    metadataAttributeReleasePolicySuggestion,
    signAssertions: wantAssertionsSigned,
    signResponses: true,
    allowedBindings: Array.from(allowedBindings),
  };
}

function parseSPMetadataRequestedAttributes(
  spDescriptor: Element
): SAMLMetadataRequestedAttribute[] {
  const services = findElements(spDescriptor, SAML_NAMESPACES.MD, 'AttributeConsumingService');
  const requestedAttributes: SAMLMetadataRequestedAttribute[] = [];

  for (const service of services) {
    const serviceIndex = parseOptionalNonNegativeInteger(getAttribute(service, 'index'));
    const serviceName = findElement(service, SAML_NAMESPACES.MD, 'ServiceName');
    const requested = findElements(service, SAML_NAMESPACES.MD, 'RequestedAttribute');

    for (const attribute of requested) {
      const name = getAttribute(attribute, 'Name');
      if (!name) {
        continue;
      }

      requestedAttributes.push({
        name,
        nameFormat: getOptionalAttribute(attribute, 'NameFormat'),
        friendlyName: getOptionalAttribute(attribute, 'FriendlyName'),
        isRequired: getAttribute(attribute, 'isRequired') === 'true',
        attributeConsumingServiceIndex: serviceIndex ?? undefined,
        attributeConsumingServiceName: serviceName
          ? getTextContent(serviceName) || undefined
          : undefined,
      });
    }
  }

  return requestedAttributes;
}

function buildAttributeReleasePolicySuggestion(
  requestedAttributes: SAMLMetadataRequestedAttribute[]
): SAMLSPConfig['metadataAttributeReleasePolicySuggestion'] {
  if (requestedAttributes.length === 0) {
    return undefined;
  }

  const knownRules = buildKnownAttributeReleaseRuleIndex();
  const rules = new Map<string, SAMLAttributeReleaseRule>();

  for (const requestedAttribute of requestedAttributes) {
    const key = buildRequestedAttributeKey(requestedAttribute);
    const existing = rules.get(key);
    const rule = existing ?? buildSuggestedAttributeReleaseRule(requestedAttribute, knownRules);
    rule.required = Boolean(rule.required || requestedAttribute.isRequired);
    rules.set(key, rule);
  }

  return { attributes: Array.from(rules.values()) };
}

function buildKnownAttributeReleaseRuleIndex(): Map<string, SAMLAttributeReleaseRule> {
  const rules = new Map<string, SAMLAttributeReleaseRule>();

  for (const preset of SAML_BUILTIN_ATTRIBUTE_PRESETS) {
    for (const rule of preset.buildRules()) {
      rules.set(normalizeAttributeLookupKey(rule.name), { ...rule });
      if (rule.friendlyName) {
        rules.set(normalizeAttributeLookupKey(rule.friendlyName), { ...rule });
      }
    }
  }

  return rules;
}

function buildSuggestedAttributeReleaseRule(
  requestedAttribute: SAMLMetadataRequestedAttribute,
  knownRules: Map<string, SAMLAttributeReleaseRule>
): SAMLAttributeReleaseRule {
  const knownRule =
    knownRules.get(normalizeAttributeLookupKey(requestedAttribute.name)) ??
    (requestedAttribute.friendlyName
      ? knownRules.get(normalizeAttributeLookupKey(requestedAttribute.friendlyName))
      : undefined);

  if (knownRule) {
    return {
      ...knownRule,
      name: requestedAttribute.name,
      nameFormat: requestedAttribute.nameFormat ?? knownRule.nameFormat,
      friendlyName: requestedAttribute.friendlyName ?? knownRule.friendlyName,
      required: requestedAttribute.isRequired,
    };
  }

  return {
    name: requestedAttribute.name,
    nameFormat: requestedAttribute.nameFormat,
    friendlyName: requestedAttribute.friendlyName,
    source: 'custom_claim',
    claim: buildClaimNameFromRequestedAttribute(requestedAttribute),
    required: requestedAttribute.isRequired,
  };
}

function buildRequestedAttributeKey(attribute: SAMLMetadataRequestedAttribute): string {
  return `${attribute.nameFormat ?? ''}\u0000${attribute.name}`;
}

function normalizeAttributeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildClaimNameFromRequestedAttribute(attribute: SAMLMetadataRequestedAttribute): string {
  const nameSegments = attribute.name.split(':');
  const raw = attribute.friendlyName || nameSegments[nameSegments.length - 1] || attribute.name;
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'samlAttribute';
}

function getOptionalAttribute(element: Element, name: string): string | undefined {
  return getAttribute(element, name) || undefined;
}

function parseOptionalNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function deduplicateAcsServices(
  services: NonNullable<SAMLSPConfig['acsServices']>
): NonNullable<SAMLSPConfig['acsServices']> {
  const byIndex = new Map<number, NonNullable<SAMLSPConfig['acsServices']>[number]>();
  for (const service of services) {
    if (!byIndex.has(service.index) || service.isDefault) {
      byIndex.set(service.index, service);
    }
  }

  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

function selectSPMetadataSLOService(
  sloServices: Element[],
  profile: SAMLSPProfile | undefined
):
  | {
      binding: Extract<SAMLSPConfig['allowedBindings'][number], 'post' | 'redirect'>;
      location: string;
      responseLocation?: string;
    }
  | undefined {
  const supportedServices = sloServices
    .map((service) => ({
      binding: getAttribute(service, 'Binding'),
      location: getAttribute(service, 'Location') || undefined,
      responseLocation: getAttribute(service, 'ResponseLocation') || undefined,
    }))
    .filter(
      (
        service
      ): service is {
        binding: typeof BINDING_URIS.HTTP_POST | typeof BINDING_URIS.HTTP_REDIRECT;
        location: string;
        responseLocation: string | undefined;
      } =>
        Boolean(service.location) &&
        (service.binding === BINDING_URIS.HTTP_POST ||
          service.binding === BINDING_URIS.HTTP_REDIRECT)
    )
    .map((service) => ({
      binding:
        service.binding === BINDING_URIS.HTTP_POST ? ('post' as const) : ('redirect' as const),
      location: service.location,
      responseLocation: service.responseLocation,
      metadataBinding: service.binding,
    }));

  const preferredBinding =
    profile === 'legacy' ? BINDING_URIS.HTTP_POST : BINDING_URIS.HTTP_REDIRECT;
  const fallbackBinding =
    preferredBinding === BINDING_URIS.HTTP_POST
      ? BINDING_URIS.HTTP_REDIRECT
      : BINDING_URIS.HTTP_POST;

  return (
    supportedServices.find((service) => service.metadataBinding === preferredBinding) ??
    supportedServices.find((service) => service.metadataBinding === fallbackBinding)
  );
}

function assertMetadataIsCurrent(entityDescriptor: Element, now = Date.now()): void {
  const validUntil = getAttribute(entityDescriptor, 'validUntil');
  if (!validUntil) {
    return;
  }

  const expiresAt = Date.parse(validUntil);
  if (!Number.isFinite(expiresAt)) {
    throw new SAMLMetadataValidationError('Invalid metadata: invalid validUntil');
  }

  if (expiresAt <= now) {
    throw new SAMLMetadataValidationError('Invalid metadata: expired validUntil');
  }
}

// ============================================================================
// Public Helper Functions (used by other modules)
// ============================================================================

async function resolveSAMLProvidersCoreAdapter(env: Env) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-providers');
}

/**
 * Get SP configuration by Entity ID
 */
export async function getSPConfig(
  env: Env,
  tenantId: string,
  entityId: string
): Promise<SAMLSPConfig | null> {
  const coreAdapter = await resolveSAMLProvidersCoreAdapter(env);
  const result = await coreAdapter.query<{ config_json: string }>(
    `SELECT config_json FROM identity_providers
     WHERE tenant_id = ? AND provider_type = 'saml_sp' AND enabled = 1`,
    [tenantId]
  );

  for (const row of result) {
    const config = JSON.parse(row.config_json) as SAMLSPConfig;
    if (config.entityId === entityId) {
      return config;
    }
  }

  return null;
}

/**
 * Get IdP configuration by provider ID
 */
export async function getIdPConfig(
  env: Env,
  tenantId: string,
  providerId: string
): Promise<SAMLIdPConfig | null> {
  const coreAdapter = await resolveSAMLProvidersCoreAdapter(env);
  const result = await coreAdapter.queryOne<{ config_json: string }>(
    `SELECT config_json FROM identity_providers
     WHERE id = ? AND tenant_id = ? AND provider_type = 'saml_idp' AND enabled = 1`,
    [providerId, tenantId]
  );

  if (!result) {
    return null;
  }

  return JSON.parse(result.config_json) as SAMLIdPConfig;
}

/**
 * Get IdP configuration by Entity ID
 */
export async function getIdPConfigByEntityId(
  env: Env,
  tenantId: string,
  entityId: string
): Promise<SAMLIdPConfig | null> {
  const coreAdapter = await resolveSAMLProvidersCoreAdapter(env);
  const result = await coreAdapter.query<{ config_json: string }>(
    `SELECT config_json FROM identity_providers
     WHERE tenant_id = ? AND provider_type = 'saml_idp' AND enabled = 1`,
    [tenantId]
  );

  for (const row of result) {
    const config = JSON.parse(row.config_json) as SAMLIdPConfig;
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
  env: Env,
  tenantId: string
): Promise<Array<{ id: string; name: string; entityId: string }>> {
  const coreAdapter = await resolveSAMLProvidersCoreAdapter(env);
  const result = await coreAdapter.query<{
    id: string;
    name: string;
    config_json: string;
  }>(
    `SELECT id, name, config_json FROM identity_providers
     WHERE tenant_id = ? AND provider_type = 'saml_sp' AND enabled = 1`,
    [tenantId]
  );

  return result.map((row) => ({
    id: row.id,
    name: row.name,
    entityId: (JSON.parse(row.config_json) as SAMLSPConfig).entityId,
  }));
}

/**
 * List all IdP configurations
 */
export async function listIdPConfigs(
  env: Env,
  tenantId: string
): Promise<Array<{ id: string; name: string; entityId: string }>> {
  const coreAdapter = await resolveSAMLProvidersCoreAdapter(env);
  const result = await coreAdapter.query<{
    id: string;
    name: string;
    config_json: string;
  }>(
    `SELECT id, name, config_json FROM identity_providers
     WHERE tenant_id = ? AND provider_type = 'saml_idp' AND enabled = 1`,
    [tenantId]
  );

  return result.map((row) => ({
    id: row.id,
    name: row.name,
    entityId: (JSON.parse(row.config_json) as SAMLIdPConfig).entityId,
  }));
}
