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
  SAMLFederationTrustProfile,
  SAMLMetadataBatchCreateResult,
  SAMLMetadataBatchStatusResponse,
  SAMLMetadataEntityListResponse,
  SAMLMetadataVerificationSummary,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  validateExternalUrl,
  safeFetchText,
  createAuthContextFromHono,
  resolveAuthCorePersistenceAdapterFromEnv,
  requireDedicatedAdminDatabaseAdapter,
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
import { SAMLMetadataValidationError } from './errors';
import { applySAMLSPProfileDefaults } from './profile-defaults';
import {
  analyzeSAMLMetadata,
  buildSAMLMetadataRefreshStatus,
  type SAMLMetadataAnalysis,
} from './metadata-refresh';
import {
  AGGREGATE_METADATA_FETCH_LIMIT_BYTES,
  SINGLE_METADATA_FETCH_LIMIT_BYTES,
  extractEntityDescriptorXml,
  fingerprintCertificateSha256,
  getLogoUrl,
  isAggregateMetadata,
  parseAggregateMetadata,
  resolveAggregateSignaturePolicy,
  verifyAggregateMetadataSignature,
} from './aggregate-metadata';
import {
  promoteSAMLNextSigningCertificate,
  publishSAMLNextSigningCertificate,
  retireSAMLBackupSigningCertificate,
} from './signing-rollover';

type AdminSAMLContext = Context<{ Bindings: Env }>;
type AdminSAMLAuthContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;
interface SAMLMetadataConfigFields {
  metadataXml?: string;
  metadataUrl?: string;
  metadataHash?: string;
  metadataCriticalFields?: SAMLMetadataAnalysis['criticalFields'];
  metadataRefreshStatus?: SAMLMetadataRefreshStatus;
  metadataLastFetched?: number;
}

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
export async function handleListAttributePresets(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');
  const forbidden = await requireSAMLAdminPermission(
    c,
    ADMIN_PERMISSIONS.SAML_ATTRIBUTE_PRESETS_READ
  );
  if (forbidden) {
    return forbidden;
  }

  const tenantId = resolveSAMLTenantIdFromContext(c);
  const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  let customPresets: SAMLAttributePresetResponse[] = [];

  try {
    const rows = await coreAdapter.query<{
      id: string;
      label: string;
      description: string | null;
      applies_to: string;
      profile: string;
      stability: string;
      application_mode: string;
      attribute_release_policy_json: string;
      updated_at: number;
    }>(
      `SELECT id, label, description, applies_to, profile, stability, application_mode,
              attribute_release_policy_json, updated_at
       FROM saml_attribute_presets
       WHERE tenant_id = ? AND applies_to = 'sp_attribute_release'
       ORDER BY created_at DESC`,
      [tenantId]
    );
    customPresets = rows.map((row) => ({
      id: row.id,
      version: `custom:${row.updated_at}`,
      profile: row.profile,
      label: row.label,
      description: row.description || '',
      appliesTo: 'sp_attribute_release',
      stability: row.stability,
      applicationMode: row.application_mode,
      isCustom: true,
      attributeReleasePolicy: JSON.parse(row.attribute_release_policy_json),
    }));
  } catch (error) {
    log.warn('Custom SAML attribute preset table unavailable', {}, error as Error);
  }

  return c.json({
    presets: [...serializeBuiltinAttributePresets(), ...customPresets],
  });
}

interface SAMLMetadataPreviewRequest extends MetadataImportRequest {
  samlProfile?: SAMLSPProfile;
  attributePresetId?: SAMLAttributePresetId;
}

interface SAMLFederationTrustProfileRequest {
  name?: string;
  description?: string;
  metadataUrlPatterns?: string[];
  certificates?: Array<{ id?: string; name?: string; certificate: string }>;
  policy?: 'strict' | 'warn' | 'disabled';
  enabled?: boolean;
}

interface SAMLMetadataBatchCreateRequest {
  entityIds?: string[];
  providerType?: 'saml_idp' | 'saml_sp';
  samlProfile?: SAMLSPProfile;
  attributePresetId?: SAMLAttributePresetId;
  enabled?: boolean;
}

export async function handlePreviewMetadata(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE);
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as SAMLMetadataPreviewRequest;
    const resolvedMetadata = await resolveMetadataImportInput(c, body, {
      maxResponseSize: AGGREGATE_METADATA_FETCH_LIMIT_BYTES,
    });
    if (resolvedMetadata instanceof Response) {
      return resolvedMetadata;
    }

    if (metadataIsAggregateOrThrow(resolvedMetadata.metadataXml)) {
      const tenantId = resolveSAMLTenantIdFromContext(c);
      const aggregate = parseAggregateMetadata(resolvedMetadata.metadataXml);
      const policy = resolveAggregateSignaturePolicy(c.env);
      const trustProfiles = await listFederationTrustProfiles(c.env, tenantId);
      const verification = verifyAggregateMetadataSignature(
        resolvedMetadata.metadataXml,
        resolvedMetadata.metadataUrl,
        trustProfiles,
        policy
      );
      const previewId = crypto.randomUUID();
      const preview = await storeAggregatePreview(c.env, {
        previewId,
        tenantId,
        metadataXml: resolvedMetadata.metadataXml,
        metadataUrl: resolvedMetadata.metadataUrl,
        entities: aggregate.entities,
        verification,
      });

      return c.json({
        kind: 'aggregate',
        previewId,
        metadataUrl: resolvedMetadata.metadataUrl,
        entityCount: aggregate.entities.length,
        expiresAt: preview.expiresAt,
        verification,
      });
    }

    let providerType: 'saml_idp' | 'saml_sp';
    let config: SAMLIdPConfig | SAMLSPConfig;
    try {
      providerType = detectSAMLMetadataProviderType(resolvedMetadata.metadataXml);
      config = buildConfigFromMetadata(
        providerType,
        resolvedMetadata.metadataXml,
        body.samlProfile,
        body.attributePresetId
      );
    } catch (error) {
      throw toSAMLMetadataValidationError(error);
    }
    const metadataAnalysis = analyzeSAMLMetadata(resolvedMetadata.metadataXml);

    return c.json({
      kind: 'single',
      providerType,
      config: {
        ...config,
        metadataXml: resolvedMetadata.metadataXml,
        ...(resolvedMetadata.metadataUrl ? { metadataUrl: resolvedMetadata.metadataUrl } : {}),
        metadataHash: metadataAnalysis.hash,
        metadataCriticalFields: metadataAnalysis.criticalFields,
        metadataRefreshStatus: buildSAMLMetadataRefreshStatus(undefined, metadataAnalysis),
        metadataLastFetched: Date.now(),
      },
    });
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      log.warn('Preview metadata validation failed', {}, error);
      return createSAMLMetadataValidationErrorResponse(c, error);
    }

    log.error('Preview metadata error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

interface SAMLAttributePresetResponse {
  id: string;
  version: string;
  profile: string;
  label: string;
  description: string;
  stability: string;
  applicationMode: string;
  appliesTo: 'sp_attribute_release';
  isCustom?: boolean;
  attributeReleasePolicy: {
    attributes: SAMLAttributeReleaseRule[];
  };
}

interface SAMLAttributePresetCreateRequest {
  label?: string;
  description?: string;
  profile?: string;
  appliesTo?: 'sp_attribute_release';
  attributeReleasePolicy?: {
    attributes?: SAMLAttributeReleaseRule[];
  };
}

function serializeBuiltinAttributePresets(): SAMLAttributePresetResponse[] {
  return SAML_BUILTIN_ATTRIBUTE_PRESETS.map((preset) => ({
    id: preset.id,
    version: preset.version,
    profile: preset.profile,
    label: preset.label,
    description: preset.description,
    stability: preset.stability,
    applicationMode: preset.applicationMode,
    appliesTo: 'sp_attribute_release',
    isCustom: false,
    attributeReleasePolicy: {
      attributes: preset.buildRules(),
    },
  }));
}

export async function handleCreateAttributePreset(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_ATTRIBUTE_PRESETS_WRITE
    );
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as SAMLAttributePresetCreateRequest;
    const attributes = body.attributeReleasePolicy?.attributes ?? [];
    if (!body.label || attributes.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'label, attributeReleasePolicy.attributes' },
      });
    }

    const invalidRule = attributes.find((rule) => !rule.name || !rule.source);
    if (invalidRule) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const now = Date.now();
    const id = `custom:${crypto.randomUUID()}`;
    const preset: SAMLAttributePresetResponse = {
      id,
      version: `custom:${now}`,
      profile: body.profile || 'custom',
      label: body.label.trim(),
      description: body.description?.trim() || '',
      stability: 'custom',
      applicationMode: 'clone_edit',
      appliesTo: 'sp_attribute_release',
      isCustom: true,
      attributeReleasePolicy: {
        attributes,
      },
    };

    await coreAdapter.execute(
      `INSERT INTO saml_attribute_presets (
         id, tenant_id, label, description, applies_to, profile, stability, application_mode,
         attribute_release_policy_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        preset.label,
        preset.description,
        preset.appliesTo,
        preset.profile,
        preset.stability,
        preset.applicationMode,
        JSON.stringify(preset.attributeReleasePolicy),
        now,
        now,
      ]
    );

    return c.json({ preset }, 201);
  } catch (error) {
    log.error('Create SAML attribute preset error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleDeleteAttributePreset(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_ATTRIBUTE_PRESETS_DELETE
    );
    if (forbidden) {
      return forbidden;
    }

    if (!id?.startsWith('custom:')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const result = await coreAdapter.execute(
      'DELETE FROM saml_attribute_presets WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (result.rowsAffected === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Delete SAML attribute preset error', { presetId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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

    const hasMetadataInput = Boolean(body.metadataXml || body.metadataUrl);

    // Validate request
    if (!body.name || !body.providerType || (!body.config && !hasMetadataInput)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'name, providerType, config or metadata' },
      });
    }

    if (!['saml_idp', 'saml_sp'].includes(body.providerType)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    let metadataDerivedConfig: SAMLIdPConfig | SAMLSPConfig | undefined;
    let metadataDerivedFields: SAMLMetadataConfigFields | undefined;

    if (hasMetadataInput) {
      const resolvedMetadata = await resolveMetadataImportInput(c, body, {
        maxResponseSize: SINGLE_METADATA_FETCH_LIMIT_BYTES,
      });
      if (resolvedMetadata instanceof Response) {
        return resolvedMetadata;
      }
      if (metadataIsAggregateOrThrow(resolvedMetadata.metadataXml)) {
        throw new SAMLMetadataValidationError(
          'Aggregate metadata must be previewed first and imported by selecting EntityDescriptor entries.'
        );
      }

      try {
        metadataDerivedConfig = buildConfigFromMetadata(
          body.providerType,
          resolvedMetadata.metadataXml,
          body.samlProfile,
          body.attributePresetId
        );
      } catch (error) {
        throw new SAMLMetadataValidationError(
          error instanceof Error ? error.message : 'Invalid SAML metadata'
        );
      }

      const metadataAnalysis = analyzeSAMLMetadata(resolvedMetadata.metadataXml);
      metadataDerivedFields = {
        metadataXml: resolvedMetadata.metadataXml,
        ...(resolvedMetadata.metadataUrl ? { metadataUrl: resolvedMetadata.metadataUrl } : {}),
        metadataHash: metadataAnalysis.hash,
        metadataCriticalFields: metadataAnalysis.criticalFields,
        metadataRefreshStatus: buildSAMLMetadataRefreshStatus(undefined, metadataAnalysis),
        metadataLastFetched: Date.now(),
      };
    }

    const config = {
      ...(metadataDerivedConfig ?? {}),
      ...(body.config ?? {}),
      ...(metadataDerivedFields ?? {}),
    } as SAMLIdPConfig | SAMLSPConfig;

    // Validate config based on type
    if (body.providerType === 'saml_idp') {
      const idpConfig = config as SAMLIdPConfig;
      if (!idpConfig.entityId || !idpConfig.ssoUrl || !idpConfig.certificate) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'entityId, ssoUrl, certificate' },
        });
      }
    } else {
      const spConfig = config as SAMLSPConfig;
      if (!spConfig.entityId || !spConfig.acsUrl) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'entityId, acsUrl' },
        });
      }
    }

    const normalizedConfig =
      body.providerType === 'saml_sp'
        ? normalizeSAMLSPAttributePresetConfig(config as SAMLSPConfig)
        : config;
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
    if (error instanceof SAMLMetadataValidationError) {
      log.warn('Create provider metadata validation failed', {}, error);
      return createSAMLMetadataValidationErrorResponse(c, error);
    }

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

    const resolvedMetadata = await resolveMetadataImportInput(c, body, {
      maxResponseSize: SINGLE_METADATA_FETCH_LIMIT_BYTES,
    });
    if (resolvedMetadata instanceof Response) {
      return resolvedMetadata;
    }
    if (metadataIsAggregateOrThrow(resolvedMetadata.metadataXml)) {
      throw new SAMLMetadataValidationError(
        'Aggregate metadata must be previewed first and imported by selecting EntityDescriptor entries.'
      );
    }

    const metadataUrl = resolvedMetadata.metadataUrl;
    const existingConfig = JSON.parse(existing.config_json) as SAMLIdPConfig | SAMLSPConfig;
    const previousAnalysis = buildPreviousMetadataAnalysis(existingConfig);
    const currentAnalysis = analyzeSAMLMetadata(resolvedMetadata.metadataXml);
    const refreshStatus = buildSAMLMetadataRefreshStatus(previousAnalysis, currentAnalysis);
    let newConfig: SAMLIdPConfig | SAMLSPConfig;

    try {
      newConfig = buildConfigFromMetadata(
        existing.provider_type,
        resolvedMetadata.metadataXml,
        body.samlProfile,
        body.attributePresetId
      );
    } catch (error) {
      throw new SAMLMetadataValidationError(
        error instanceof Error ? error.message : 'Invalid SAML metadata'
      );
    }

    // Merge with existing config (preserve custom settings)
    const mergedConfig = {
      ...existingConfig,
      ...newConfig,
      metadataXml: resolvedMetadata.metadataXml,
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
      return createSAMLMetadataValidationErrorResponse(c, error);
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

    let fetchedMetadataXml: string;
    try {
      fetchedMetadataXml = await safeFetchText(metadataUrl, {
        timeoutMs: 10000,
        maxResponseSize: existingConfig.aggregateImport
          ? AGGREGATE_METADATA_FETCH_LIMIT_BYTES
          : SINGLE_METADATA_FETCH_LIMIT_BYTES,
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    let metadataXml = fetchedMetadataXml;
    let aggregateImport = existingConfig.aggregateImport;
    if (metadataIsAggregateOrThrow(fetchedMetadataXml)) {
      if (!aggregateImport?.aggregateEntityId) {
        throw new SAMLMetadataValidationError(
          'Aggregate metadata refresh requires an aggregate import entity snapshot.'
        );
      }
      const policy = resolveAggregateSignaturePolicy(c.env);
      const trustProfiles = await listFederationTrustProfiles(c.env, tenantId);
      const verification = verifyAggregateMetadataSignature(
        fetchedMetadataXml,
        metadataUrl,
        trustProfiles,
        policy
      );
      metadataXml = extractEntityDescriptorXml(
        fetchedMetadataXml,
        aggregateImport.aggregateEntityId
      );
      aggregateImport = {
        ...aggregateImport,
        aggregateSourceUrl: metadataUrl,
        federationTrustProfileId:
          verification.trustProfileId ?? aggregateImport.federationTrustProfileId,
        verification,
      };
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
        ...(aggregateImport ? { aggregateImport } : {}),
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
      ...(aggregateImport ? { aggregateImport } : {}),
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
      return createSAMLMetadataValidationErrorResponse(c, error);
    }

    log.error('Refresh metadata error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleListFederationTrustProfiles(c: AdminSAMLContext): Promise<Response> {
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_LIST);
    if (forbidden) return forbidden;
    const tenantId = resolveSAMLTenantIdFromContext(c);
    return c.json({ profiles: await listFederationTrustProfiles(c.env, tenantId) });
  } catch (error) {
    getLogger(c)
      .module('SAML')
      .error('List federation trust profiles error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleCreateFederationTrustProfile(c: AdminSAMLContext): Promise<Response> {
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) return forbidden;
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const profile = await buildTrustProfileFromRequest(
      tenantId,
      (await c.req.json()) as SAMLFederationTrustProfileRequest
    );
    await upsertFederationTrustProfile(c.env, profile);
    return c.json(profile, 201);
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      return createSAMLMetadataValidationErrorResponse(c, error);
    }
    getLogger(c)
      .module('SAML')
      .error('Create federation trust profile error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleUpdateFederationTrustProfile(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) return forbidden;
    if (!id) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const existing = await getFederationTrustProfile(c.env, tenantId, id);
    if (!existing) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const profile = await buildTrustProfileFromRequest(
      tenantId,
      (await c.req.json()) as SAMLFederationTrustProfileRequest,
      existing
    );
    await upsertFederationTrustProfile(c.env, profile);
    return c.json(profile);
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      return createSAMLMetadataValidationErrorResponse(c, error);
    }
    getLogger(c)
      .module('SAML')
      .error('Update federation trust profile error', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleDeleteFederationTrustProfile(c: AdminSAMLContext): Promise<Response> {
  const id = c.req.param('id');
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) return forbidden;
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'saml-federation-trust');
    await adapter.execute(
      'DELETE FROM saml_federation_trust_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ success: true });
  } catch (error) {
    getLogger(c)
      .module('SAML')
      .error('Delete federation trust profile error', { id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleListAggregatePreviewEntities(c: AdminSAMLContext): Promise<Response> {
  const previewId = c.req.param('previewId');
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE);
    if (forbidden) return forbidden;
    if (!previewId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const preview = await getAggregatePreview(c.env, previewId);
    if (!preview || preview.tenantId !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const params = new URLSearchParams();
    if (c.req.query('query')) params.set('query', c.req.query('query')!);
    for (const keyword of c.req.queries('keyword') ?? []) {
      if (keyword.trim()) params.append('keyword', keyword.trim());
    }
    params.set('offset', c.req.query('offset') || '0');
    params.set('limit', c.req.query('limit') || '50');
    const response = await aggregateStoreFetch(
      c.env,
      `/preview/${encodeURIComponent(previewId)}/entities?${params.toString()}`,
      { method: 'GET' }
    );
    if (!response.ok) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    return c.json((await response.json()) as SAMLMetadataEntityListResponse);
  } catch (error) {
    getLogger(c)
      .module('SAML')
      .error('List aggregate preview entities error', { previewId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleStartAggregateBatchCreate(c: AdminSAMLContext): Promise<Response> {
  const previewId = c.req.param('previewId');
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE);
    if (forbidden) return forbidden;
    if (!previewId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const body = (await c.req.json()) as SAMLMetadataBatchCreateRequest;
    const entityIds = Array.from(
      new Set((body.entityIds ?? []).map((id) => id.trim()).filter(Boolean))
    );
    if (entityIds.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'entityIds' },
      });
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const preview = await getAggregatePreview(c.env, previewId);
    if (!preview || preview.tenantId !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const batchId = crypto.randomUUID();
    const status = await startAggregateBatch(c.env, batchId, tenantId, entityIds.length);
    c.executionCtx.waitUntil(
      processAggregateBatchCreate(c.env, {
        tenantId,
        previewId,
        batchId,
        entityIds,
        providerType: body.providerType,
        samlProfile: body.samlProfile,
        attributePresetId: body.attributePresetId,
        enabled: body.enabled !== false,
      })
    );
    return c.json(status, 202);
  } catch (error) {
    getLogger(c)
      .module('SAML')
      .error('Start aggregate batch create error', { previewId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleGetAggregateBatchStatus(c: AdminSAMLContext): Promise<Response> {
  const batchId = c.req.param('batchId');
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_LIST);
    if (forbidden) return forbidden;
    if (!batchId) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const response = await aggregateStoreFetch(c.env, `/batch/${encodeURIComponent(batchId)}`, {
      method: 'GET',
    });
    if (!response.ok) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    const status = (await response.json()) as SAMLMetadataBatchStatusResponse;
    const tenantId = resolveSAMLTenantIdFromContext(c);
    if (status.tenantId !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    return c.json(status);
  } catch (error) {
    getLogger(c)
      .module('SAML')
      .error('Get aggregate batch status error', { batchId }, error as Error);
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

function detectSAMLMetadataProviderType(metadataXml: string): 'saml_idp' | 'saml_sp' {
  const doc = parseXml(metadataXml);
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  if (!entityDescriptor) {
    throw new SAMLMetadataValidationError('Invalid metadata: missing EntityDescriptor');
  }

  const hasIdP = Boolean(findElement(entityDescriptor, SAML_NAMESPACES.MD, 'IDPSSODescriptor'));
  const hasSP = Boolean(findElement(entityDescriptor, SAML_NAMESPACES.MD, 'SPSSODescriptor'));

  if (hasIdP && !hasSP) {
    return 'saml_idp';
  }
  if (hasSP && !hasIdP) {
    return 'saml_sp';
  }
  if (hasIdP && hasSP) {
    throw new SAMLMetadataValidationError(
      'Metadata contains both Identity Provider and Service Provider descriptors, so Authrim cannot safely auto-select a role. Import role-specific metadata instead, or choose the provider type and configure the role manually.'
    );
  }

  throw new SAMLMetadataValidationError(
    'Invalid metadata: missing IDPSSODescriptor or SPSSODescriptor'
  );
}

function createSAMLMetadataValidationErrorResponse(
  c: AdminSAMLContext,
  error: SAMLMetadataValidationError
): Response {
  return c.json(
    {
      error: 'invalid_request',
      error_description: error.message,
      error_code: AR_ERROR_CODES.VALIDATION_INVALID_VALUE,
    },
    400
  );
}

function metadataIsAggregateOrThrow(metadataXml: string): boolean {
  try {
    return isAggregateMetadata(metadataXml);
  } catch (error) {
    throw toSAMLMetadataValidationError(error);
  }
}

function toSAMLMetadataValidationError(error: unknown): SAMLMetadataValidationError {
  if (error instanceof SAMLMetadataValidationError) {
    return error;
  }
  return new SAMLMetadataValidationError(
    error instanceof Error ? error.message : 'Invalid SAML metadata'
  );
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

async function resolveMetadataImportInput(
  c: AdminSAMLContext,
  input: MetadataImportRequest,
  options: { maxResponseSize?: number } = {}
): Promise<{ metadataXml: string; metadataUrl?: string } | Response> {
  if (input.metadataXml) {
    return { metadataXml: input.metadataXml };
  }

  if (!input.metadataUrl) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'metadataXml or metadataUrl' },
    });
  }

  const ssrfError = validateExternalUrl(input.metadataUrl, {
    requireHttps: true,
    allowLocalhost: false,
    errorType: 'invalid_request',
    fieldName: 'metadataUrl',
  });
  if (ssrfError) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  try {
    const metadataXml = await safeFetchText(input.metadataUrl, {
      timeoutMs: 10000,
      maxResponseSize: options.maxResponseSize ?? SINGLE_METADATA_FETCH_LIMIT_BYTES,
    });
    return { metadataXml, metadataUrl: input.metadataUrl };
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
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

async function buildTrustProfileFromRequest(
  tenantId: string,
  body: SAMLFederationTrustProfileRequest,
  existing?: SAMLFederationTrustProfile
): Promise<SAMLFederationTrustProfile> {
  const now = Date.now();
  const certificates = await Promise.all(
    (body.certificates ?? existing?.certificates ?? []).map(async (certificate) => ({
      id: certificate.id || crypto.randomUUID(),
      name: certificate.name,
      certificate: certificate.certificate,
      fingerprintSha256:
        'fingerprintSha256' in certificate && typeof certificate.fingerprintSha256 === 'string'
          ? certificate.fingerprintSha256
          : await fingerprintCertificateSha256(certificate.certificate),
      createdAt:
        'createdAt' in certificate && typeof certificate.createdAt === 'number'
          ? certificate.createdAt
          : now,
    }))
  );

  if (!body.name && !existing?.name) {
    throw new SAMLMetadataValidationError('Federation trust profile name is required');
  }
  if ((body.metadataUrlPatterns ?? existing?.metadataUrlPatterns ?? []).length === 0) {
    throw new SAMLMetadataValidationError('At least one metadata URL pattern is required');
  }
  if (certificates.length === 0) {
    throw new SAMLMetadataValidationError('At least one trust certificate is required');
  }

  return {
    id: existing?.id ?? crypto.randomUUID(),
    tenantId,
    name: body.name ?? existing!.name,
    description: body.description ?? existing?.description,
    metadataUrlPatterns: body.metadataUrlPatterns ?? existing!.metadataUrlPatterns,
    certificates,
    policy: body.policy ?? existing?.policy,
    enabled: body.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function listFederationTrustProfiles(
  env: Env,
  tenantId: string
): Promise<SAMLFederationTrustProfile[]> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-trust');
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    name: string;
    description: string | null;
    metadata_url_patterns_json: string;
    certificates_json: string;
    policy: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, name, description, metadata_url_patterns_json, certificates_json,
            policy, enabled, created_at, updated_at
       FROM saml_federation_trust_profiles
       WHERE tenant_id = ?
       ORDER BY name ASC`,
    [tenantId]
  );

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description ?? undefined,
    metadataUrlPatterns: JSON.parse(row.metadata_url_patterns_json),
    certificates: JSON.parse(row.certificates_json),
    policy:
      row.policy === 'strict' || row.policy === 'warn' || row.policy === 'disabled'
        ? row.policy
        : undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function getFederationTrustProfile(
  env: Env,
  tenantId: string,
  id: string
): Promise<SAMLFederationTrustProfile | null> {
  return (
    (await listFederationTrustProfiles(env, tenantId)).find((profile) => profile.id === id) ?? null
  );
}

async function upsertFederationTrustProfile(
  env: Env,
  profile: SAMLFederationTrustProfile
): Promise<void> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-trust');
  await adapter.execute(
    `INSERT INTO saml_federation_trust_profiles
       (id, tenant_id, name, description, metadata_url_patterns_json, certificates_json,
        policy, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       metadata_url_patterns_json = excluded.metadata_url_patterns_json,
       certificates_json = excluded.certificates_json,
       policy = excluded.policy,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    [
      profile.id,
      profile.tenantId,
      profile.name,
      profile.description ?? null,
      JSON.stringify(profile.metadataUrlPatterns),
      JSON.stringify(profile.certificates),
      profile.policy ?? null,
      profile.enabled ? 1 : 0,
      profile.createdAt,
      profile.updatedAt,
    ]
  );
}

async function storeAggregatePreview(
  env: Env,
  input: {
    previewId: string;
    tenantId: string;
    metadataXml: string;
    metadataUrl?: string;
    entities: unknown[];
    verification: SAMLMetadataVerificationSummary;
  }
): Promise<{ expiresAt: number }> {
  const response = await aggregateStoreFetch(env, '/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error('Failed to store aggregate preview');
  }
  return (await response.json()) as { expiresAt: number };
}

async function getAggregatePreview(
  env: Env,
  previewId: string
): Promise<{
  tenantId: string;
  metadataXml: string;
  metadataUrl?: string;
  verification: SAMLMetadataVerificationSummary;
} | null> {
  const response = await aggregateStoreFetch(env, `/preview/${encodeURIComponent(previewId)}`, {
    method: 'GET',
  });
  return response.ok
    ? ((await response.json()) as {
        tenantId: string;
        metadataXml: string;
        metadataUrl?: string;
        verification: SAMLMetadataVerificationSummary;
      })
    : null;
}

async function startAggregateBatch(
  env: Env,
  batchId: string,
  tenantId: string,
  total: number
): Promise<SAMLMetadataBatchStatusResponse> {
  const response = await aggregateStoreFetch(env, '/batch', {
    method: 'POST',
    body: JSON.stringify({ batchId, tenantId, total }),
  });
  if (!response.ok) {
    throw new Error('Failed to start aggregate batch');
  }
  return (await response.json()) as SAMLMetadataBatchStatusResponse;
}

async function recordAggregateBatchResult(
  env: Env,
  batchId: string,
  result: SAMLMetadataBatchCreateResult
): Promise<void> {
  await aggregateStoreFetch(env, `/batch/${encodeURIComponent(batchId)}/result`, {
    method: 'POST',
    body: JSON.stringify(result),
  });
}

async function completeAggregateBatch(env: Env, batchId: string): Promise<void> {
  await aggregateStoreFetch(env, `/batch/${encodeURIComponent(batchId)}/complete`, {
    method: 'POST',
  });
}

async function failAggregateBatch(env: Env, batchId: string, error: string): Promise<void> {
  await aggregateStoreFetch(env, `/batch/${encodeURIComponent(batchId)}/fail`, {
    method: 'POST',
    body: JSON.stringify({ error }),
  });
}

async function processAggregateBatchCreate(
  env: Env,
  input: {
    tenantId: string;
    previewId: string;
    batchId: string;
    entityIds: string[];
    providerType?: 'saml_idp' | 'saml_sp';
    samlProfile?: SAMLSPProfile;
    attributePresetId?: SAMLAttributePresetId;
    enabled: boolean;
  }
): Promise<void> {
  try {
    const preview = await getAggregatePreview(env, input.previewId);
    if (!preview || preview.tenantId !== input.tenantId) {
      throw new Error('Aggregate preview not found');
    }
    const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'core', {
      tenantId: input.tenantId,
    });
    const existingProviders = await coreAdapter.query<{
      provider_type: string;
      config_json: string;
    }>(
      `SELECT provider_type, config_json
       FROM identity_providers
       WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')`,
      [input.tenantId]
    );
    const existingEntityKeys = new Set(
      existingProviders
        .map((row) => {
          try {
            const config = JSON.parse(row.config_json) as SAMLIdPConfig | SAMLSPConfig;
            return config.entityId ? `${row.provider_type}:${config.entityId}` : null;
          } catch {
            return null;
          }
        })
        .filter((key): key is string => Boolean(key))
    );

    for (const entityId of input.entityIds) {
      try {
        const metadataXml = extractEntityDescriptorXml(preview.metadataXml, entityId);
        const providerType = input.providerType ?? detectSAMLMetadataProviderType(metadataXml);
        if (providerType !== 'saml_idp' && providerType !== 'saml_sp') {
          throw new Error('Unsupported SAML metadata role');
        }
        const entityKey = `${providerType}:${entityId}`;
        if (existingEntityKeys.has(entityKey)) {
          throw new Error(`Provider already exists for entityID: ${entityId}`);
        }
        const config = buildConfigFromMetadata(
          providerType,
          metadataXml,
          input.samlProfile,
          input.attributePresetId
        );
        const metadataAnalysis = analyzeSAMLMetadata(metadataXml);
        const now = Date.now();
        const providerId = crypto.randomUUID();
        const normalizedConfig = {
          ...config,
          metadataXml,
          metadataUrl: preview.metadataUrl,
          metadataHash: metadataAnalysis.hash,
          metadataCriticalFields: metadataAnalysis.criticalFields,
          metadataRefreshStatus: buildSAMLMetadataRefreshStatus(undefined, metadataAnalysis),
          metadataLastFetched: now,
          aggregateImport: {
            aggregateSourceUrl: preview.metadataUrl,
            aggregateEntityId: entityId,
            federationTrustProfileId: preview.verification.trustProfileId,
            verification: preview.verification,
            importedAt: now,
          },
        } as SAMLIdPConfig | SAMLSPConfig;
        const name = buildProviderNameFromEntity(entityId, providerType);
        await coreAdapter.execute(
          `INSERT INTO identity_providers
             (id, tenant_id, name, provider_type, config_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            providerId,
            input.tenantId,
            name,
            providerType,
            JSON.stringify(normalizedConfig),
            input.enabled ? 1 : 0,
            now,
            now,
          ]
        );
        await recordAggregateBatchResult(env, input.batchId, {
          entityId,
          success: true,
          providerId,
          providerType,
          name,
        });
        existingEntityKeys.add(entityKey);
      } catch (error) {
        await recordAggregateBatchResult(env, input.batchId, {
          entityId,
          success: false,
          error: error instanceof Error ? error.message : 'Import failed',
        });
      }
    }

    await completeAggregateBatch(env, input.batchId);
  } catch (error) {
    await failAggregateBatch(
      env,
      input.batchId,
      error instanceof Error ? error.message : 'Batch failed'
    );
  }
}

async function aggregateStoreFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  if (!env.SAML_AGGREGATE_METADATA_STORE) {
    throw new Error('SAML_AGGREGATE_METADATA_STORE binding is not configured');
  }
  const id = env.SAML_AGGREGATE_METADATA_STORE.idFromName('global');
  const stub = env.SAML_AGGREGATE_METADATA_STORE.get(id);
  return await stub.fetch(`https://saml-aggregate-metadata.local${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function buildProviderNameFromEntity(
  entityId: string,
  providerType: 'saml_idp' | 'saml_sp'
): string {
  try {
    const url = new URL(entityId);
    return `${url.hostname} ${providerType === 'saml_sp' ? 'SP' : 'IdP'}`;
  } catch {
    return `${entityId} ${providerType === 'saml_sp' ? 'SP' : 'IdP'}`;
  }
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
    const spDescriptor = findElement(entityDescriptor, SAML_NAMESPACES.MD, 'SPSSODescriptor');
    if (spDescriptor) {
      throw new Error(
        'Metadata is for a SAML Service Provider, not an Identity Provider. Choose Service Provider or provide IdP metadata containing IDPSSODescriptor.'
      );
    }
    throw new Error('Invalid metadata: missing IDPSSODescriptor');
  }

  // Get SSO URL. SP-initiated login signs AuthnRequest with HTTP-Redirect,
  // so prefer the Redirect endpoint when metadata publishes both bindings.
  const ssoServices = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'SingleSignOnService');
  let postSsoUrl = '';
  let redirectSsoUrl = '';
  const allowedBindings: SAMLIdPConfig['allowedBindings'] = [];

  for (const sso of ssoServices) {
    const binding = getAttribute(sso, 'Binding');
    const location = getAttribute(sso, 'Location');

    if (binding === BINDING_URIS.HTTP_POST) {
      postSsoUrl = postSsoUrl || location || '';
      allowedBindings.push('post');
    } else if (binding === BINDING_URIS.HTTP_REDIRECT) {
      redirectSsoUrl = redirectSsoUrl || location || '';
      allowedBindings.push('redirect');
    }
  }

  const ssoUrl = redirectSsoUrl || postSsoUrl;
  if (!ssoUrl) {
    throw new Error('Invalid metadata: no supported SSO binding found');
  }

  // Get SLO URL (optional)
  const sloServices = findElements(idpDescriptor, SAML_NAMESPACES.MD, 'SingleLogoutService');
  let sloUrl: string | undefined;

  for (const slo of sloServices) {
    const binding = getAttribute(slo, 'Binding');
    if (binding === BINDING_URIS.HTTP_REDIRECT) {
      sloUrl = getAttribute(slo, 'Location') || undefined;
      break;
    }
    if (binding === BINDING_URIS.HTTP_POST) {
      sloUrl = sloUrl || getAttribute(slo, 'Location') || undefined;
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
    logoUrl: getLogoUrl(entityDescriptor),
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
    const idpDescriptor = findElement(entityDescriptor, SAML_NAMESPACES.MD, 'IDPSSODescriptor');
    if (idpDescriptor) {
      throw new Error(
        'Metadata is for a SAML Identity Provider, not a Service Provider. Choose Identity Provider or provide SP metadata containing SPSSODescriptor.'
      );
    }
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
