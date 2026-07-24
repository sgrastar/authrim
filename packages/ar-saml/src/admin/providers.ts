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
  SAMLCertificateValidationSummary,
  SAMLJitEmailLinkingPolicy,
  NameIDFormat,
} from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  validateExternalUrl,
  safeFetch,
  safeFetchText,
  createAuthContextFromHono,
  resolveAuthCorePersistenceAdapterFromEnv,
  requireDedicatedAdminDatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  createLogger,
  createAuditLog,
  hasAdminPermission,
  bumpAuthenticationMethodsCacheRevision,
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
import { normalizeAttributeReleaseConsentPolicy } from '../idp/attribute-release-consent';
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
  getSAMLNextSigningCertificates,
  promoteSAMLNextSigningCertificate,
  publishSAMLNextSigningCertificate,
  retireSAMLBackupSigningCertificate,
  deleteSAMLNextSigningCertificate,
} from './signing-rollover';
import {
  buildEncryptedSAMLLocalSigningSecretDRBundle,
  restoreEncryptedSAMLLocalSigningSecretDRBundle,
  SAMLDRBundleOperationError,
  type SAMLDRBundleFailureStage,
} from './local-signing-dr-bundle';
import { previewTrustCertificate } from './certificate-preview';
import {
  buildSAMLSigningCertificateSubjectAlternativeNames,
  getSAMLLocalEntityIds,
  getSAMLPublicSettings,
  normalizeCertificateSubjectAlternativeNames,
  normalizeSAMLInteractiveLoginUrlPolicy,
  normalizeSAMLEntityIdStyle,
  putSAMLLocalSigningSettings,
  putSAMLPublicSettings,
} from '../common/entity-id';
import { buildSAMLSigningKeyRef } from '../common/saml-signing-keys';
import {
  DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT,
  rotateSigningKeyWithCertificate,
  type SAMLSigningCertificateSubject,
} from '../common/key-utils';
import {
  buildSAMLMetadataValidUntil,
  SAML_METADATA_CACHE_DURATION,
  SAML_METADATA_VALIDITY_DAYS,
} from '../common/metadata-cache';
import { resolveSAMLMetadataSigningMode, shouldSignSAMLMetadata } from '../common/metadata-signing';

type AdminSAMLContext = Context<{ Bindings: Env }>;
type AdminSAMLAuthContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

async function invalidateAuthenticationMethodsCacheForSAML(
  env: Env,
  tenantId: string,
  reason: string,
  c?: AdminSAMLContext
): Promise<void> {
  const log = c ? getLogger(c).module('SAML') : createLogger().module('SAML');
  try {
    await bumpAuthenticationMethodsCacheRevision(env, tenantId);
  } catch (error) {
    log.warn('Failed to bump authentication methods cache revision', {
      tenantId,
      reason,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function buildSAMLMetadataPublicationSettings(env: Env): {
  signingMode: 'disabled' | 'enabled';
  signingEnabled: boolean;
  validUntilEnabled: boolean;
  idpValidUntil: string;
  spValidUntil: string;
  validityDays: number;
  cacheDuration: string;
} {
  const validUntil = buildSAMLMetadataValidUntil();
  const signingMode = resolveSAMLMetadataSigningMode(env);

  return {
    signingMode,
    signingEnabled: shouldSignSAMLMetadata(env),
    validUntilEnabled: true,
    idpValidUntil: validUntil,
    spValidUntil: validUntil,
    validityDays: SAML_METADATA_VALIDITY_DAYS,
    cacheDuration: SAML_METADATA_CACHE_DURATION,
  };
}

function normalizeSAMLSigningCertificateSubject(
  value: unknown
): Required<SAMLSigningCertificateSubject> {
  const source =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    countryName: readSubjectString(source.countryName, 2).toUpperCase(),
    stateOrProvinceName: readSubjectString(source.stateOrProvinceName, 128),
    localityName: readSubjectString(source.localityName, 128),
    organizationName:
      readSubjectString(source.organizationName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.organizationName,
    organizationalUnitName: readSubjectString(source.organizationalUnitName, 128),
    commonName:
      readSubjectString(source.commonName, 128) ||
      DEFAULT_SAML_SIGNING_CERTIFICATE_SUBJECT.commonName,
  };
}

function readSubjectString(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, maxLength)
    : '';
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeSAMLPublicKeySizeBits(value: unknown): 2048 | 3072 | 4096 | undefined {
  const normalized = typeof value === 'string' ? Number(value) : value;
  return normalized === 2048 || normalized === 3072 || normalized === 4096 ? normalized : undefined;
}

interface SAMLMetadataConfigFields {
  metadataXml?: string;
  metadataUrl?: string;
  metadataHash?: string;
  metadataCriticalFields?: SAMLMetadataAnalysis['criticalFields'];
  metadataRefreshStatus?: SAMLMetadataRefreshStatus;
  metadataLastFetched?: number;
}

const SAML_JIT_EMAIL_LINKING_POLICIES = new Set<SAMLJitEmailLinkingPolicy>([
  'email_linking',
  'jit_create_only',
  'disabled',
]);

function normalizeSAMLIdPJitLinkingPolicyConfig(
  config: SAMLIdPConfig
): SAMLIdPConfig | ResponseValidationError {
  const policy = config.jitEmailLinkingPolicy ?? 'email_linking';
  if (!SAML_JIT_EMAIL_LINKING_POLICIES.has(policy)) {
    return { field: 'jitEmailLinkingPolicy' };
  }
  if (!config.identityMapping?.fieldMappingSetId) {
    return { field: 'identityMapping.fieldMappingSetId' };
  }

  return {
    ...config,
    jitEmailLinkingPolicy: policy,
    allowSyntheticEmailFallback: config.allowSyntheticEmailFallback === true,
  };
}

function normalizeSAMLSPConfig(config: SAMLSPConfig): SAMLSPConfig | ResponseValidationError {
  if (!config.identityMapping?.fieldMappingSetId) {
    return { field: 'identityMapping.fieldMappingSetId' };
  }
  if (config.attributeReleaseConsent === undefined) {
    return config;
  }

  const attributeReleaseConsent = normalizeAttributeReleaseConsentPolicy(
    config.attributeReleaseConsent
  );
  if (!attributeReleaseConsent) {
    return { field: 'attributeReleaseConsent.mode' };
  }

  return {
    ...config,
    attributeReleaseConsent,
  };
}

interface ResponseValidationError {
  field: string;
}

function isResponseValidationError(value: unknown): value is ResponseValidationError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ResponseValidationError).field === 'string'
  );
}

function collectProviderCertificates(config: SAMLIdPConfig | SAMLSPConfig): string[] {
  const certificates = new Set<string>();
  const primary = config.certificate?.trim();
  if (primary) {
    certificates.add(primary);
  }
  for (const certificate of config.certificates ?? []) {
    const trimmed = certificate.trim();
    if (trimmed) {
      certificates.add(trimmed);
    }
  }
  return [...certificates];
}

async function buildProviderCertificateValidation(
  config: SAMLIdPConfig | SAMLSPConfig
): Promise<SAMLCertificateValidationSummary | undefined> {
  const certificates = collectProviderCertificates(config);
  if (certificates.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const statuses = await Promise.all(
    certificates.map(async (certificate) => {
      try {
        const preview = await previewTrustCertificate(certificate, 'pem');
        const validFromMs = Date.parse(preview.validFrom);
        const validToMs = Date.parse(preview.validTo);
        const expired = Number.isFinite(validToMs) && now > validToMs;
        const notYetValid = Number.isFinite(validFromMs) && now < validFromMs;
        return {
          validFrom: preview.validFrom,
          validTo: preview.validTo,
          expired,
          notYetValid,
          signatureAlgorithm: preview.signatureAlgorithm,
          publicKeyAlgorithm: preview.publicKeyAlgorithm,
          publicKeySizeBits: preview.publicKeySizeBits,
          fingerprintSha1: preview.fingerprintSha1,
          fingerprintSha256: preview.fingerprintSha256,
          warnings: preview.warnings,
        };
      } catch (error) {
        return {
          expired: false,
          notYetValid: false,
          warnings: [
            `Certificate could not be parsed: ${
              error instanceof Error ? error.message : 'invalid certificate'
            }`,
          ],
        };
      }
    })
  );

  const validToDates = statuses
    .map((status) => ({ status, value: status.validTo ? Date.parse(status.validTo) : NaN }))
    .filter((item) => Number.isFinite(item.value));
  const nonExpiredValidToDates = validToDates.filter((item) => !item.status.expired);
  const selectedValidTo =
    nonExpiredValidToDates.length > 0
      ? nonExpiredValidToDates.reduce((earliest, item) =>
          item.value < earliest.value ? item : earliest
        ).status.validTo
      : validToDates.length > 0
        ? validToDates.reduce((latest, item) => (item.value > latest.value ? item : latest)).status
            .validTo
        : undefined;
  const hasWeakSignature = statuses.some((status) => {
    const signatureAlgorithm = status.signatureAlgorithm?.toLowerCase() ?? '';
    return (
      signatureAlgorithm.includes('sha1') ||
      signatureAlgorithm.includes('md5') ||
      status.warnings.some((warning) => /sha-?1|md5/i.test(warning))
    );
  });
  const warnings = [...new Set(statuses.flatMap((status) => status.warnings))];

  return {
    checkedAt: now,
    certificates: statuses,
    validUntil: selectedValidTo,
    allExpired: statuses.length > 0 && statuses.every((status) => status.expired),
    hasExpired: statuses.some((status) => status.expired),
    hasWeakSignature,
    warnings,
  };
}

async function withProviderCertificateValidation<T extends SAMLIdPConfig | SAMLSPConfig>(
  config: T
): Promise<T> {
  const certificateValidation = await buildProviderCertificateValidation(config);
  if (!certificateValidation) {
    const nextConfig = { ...config };
    delete nextConfig.certificateValidation;
    return nextConfig;
  }
  return {
    ...config,
    certificateValidation,
  };
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

    const response = await Promise.all(
      providers.map(async (row) => ({
        id: row.id,
        name: row.name,
        providerType: row.provider_type,
        config: await withProviderCertificateValidation(JSON.parse(row.config_json)),
        enabled: row.enabled === 1,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }))
    );

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

export async function handleGetSAMLSettings(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_READ);
    if (forbidden) {
      return forbidden;
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const settings = await getSAMLPublicSettings(c.env, tenantId);
    const entityIds = await getSAMLLocalEntityIds(c.env, tenantId);

    return c.json({
      tenantId,
      ...settings,
      metadata: buildSAMLMetadataPublicationSettings(c.env),
      localSigning: {
        certificateSubject: settings.certificateSubject,
        certificateSubjectAlternativeNames: settings.certificateSubjectAlternativeNames,
        idpSigningKeyPolicy: settings.signingKeyPolicies.idp ?? {},
        spSigningKeyPolicy: settings.signingKeyPolicies.sp ?? {},
      },
      generated: {
        issuerUrl: entityIds.issuerUrl,
        idpEntityId: entityIds.idpEntityId,
        spEntityId: entityIds.spEntityId,
        idpMetadataUrl: entityIds.idpMetadataUrl,
        spMetadataUrl: entityIds.spMetadataUrl,
      },
    });
  } catch (error) {
    log.error('Get SAML settings error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleUpdateSAMLSettings(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as {
      entityIdStyle?: unknown;
      interactiveLoginUrlPolicy?: unknown;
      certificateSubject?: unknown;
      certificateSubjectAlternativeNames?: unknown;
    };
    const tenantId = resolveSAMLTenantIdFromContext(c);
    const before = await getSAMLPublicSettings(c.env, tenantId);
    const entityIdStyle =
      body.entityIdStyle === undefined
        ? before.entityIdStyle
        : normalizeSAMLEntityIdStyle(body.entityIdStyle);
    const interactiveLoginUrlPolicy =
      body.interactiveLoginUrlPolicy === undefined
        ? before.interactiveLoginUrlPolicy
        : normalizeSAMLInteractiveLoginUrlPolicy(body.interactiveLoginUrlPolicy);
    if (!entityIdStyle) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'entityIdStyle' },
      });
    }
    if (!interactiveLoginUrlPolicy) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'interactiveLoginUrlPolicy' },
      });
    }

    const certificateSubject =
      body.certificateSubject === undefined
        ? before.certificateSubject
        : normalizeSAMLSigningCertificateSubject(body.certificateSubject);
    const certificateSubjectAlternativeNames =
      body.certificateSubjectAlternativeNames === undefined
        ? before.certificateSubjectAlternativeNames
        : normalizeCertificateSubjectAlternativeNames(body.certificateSubjectAlternativeNames);

    await putSAMLPublicSettings(c.env, tenantId, {
      entityIdStyle,
      interactiveLoginUrlPolicy,
      certificateSubject,
      certificateSubjectAlternativeNames,
      signingKeyPolicies: before.signingKeyPolicies,
    });

    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.settings.updated',
      resource: 'saml_settings',
      resourceId: tenantId,
      metadata: {
        before_entity_id_style: before.entityIdStyle,
        entity_id_style: entityIdStyle,
        before_interactive_login_url_policy: before.interactiveLoginUrlPolicy,
        interactive_login_url_policy: interactiveLoginUrlPolicy,
        certificate_subject_changed:
          JSON.stringify(before.certificateSubject) !== JSON.stringify(certificateSubject),
        certificate_subject_alternative_names_changed:
          JSON.stringify(before.certificateSubjectAlternativeNames) !==
          JSON.stringify(certificateSubjectAlternativeNames),
      },
    });

    const entityIds = await getSAMLLocalEntityIds(c.env, tenantId);
    return c.json({
      tenantId,
      entityIdStyle,
      interactiveLoginUrlPolicy,
      certificateSubject,
      certificateSubjectAlternativeNames,
      signingKeyPolicies: before.signingKeyPolicies,
      metadata: buildSAMLMetadataPublicationSettings(c.env),
      localSigning: {
        certificateSubject,
        certificateSubjectAlternativeNames,
        idpSigningKeyPolicy: before.signingKeyPolicies.idp ?? {},
        spSigningKeyPolicy: before.signingKeyPolicies.sp ?? {},
      },
      generated: {
        issuerUrl: entityIds.issuerUrl,
        idpEntityId: entityIds.idpEntityId,
        spEntityId: entityIds.spEntityId,
        idpMetadataUrl: entityIds.idpMetadataUrl,
        spMetadataUrl: entityIds.spMetadataUrl,
      },
    });
  } catch (error) {
    log.error('Update SAML settings error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleUpdateSAMLLocalSigning(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');

  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE);
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as {
      role?: unknown;
      action?: unknown;
      certificateSubject?: unknown;
      certificateSubjectAlternativeNames?: unknown;
      keepPreviousAsBackup?: unknown;
      targetKid?: unknown;
      targetKeyRef?: unknown;
      validFrom?: unknown;
      validTo?: unknown;
      publicKeyAlgorithm?: unknown;
      publicKeySizeBits?: unknown;
    };
    const role: 'idp' | 'sp' | null = body.role === 'idp' || body.role === 'sp' ? body.role : null;
    const action =
      body.action === 'recreate_active' ||
      body.action === 'publish_next' ||
      body.action === 'promote_next' ||
      body.action === 'retire_backup' ||
      body.action === 'delete_next'
        ? body.action
        : null;
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'role' },
      });
    }
    if (!action) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'action' },
      });
    }

    const tenantId = resolveSAMLTenantIdFromContext(c);
    const settings = await getSAMLPublicSettings(c.env, tenantId);
    const certificateSubject =
      body.certificateSubject === undefined
        ? settings.certificateSubject
        : normalizeSAMLSigningCertificateSubject(body.certificateSubject);
    const certificateSubjectAlternativeNames =
      body.certificateSubjectAlternativeNames === undefined
        ? settings.certificateSubjectAlternativeNames
        : normalizeCertificateSubjectAlternativeNames(body.certificateSubjectAlternativeNames);
    const targetKid = typeof body.targetKid === 'string' ? body.targetKid : undefined;
    const targetKeyRef = typeof body.targetKeyRef === 'string' ? body.targetKeyRef : undefined;
    const validFrom = normalizeOptionalTimestamp(body.validFrom);
    const validTo = normalizeOptionalTimestamp(body.validTo);
    const publicKeyAlgorithm = body.publicKeyAlgorithm === 'RSA' ? 'RSA' : undefined;
    const publicKeySizeBits = normalizeSAMLPublicKeySizeBits(body.publicKeySizeBits);
    if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'validTo' },
      });
    }
    const signingKeyPolicies = { ...settings.signingKeyPolicies };
    const currentPolicy = signingKeyPolicies[role] ?? {};
    const baseContext = { tenantId, role };
    const entityIds = await getSAMLLocalEntityIds(c.env, tenantId);
    const subjectAlternativeNames = buildSAMLSigningCertificateSubjectAlternativeNames(
      entityIds,
      role,
      certificateSubjectAlternativeNames
    );
    let nextPolicy = currentPolicy;
    let generated: { keyRef?: string; kid?: string; certificate?: string } = {};

    if (action === 'recreate_active') {
      const keyRef =
        currentPolicy.active?.keyRef ??
        buildSAMLSigningKeyRef({
          tenantId,
          role,
          policy: currentPolicy,
        });
      generated = await rotateSigningKeyWithCertificate(c.env, tenantId, {
        keyRef,
        certificateSubject,
        certificateOptions: {
          validFrom,
          validTo,
          publicKeyAlgorithm,
          publicKeySizeBits,
          subjectAlternativeNames,
        },
      });
      nextPolicy = {
        ...currentPolicy,
        active: {
          slot: 'active',
          keyRef: generated.keyRef,
          kid: generated.kid,
          certificate: generated.certificate,
          state: 'active',
          plannedActivationAt: Date.now(),
          validFrom,
          validTo,
          publicKeyAlgorithm,
          publicKeySizeBits,
          subjectAlternativeNames,
        },
        metadataCertificatePublication: getSAMLNextSigningCertificates(currentPolicy).length
          ? currentPolicy.backup
            ? 'active_next_backup'
            : 'active_next'
          : 'active_only',
      };
    } else if (action === 'publish_next') {
      const keyRef = `${buildSAMLSigningKeyRef({
        tenantId,
        role,
        policy: currentPolicy,
      })}:next:${Date.now()}`;
      generated = await rotateSigningKeyWithCertificate(c.env, tenantId, {
        keyRef,
        certificateSubject,
        certificateOptions: {
          validFrom,
          validTo,
          publicKeyAlgorithm,
          publicKeySizeBits,
          subjectAlternativeNames,
        },
      });
      nextPolicy = publishSAMLNextSigningCertificate(currentPolicy, {
        ...baseContext,
        keyRef: generated.keyRef,
        kid: generated.kid,
        certificate: generated.certificate!,
        metadataPublishFrom: Date.now(),
        validFrom,
        validTo,
        publicKeyAlgorithm,
        publicKeySizeBits,
        subjectAlternativeNames,
        metadataCertificatePublication: currentPolicy.backup ? 'active_next_backup' : 'active_next',
      });
    } else if (action === 'promote_next') {
      nextPolicy = promoteSAMLNextSigningCertificate(currentPolicy, {
        ...baseContext,
        keepPreviousAsBackup: body.keepPreviousAsBackup !== false,
        targetKid,
        targetKeyRef,
      });
    } else if (action === 'retire_backup') {
      nextPolicy = retireSAMLBackupSigningCertificate(currentPolicy);
    } else {
      nextPolicy = deleteSAMLNextSigningCertificate(currentPolicy, { targetKid, targetKeyRef });
    }

    signingKeyPolicies[role] = nextPolicy;
    const nextSettings = await putSAMLLocalSigningSettings(c.env, tenantId, {
      certificateSubject,
      certificateSubjectAlternativeNames,
      signingKeyPolicies,
    });

    await createSAMLAdminAudit(c, {
      tenantId,
      action: `saml.local_signing.${action}`,
      resource: 'saml_settings',
      resourceId: `${tenantId}:${role}`,
      severity: action === 'recreate_active' || action === 'promote_next' ? 'warning' : 'info',
      metadata: {
        role,
        target_kid: targetKid,
        target_key_ref: targetKeyRef,
        key_ref: generated.keyRef,
        kid: generated.kid,
      },
    });

    return c.json({
      tenantId,
      ...nextSettings,
      metadata: buildSAMLMetadataPublicationSettings(c.env),
      localSigning: {
        certificateSubject: nextSettings.certificateSubject,
        certificateSubjectAlternativeNames: nextSettings.certificateSubjectAlternativeNames,
        idpSigningKeyPolicy: nextSettings.signingKeyPolicies.idp ?? {},
        spSigningKeyPolicy: nextSettings.signingKeyPolicies.sp ?? {},
      },
      generated: {
        issuerUrl: entityIds.issuerUrl,
        idpEntityId: entityIds.idpEntityId,
        spEntityId: entityIds.spEntityId,
        idpMetadataUrl: entityIds.idpMetadataUrl,
        spMetadataUrl: entityIds.spMetadataUrl,
      },
    });
  } catch (error) {
    log.error('Update SAML local signing error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function handleExportSAMLLocalSigningDRBundle(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');
  let failureStage: SAMLDRBundleFailureStage | 'authorize' | 'audit' = 'authorize';

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_DR_BUNDLE_EXPORT
    );
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as { passphrase?: unknown };
    const tenantId = resolveSAMLTenantIdFromContext(c);
    failureStage = 'export_signing_keys';
    const bundle = await buildEncryptedSAMLLocalSigningSecretDRBundle(
      c.env,
      tenantId,
      body.passphrase
    );

    failureStage = 'audit';
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.local_signing.dr_bundle.exported',
      resource: 'saml_settings',
      resourceId: tenantId,
      severity: 'warning',
      metadata: {
        encrypted: true,
        kdf: bundle.kdf.name,
        kdf_iterations: bundle.kdf.iterations,
      },
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(bundle);
  } catch (error) {
    if (isSAMLDRBundleValidationError(error)) {
      return createSAMLDRBundleAdminErrorResponse(c, {
        operation: 'export',
        stage: getSAMLDRBundleFailureStage(error, failureStage),
        error,
        status: 400,
      });
    }
    log.error('Export SAML local signing DR bundle error', {}, error as Error);
    return createSAMLDRBundleAdminErrorResponse(c, {
      operation: 'export',
      stage: getSAMLDRBundleFailureStage(error, failureStage),
      error,
      status: 500,
    });
  }
}

export async function handleImportSAMLLocalSigningDRBundle(c: AdminSAMLContext): Promise<Response> {
  const log = getLogger(c).module('SAML');
  let failureStage: SAMLDRBundleFailureStage | 'authorize' | 'audit' | 'reload_settings' =
    'authorize';

  try {
    const forbidden = await requireSAMLAdminPermission(
      c,
      ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_DR_BUNDLE_IMPORT
    );
    if (forbidden) {
      return forbidden;
    }

    const body = (await c.req.json()) as { bundle?: unknown; passphrase?: unknown };
    const tenantId = resolveSAMLTenantIdFromContext(c);
    failureStage = 'decrypt_bundle';
    const result = await restoreEncryptedSAMLLocalSigningSecretDRBundle(
      c.env,
      tenantId,
      body.bundle,
      body.passphrase
    );

    failureStage = 'audit';
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.local_signing.dr_bundle.imported',
      resource: 'saml_settings',
      resourceId: tenantId,
      severity: 'warning',
      metadata: {
        imported_key_count: result.importedKeys,
        restored_roles: result.restoredRoles,
      },
    });

    failureStage = 'reload_settings';
    const settings = await getSAMLPublicSettings(c.env, tenantId);
    const entityIds = await getSAMLLocalEntityIds(c.env, tenantId);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      tenantId,
      ...settings,
      metadata: buildSAMLMetadataPublicationSettings(c.env),
      localSigning: {
        certificateSubject: settings.certificateSubject,
        certificateSubjectAlternativeNames: settings.certificateSubjectAlternativeNames,
        idpSigningKeyPolicy: settings.signingKeyPolicies.idp ?? {},
        spSigningKeyPolicy: settings.signingKeyPolicies.sp ?? {},
      },
      generated: {
        issuerUrl: entityIds.issuerUrl,
        idpEntityId: entityIds.idpEntityId,
        spEntityId: entityIds.spEntityId,
        idpMetadataUrl: entityIds.idpMetadataUrl,
        spMetadataUrl: entityIds.spMetadataUrl,
      },
      imported: result,
    });
  } catch (error) {
    if (isSAMLDRBundleValidationError(error)) {
      return createSAMLDRBundleAdminErrorResponse(c, {
        operation: 'import',
        stage: getSAMLDRBundleFailureStage(error, failureStage),
        error,
        status: 400,
      });
    }
    log.error('Import SAML local signing DR bundle error', {}, error as Error);
    return createSAMLDRBundleAdminErrorResponse(c, {
      operation: 'import',
      stage: getSAMLDRBundleFailureStage(error, failureStage),
      error,
      status: 500,
    });
  }
}

function isSAMLDRBundleValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('SAML DR bundle') ||
    error.message.includes('encrypted SAML DR bundle') ||
    error.message.includes('decrypt SAML DR bundle') ||
    error.message.includes('passphrase')
  );
}

function getSAMLDRBundleFailureStage(
  error: unknown,
  fallback: SAMLDRBundleFailureStage | 'authorize' | 'audit' | 'reload_settings'
): SAMLDRBundleFailureStage | 'authorize' | 'audit' | 'reload_settings' {
  return error instanceof SAMLDRBundleOperationError ? error.stage : fallback;
}

function createSAMLDRBundleAdminErrorResponse(
  c: AdminSAMLContext,
  input: {
    operation: 'export' | 'import';
    stage: SAMLDRBundleFailureStage | 'authorize' | 'audit' | 'reload_settings';
    error: unknown;
    status: 400 | 500;
  }
): Response {
  const code =
    input.status === 400 ? AR_ERROR_CODES.VALIDATION_INVALID_VALUE : AR_ERROR_CODES.INTERNAL_ERROR;
  const error = input.status === 400 ? 'invalid_request' : 'server_error';
  const description = [
    `SAML signing DR bundle ${input.operation} failed`,
    `stage=${formatSAMLDRBundleStage(input.stage)}`,
    `detail=${sanitizeSAMLDRBundleAdminErrorMessage(input.error)}`,
  ].join('; ');

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json(
    {
      error,
      error_description: description,
      error_code: code,
    },
    input.status
  );
}

function formatSAMLDRBundleStage(
  stage: SAMLDRBundleFailureStage | 'authorize' | 'audit' | 'reload_settings'
): string {
  return stage.replace(/_/g, ' ');
}

function sanitizeSAMLDRBundleAdminErrorMessage(error: unknown): string {
  const raw = error instanceof Error && error.message ? error.message : 'Unknown error';
  const redacted = raw
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted PEM]')
    .replace(
      /\b(privateKeyPem|privatePEM|passphrase|payload|bundle)\b\s*[:=]\s*\S+/gi,
      '$1=[redacted]'
    )
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(0, 280) || 'Unknown error';
}

interface SAMLMetadataPreviewRequest extends MetadataImportRequest {
  samlProfile?: SAMLSPProfile;
  attributePresetId?: SAMLAttributePresetId;
}

interface NormalizedSAMLFederationTrustPayload {
  description?: string;
  metadataUrlPatterns?: string[];
  certificates?: SAMLFederationTrustProfile['certificates'];
  policy?: 'strict' | 'warn' | 'disabled';
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
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.attribute_preset.created',
      resource: 'saml_attribute_preset',
      resourceId: id,
      metadata: {
        label: preset.label,
        profile: preset.profile,
        attribute_count: attributes.length,
      },
    });

    return c.json({ preset }, 201);
  } catch (error) {
    await recordSAMLAdminFailure(c, {
      action: 'saml.attribute_preset.created',
      resource: 'saml_attribute_preset',
      resourceId: 'unknown',
      error,
    });
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
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.attribute_preset.deleted',
      resource: 'saml_attribute_preset',
      resourceId: id,
      severity: 'warning',
    });

    return c.json({ success: true });
  } catch (error) {
    await recordSAMLAdminFailure(c, {
      action: 'saml.attribute_preset.deleted',
      resource: 'saml_attribute_preset',
      resourceId: id ?? 'unknown',
      error,
    });
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
        ? normalizeSAMLSPConfig(config as SAMLSPConfig)
        : normalizeSAMLIdPJitLinkingPolicyConfig(config as SAMLIdPConfig);
    if (isResponseValidationError(normalizedConfig)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: normalizedConfig.field },
      });
    }
    const normalizedConfigWithValidation =
      await withProviderCertificateValidation(normalizedConfig);
    const providerEnabled =
      body.enabled !== false &&
      normalizedConfigWithValidation.certificateValidation?.allExpired !== true;
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
        JSON.stringify(normalizedConfigWithValidation),
        providerEnabled ? 1 : 0,
        now,
        now,
      ]
    );
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.provider.created',
      resource: body.providerType,
      resourceId: id,
      metadata: {
        name: body.name,
        provider_type: body.providerType,
        enabled: providerEnabled,
        metadata_imported: hasMetadataInput,
        disabled_due_to_expired_certificate:
          body.enabled !== false && !providerEnabled ? true : undefined,
      },
    });
    await invalidateAuthenticationMethodsCacheForSAML(c.env, tenantId, 'saml.provider.created', c);

    return c.json(
      {
        id,
        name: body.name,
        providerType: body.providerType,
        config: normalizedConfigWithValidation,
        enabled: providerEnabled,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
      201
    );
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      await recordSAMLAdminFailure(c, {
        action: 'saml.provider.created',
        resource: 'saml_provider',
        resourceId: 'unknown',
        error,
      });
      log.warn('Create provider metadata validation failed', {}, error);
      return createSAMLMetadataValidationErrorResponse(c, error);
    }

    await recordSAMLAdminFailure(c, {
      action: 'saml.provider.created',
      resource: 'saml_provider',
      resourceId: 'unknown',
      error,
    });
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
      config: await withProviderCertificateValidation(JSON.parse(provider.config_json)),
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
        ? normalizeSAMLSPConfig(mergedConfig as SAMLSPConfig)
        : normalizeSAMLIdPJitLinkingPolicyConfig(mergedConfig as SAMLIdPConfig);
    if (isResponseValidationError(newConfig)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: newConfig.field },
      });
    }
    const newConfigWithValidation = await withProviderCertificateValidation(newConfig);
    const requestedEnabled = body.enabled !== undefined ? body.enabled : existing.enabled === 1;
    const nextEnabled =
      requestedEnabled && newConfigWithValidation.certificateValidation?.allExpired !== true;
    const now = Date.now();

    await coreAdapter.execute(
      `UPDATE identity_providers
       SET name = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        body.name || existing.name,
        JSON.stringify(newConfigWithValidation),
        nextEnabled ? 1 : 0,
        now,
        id,
        tenantId,
      ]
    );
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.provider.updated',
      resource: existing.provider_type ?? 'saml_provider',
      resourceId: id ?? 'unknown',
      metadata: {
        previous_name: existing.name,
        next_name: body.name || existing.name,
        enabled_changed: nextEnabled !== (existing.enabled === 1),
        config_updated: !!body.config,
        disabled_due_to_expired_certificate: requestedEnabled && !nextEnabled ? true : undefined,
      },
    });
    await invalidateAuthenticationMethodsCacheForSAML(c.env, tenantId, 'saml.provider.updated', c);

    return c.json({
      id,
      name: body.name || existing.name,
      providerType: existing.provider_type,
      config: newConfigWithValidation,
      enabled: nextEnabled,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    await recordSAMLAdminFailure(c, {
      action: 'saml.provider.updated',
      resource: 'saml_provider',
      resourceId: id ?? 'unknown',
      error,
    });
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
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.provider.deleted',
      resource: 'saml_provider',
      resourceId: id ?? 'unknown',
      severity: 'warning',
    });
    await invalidateAuthenticationMethodsCacheForSAML(c.env, tenantId, 'saml.provider.deleted', c);

    return c.json({ success: true });
  } catch (error) {
    await recordSAMLAdminFailure(c, {
      action: 'saml.provider.deleted',
      resource: 'saml_provider',
      resourceId: id ?? 'unknown',
      error,
    });
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
      enabled: number;
    }>(
      `SELECT id, provider_type, config_json, enabled
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
    let currentAnalysis: SAMLMetadataAnalysis;
    try {
      currentAnalysis = analyzeSAMLMetadata(resolvedMetadata.metadataXml);
    } catch (error) {
      throw toSAMLMetadataValidationError(error);
    }
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
    const mergedConfig = await withProviderCertificateValidation({
      ...existingConfig,
      ...newConfig,
      metadataXml: resolvedMetadata.metadataXml,
      ...(metadataUrl ? { metadataUrl } : {}),
      metadataHash: currentAnalysis.hash,
      metadataCriticalFields: currentAnalysis.criticalFields,
      metadataRefreshStatus: refreshStatus,
      metadataLastFetched: Date.now(),
    });
    const nextEnabled =
      existing.enabled === 1 && mergedConfig.certificateValidation?.allExpired !== true;

    const now = Date.now();

    await coreAdapter.execute(
      'UPDATE identity_providers SET config_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(mergedConfig), nextEnabled ? 1 : 0, now, id, tenantId]
    );
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.provider.metadata_imported',
      resource: existing.provider_type ?? 'saml_provider',
      resourceId: id ?? 'unknown',
      metadata: {
        metadata_url_present: !!metadataUrl,
        metadata_hash: currentAnalysis.hash,
        changed: refreshStatus.diff.changed,
        disabled_due_to_expired_certificate:
          existing.enabled === 1 && !nextEnabled ? true : undefined,
      },
    });
    await invalidateAuthenticationMethodsCacheForSAML(
      c.env,
      tenantId,
      'saml.provider.metadata_imported',
      c
    );

    return c.json({
      success: true,
      config: mergedConfig,
      enabled: nextEnabled,
      metadataRefreshStatus: refreshStatus,
    });
  } catch (error) {
    if (error instanceof SAMLMetadataValidationError) {
      await recordSAMLAdminFailure(c, {
        action: 'saml.provider.metadata_imported',
        resource: 'saml_provider',
        resourceId: id ?? 'unknown',
        error,
      });
      log.warn('Import metadata validation failed', { providerId: id }, error);
      return createSAMLMetadataValidationErrorResponse(c, error);
    }

    await recordSAMLAdminFailure(c, {
      action: 'saml.provider.metadata_imported',
      resource: 'saml_provider',
      resourceId: id ?? 'unknown',
      error,
    });
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
      enabled: number;
    }>(
      `SELECT id, provider_type, config_json, enabled
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
    let currentAnalysis: SAMLMetadataAnalysis;
    try {
      currentAnalysis = analyzeSAMLMetadata(metadataXml);
    } catch (error) {
      throw toSAMLMetadataValidationError(error);
    }
    const refreshStatus = buildSAMLMetadataRefreshStatus(previousAnalysis, currentAnalysis);
    const now = Date.now();

    if (refreshStatus.diff.expired) {
      const expiredConfig = await withProviderCertificateValidation({
        ...existingConfig,
        metadataXml,
        metadataUrl,
        metadataHash: currentAnalysis.hash,
        metadataCriticalFields: currentAnalysis.criticalFields,
        metadataRefreshStatus: refreshStatus,
        metadataLastFetched: now,
        ...(aggregateImport ? { aggregateImport } : {}),
      });
      const nextEnabled =
        existing.enabled === 1 && expiredConfig.certificateValidation?.allExpired !== true;

      await coreAdapter.execute(
        'UPDATE identity_providers SET config_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        [JSON.stringify(expiredConfig), nextEnabled ? 1 : 0, now, id, tenantId]
      );

      await createSAMLMetadataRefreshAudit(c, {
        tenantId,
        providerId: id,
        providerType: existing.provider_type,
        refreshStatus,
      });
      await invalidateAuthenticationMethodsCacheForSAML(
        c.env,
        tenantId,
        'saml.provider.metadata_refreshed',
        c
      );

      return c.json({
        success: true,
        changed: refreshStatus.diff.changed,
        expired: true,
        config: expiredConfig,
        enabled: nextEnabled,
        metadataRefreshStatus: refreshStatus,
      });
    }

    const profile =
      existing.provider_type === 'saml_sp'
        ? (existingConfig as SAMLSPConfig).samlProfile
        : undefined;
    const refreshedConfig = buildConfigFromMetadata(existing.provider_type, metadataXml, profile);
    const mergedConfig = await withProviderCertificateValidation({
      ...existingConfig,
      ...refreshedConfig,
      metadataXml,
      metadataUrl,
      metadataHash: currentAnalysis.hash,
      metadataCriticalFields: currentAnalysis.criticalFields,
      metadataRefreshStatus: refreshStatus,
      metadataLastFetched: now,
      ...(aggregateImport ? { aggregateImport } : {}),
    });
    const nextEnabled =
      existing.enabled === 1 && mergedConfig.certificateValidation?.allExpired !== true;

    await coreAdapter.execute(
      'UPDATE identity_providers SET config_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(mergedConfig), nextEnabled ? 1 : 0, now, id, tenantId]
    );

    await createSAMLMetadataRefreshAudit(c, {
      tenantId,
      providerId: id,
      providerType: existing.provider_type,
      refreshStatus,
    });
    await invalidateAuthenticationMethodsCacheForSAML(
      c.env,
      tenantId,
      'saml.provider.metadata_refreshed',
      c
    );

    return c.json({
      success: true,
      changed: refreshStatus.diff.changed,
      config: mergedConfig,
      enabled: nextEnabled,
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

export async function handlePreviewFederationTrustCertificate(
  c: AdminSAMLContext
): Promise<Response> {
  try {
    const forbidden = await requireSAMLAdminPermission(c, ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE);
    if (forbidden) return forbidden;

    const body = (await c.req.json()) as { certificate?: string; certificateUrl?: string };
    const certificateUrl = body.certificateUrl?.trim();
    const certificate = body.certificate?.trim();

    if (!certificateUrl && !certificate) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'certificateUrl or certificate' },
      });
    }

    if (certificateUrl) {
      const ssrfError = validateExternalUrl(certificateUrl, {
        requireHttps: true,
        allowLocalhost: false,
        errorType: 'invalid_request',
        fieldName: 'certificateUrl',
      });
      if (ssrfError) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      const response = await safeFetch(certificateUrl, {
        timeoutMs: 10000,
        maxResponseSize: 64 * 1024,
        headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert, text/plain, */*' },
      });
      if (!response.ok) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      const bytes = await readResponseBytesWithLimit(response, 64 * 1024);
      return c.json(await previewTrustCertificate(bytes, 'url'));
    }

    return c.json(await previewTrustCertificate(certificate!, 'pem'));
  } catch (error) {
    const message =
      error instanceof SAMLMetadataValidationError
        ? error.message
        : 'Failed to preview federation trust certificate';
    return c.json(
      {
        error: 'invalid_request',
        error_description: message,
      },
      400
    );
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
    await createSAMLAdminAudit(c, {
      tenantId,
      action: 'saml.signing_policy.updated',
      resource: existing.provider_type ?? 'saml_provider',
      resourceId: id ?? 'unknown',
      severity: 'warning',
      metadata: {
        role,
        has_active_kid: !!signingKeyPolicy.active?.kid,
        has_next_kid: !!signingKeyPolicy.next?.kid,
        backup_count: signingKeyPolicy.backup ? 1 : 0,
      },
    });

    return c.json({
      success: true,
      config: updatedConfig,
      signingKeyPolicy,
      updatedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    await recordSAMLAdminFailure(c, {
      action: 'saml.signing_policy.updated',
      resource: 'saml_provider',
      resourceId: id ?? 'unknown',
      error,
    });
    log.error('Update SAML signing policy error', { providerId: id }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

function buildConfigFromMetadata(
  providerType: string,
  metadataXml: string,
  profile?: SAMLSPProfile,
  _attributePresetId?: SAMLAttributePresetId
): SAMLIdPConfig | SAMLSPConfig {
  if (providerType === 'saml_idp') {
    return parseIdPMetadata(metadataXml);
  }

  return applySAMLSPProfileDefaults(parseSPMetadata(metadataXml, profile), profile);
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

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new SAMLMetadataValidationError('Certificate response exceeds size limit');
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new SAMLMetadataValidationError('Certificate response exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

async function createSAMLAdminAudit(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    action: string;
    resource: string;
    resourceId: string;
    result?: 'success' | 'failure';
    severity?: 'info' | 'warning' | 'critical';
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const auth = (c as unknown as AdminSAMLAuthContext).get('adminAuth');
  await createAuditLog(c.env, {
    tenantId: input.tenantId,
    userId: auth?.userId ?? 'saml-admin',
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId,
    ipAddress: getRequestIp(c),
    userAgent: c.req.header('User-Agent') || 'unknown',
    metadata: JSON.stringify({
      protocol: 'saml',
      ...(input.metadata ?? {}),
    }),
    severity: input.severity ?? (input.result === 'failure' ? 'warning' : 'info'),
  });
}

async function recordSAMLAdminFailure(
  c: Context<{ Bindings: Env }>,
  input: {
    action: string;
    resource: string;
    resourceId: string;
    error: unknown;
  }
): Promise<void> {
  try {
    await createSAMLAdminAudit(c, {
      tenantId: resolveSAMLTenantIdFromContext(c),
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId,
      result: 'failure',
      severity: 'warning',
      metadata: {
        error_class: input.error instanceof Error ? input.error.name : 'unknown_error',
      },
    });
  } catch {
    // Best-effort audit mirror must not mask the original SAML admin error.
  }
}

function getRequestIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown'
  );
}

async function listFederationTrustProfiles(
  env: Env,
  tenantId: string
): Promise<SAMLFederationTrustProfile[]> {
  return listNormalizedSamlFederationTrustProfiles(env, tenantId);
}

async function listNormalizedSamlFederationTrustProfiles(
  env: Env,
  tenantId: string
): Promise<SAMLFederationTrustProfile[]> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-trust');
  const rows = await adapter.query<{
    id: string;
    tenant_id: string;
    source_type: string;
    display_name: string;
    lifecycle_state: string;
    protocol_payload_json: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT id, tenant_id, source_type, display_name, lifecycle_state, protocol_payload_json,
            created_at, updated_at
       FROM federation_trust_sources
       WHERE tenant_id = ?
         AND source_type IN ('saml_aggregate', 'saml_metadata', 'saml_federation')
         AND lifecycle_state IN ('active', 'draft')
       ORDER BY display_name ASC`,
    [tenantId]
  );

  return rows.flatMap((row) => {
    const payload = parseNormalizedSamlFederationPayload(row.protocol_payload_json);
    if (payload.metadataUrlPatterns.length === 0 || payload.certificates.length === 0) {
      return [];
    }
    return [
      {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.display_name,
        description: payload.description,
        metadataUrlPatterns: payload.metadataUrlPatterns,
        certificates: payload.certificates,
        policy: payload.policy,
        enabled: row.lifecycle_state === 'active',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ];
  });
}

function parseNormalizedSamlFederationPayload(
  value: string | null
): Required<NormalizedSAMLFederationTrustPayload> {
  const parsed = value ? (JSON.parse(value) as NormalizedSAMLFederationTrustPayload) : {};
  return {
    description: typeof parsed.description === 'string' ? parsed.description : '',
    metadataUrlPatterns: Array.isArray(parsed.metadataUrlPatterns)
      ? parsed.metadataUrlPatterns.filter(
          (pattern): pattern is string => typeof pattern === 'string'
        )
      : [],
    certificates: Array.isArray(parsed.certificates)
      ? parsed.certificates.filter(isSamlFederationTrustCertificate)
      : [],
    policy: normalizeFederationTrustPolicy(parsed.policy) ?? 'warn',
  };
}

function normalizeFederationTrustPolicy(value: unknown): SAMLFederationTrustProfile['policy'] {
  return value === 'strict' || value === 'warn' || value === 'disabled' ? value : undefined;
}

async function hashStableJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        sorted[key] = sortForStableJson(item);
      }
      return sorted;
    }, {});
}

function isSamlFederationTrustCertificate(
  value: unknown
): value is SAMLFederationTrustProfile['certificates'][number] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const certificate = value as Partial<SAMLFederationTrustProfile['certificates'][number]>;
  return (
    typeof certificate.id === 'string' &&
    typeof certificate.certificate === 'string' &&
    typeof certificate.fingerprintSha256 === 'string' &&
    typeof certificate.createdAt === 'number'
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

    let successfulImports = 0;
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
        const normalizedConfig = await withProviderCertificateValidation({
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
        } as SAMLIdPConfig | SAMLSPConfig);
        const providerEnabled =
          input.enabled && normalizedConfig.certificateValidation?.allExpired !== true;
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
            providerEnabled ? 1 : 0,
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
        await recordFederationSelectedEntityImportEvent(env, {
          tenantId: input.tenantId,
          trustSourceId: preview.verification.trustProfileId,
          providerId,
          importAction: 'create_provider',
          outcome: 'success',
          reasonCodes: ['federation.selected_entity.imported'],
        });
        existingEntityKeys.add(entityKey);
        successfulImports += 1;
      } catch (error) {
        await recordAggregateBatchResult(env, input.batchId, {
          entityId,
          success: false,
          error: error instanceof Error ? error.message : 'Import failed',
        });
        await recordFederationSelectedEntityImportEvent(env, {
          tenantId: input.tenantId,
          trustSourceId: preview.verification.trustProfileId,
          importAction: 'create_provider',
          outcome: 'failed',
          reasonCodes: ['federation.selected_entity.import_failed'],
        });
      }
    }

    if (successfulImports > 0) {
      await invalidateAuthenticationMethodsCacheForSAML(
        env,
        input.tenantId,
        'saml.provider.aggregate_batch_created'
      );
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

async function recordFederationSelectedEntityImportEvent(
  env: Env,
  input: {
    tenantId: string;
    trustSourceId?: string;
    providerId?: string;
    importAction: string;
    outcome: string;
    reasonCodes: string[];
  }
): Promise<void> {
  if (!input.trustSourceId) {
    return;
  }
  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-trust');
    await adapter.execute(
      `INSERT INTO federation_selected_entity_import_events (
        id, tenant_id, trust_source_id, metadata_entity_summary_id, provider_id,
        import_action, outcome, reason_codes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.tenantId,
        input.trustSourceId,
        null,
        input.providerId ?? null,
        input.importAction,
        input.outcome,
        stableJson(input.reasonCodes),
        Date.now(),
      ]
    );
  } catch {
    // Best-effort operational evidence must not fail the provider import itself.
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
  const certificates: string[] = [];

  for (const kd of keyDescriptors) {
    const use = getAttribute(kd, 'use');
    if (use === 'signing' || !use) {
      const x509Cert = findElement(kd, SAML_NAMESPACES.DS, 'X509Certificate');
      if (x509Cert) {
        const certText = getTextContent(x509Cert)?.replace(/\s+/g, '') || '';
        certificates.push(`-----BEGIN CERTIFICATE-----\n${certText}\n-----END CERTIFICATE-----`);
      }
    }
  }

  const deduplicatedCertificates = [...new Set(certificates)];
  const certificate = deduplicatedCertificates[0] || '';

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
    certificates: deduplicatedCertificates,
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
      if (!acsUrl || isDefault === 'true' || !allowedBindings.has('post')) {
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
  const metadataNameIdFormats = parseMetadataNameIDFormats(spDescriptor);
  const nameIdFormat = metadataNameIdFormats[0] ?? NAMEID_FORMATS.EMAIL;
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
    metadataNameIdFormats: metadataNameIdFormats.length > 0 ? metadataNameIdFormats : undefined,
    attributeMapping: {},
    metadataRequestedAttributes:
      metadataRequestedAttributes.length > 0 ? metadataRequestedAttributes : undefined,
    metadataAttributeReleasePolicySuggestion,
    signAssertions: wantAssertionsSigned,
    signResponses: true,
    allowedBindings: Array.from(allowedBindings),
  };
}

function parseMetadataNameIDFormats(descriptor: Element): NameIDFormat[] {
  return Array.from(
    new Set(
      findElements(descriptor, SAML_NAMESPACES.MD, 'NameIDFormat')
        .map((element) => getTextContent(element)?.trim())
        .filter((value): value is NameIDFormat => Boolean(value))
    )
  );
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
