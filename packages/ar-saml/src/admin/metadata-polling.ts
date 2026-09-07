import type {
  DatabaseAdapter,
  Env,
  PreparedStatement,
  SAMLIdPConfig,
  SAMLMetadataAggregateImportSnapshot,
  SAMLMetadataEntitySummary,
  SAMLMetadataRefreshPolicy,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import {
  bumpAuthenticationMethodsCacheRevision,
  createAuditLog,
  createLogger,
  getDefaultTenantId,
  listEnvironmentTenantDefaultStores,
  readResponseTextWithLimit,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  safeFetch,
} from '@authrim/ar-lib-core';
import {
  AGGREGATE_METADATA_FETCH_LIMIT_BYTES,
  SINGLE_METADATA_FETCH_LIMIT_BYTES,
  extractEntityDescriptorXmls,
  isAggregateMetadata,
  verifyAggregateMetadata,
} from './aggregate-metadata';
import {
  isSAMLMetadataRefreshDue,
  markSAMLMetadataRefreshFailure,
  markSAMLMetadataRefreshSuccess,
  normalizeSAMLMetadataRefreshPolicy,
} from './metadata-refresh';
import { listFederationTrustProfiles, refreshSAMLProviderConfigFromMetadata } from './providers';

const log = createLogger().module('SAML-METADATA-POLLING');
const TENANT_CURSOR_KEY = 'saml_metadata_polling:tenant_cursor';
const FEDERATION_CURSOR_KEY = 'saml_metadata_polling:federation_cursor';
const PROVIDER_CURSOR_KEY_PREFIX = 'saml_metadata_polling:provider_cursor:';
const TENANT_BATCH_SIZE = 25;
const MAX_FEDERATION_SOURCES_PER_RUN = 10;
const MAX_FEDERATION_PROVIDER_ROWS_PER_REFRESH = 25;
const MAX_INDIVIDUAL_SOURCES_PER_RUN = 25;
const MAX_ENTITY_SUMMARY_BATCH_BYTES = 512 * 1024;
const MAX_ENTITY_SUMMARIES_PER_BATCH = 500;
const MAX_RUNTIME_ENTITY_METADATA_BYTES = 384 * 1024;
const MAX_RUNTIME_ENTITY_BATCH_BYTES = 512 * 1024;
const MAX_RUNTIME_ENTITIES_PER_BATCH = 250;
const SAML_RUNTIME_DOCUMENT_TYPE = 'saml_aggregate_runtime_snapshot';
const MAX_RETAINED_FEDERATION_DOCUMENTS_PER_SOURCE = 8;
const MAX_RETAINED_FEDERATION_VALIDATION_EVENTS_PER_SOURCE = 128;
const MAX_RETAINED_FEDERATION_REFRESH_JOBS_PER_SOURCE = 64;
const FEDERATION_REFRESH_LEASE_MS = 30 * 60 * 1000;

interface ProviderRow {
  id: string;
  provider_type: 'saml_idp' | 'saml_sp';
  config_json: string;
  enabled: number;
  updated_at: number;
}

interface FederationSourcePayload {
  metadataUrl?: string;
  metadataUrlPatterns?: string[];
  policy?: 'strict' | 'warn' | 'disabled';
  polling?: SAMLMetadataRefreshPolicy;
  [key: string]: unknown;
}

interface FederationSourceRow {
  id: string;
  tenant_id: string;
  source_type: string;
  protocol_payload_json: string | null;
  updated_at: number;
  trust_context_snapshot_hash: string;
  active_metadata_document_id: string | null;
}

interface FetchedMetadataDocument {
  status: 'modified' | 'not_modified';
  xml?: string;
  etag?: string;
  lastModified?: string;
}

interface FederationRuntimeEntityRecord {
  entityId: string;
  role: 'saml_idp' | 'saml_sp' | 'ambiguous';
  metadataXml: string;
  entityCategories?: string[];
  entityCategorySupport?: string[];
  registrationAuthority?: string;
  validUntil?: string;
}

interface FederationProviderPage {
  rows: ProviderRow[];
  nextCursor?: string;
}

export interface SAMLMetadataPollingResult {
  federationSourcesProcessed: number;
  federationSourcesFailed: number;
  individualProvidersProcessed: number;
  individualProvidersFailed: number;
  tenantsProcessed: number;
}

export interface FederationMetadataRefreshResult {
  sourceId: string;
  changed: boolean;
  entityCount: number;
  providersUpdated: number;
  providersMissing: number;
  providersFailed: number;
  verificationStatus: string;
}

function parseConfig(row: ProviderRow): SAMLIdPConfig | SAMLSPConfig {
  return JSON.parse(row.config_json) as SAMLIdPConfig | SAMLSPConfig;
}

function getFederationTrustSourceId(config: SAMLIdPConfig | SAMLSPConfig): string | undefined {
  return (
    config.aggregateImport?.federationTrustProfileId ??
    config.aggregateImport?.verification.trustProfileId
  );
}

function parseFederationSourcePayload(value: string | null): FederationSourcePayload {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as FederationSourcePayload;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveFederationSourceMetadataUrl(
  payload: FederationSourcePayload
): string | null {
  if (typeof payload.metadataUrl === 'string' && payload.metadataUrl.trim()) {
    return payload.metadataUrl.trim();
  }
  const exactPatterns = (payload.metadataUrlPatterns ?? []).filter(
    (pattern): pattern is string =>
      typeof pattern === 'string' && /^https:\/\//i.test(pattern.trim()) && !pattern.includes('*')
  );
  return exactPatterns.length === 1 ? exactPatterns[0].trim() : null;
}

async function fetchMetadataDocument(
  metadataUrl: string,
  policy: SAMLMetadataRefreshPolicy | undefined,
  maxResponseSize: number,
  useConditionalRequest = true
): Promise<FetchedMetadataDocument> {
  const headers = new Headers({
    Accept: 'application/samlmetadata+xml, application/xml, text/xml',
  });
  if (useConditionalRequest && policy?.validatorSourceUrl === metadataUrl) {
    if (policy.etag) headers.set('If-None-Match', policy.etag);
    if (policy.lastModified) headers.set('If-Modified-Since', policy.lastModified);
  }
  const conditionalRequestSent = headers.has('If-None-Match') || headers.has('If-Modified-Since');
  const response = await safeFetch(metadataUrl, {
    method: 'GET',
    headers,
    timeoutMs: 10000,
    maxResponseSize,
  });
  if (response.status === 304) {
    if (!conditionalRequestSent) throw new Error('metadata_unexpected_not_modified');
    return {
      status: 'not_modified',
      etag: response.headers.get('ETag') ?? policy?.etag,
      lastModified: response.headers.get('Last-Modified') ?? policy?.lastModified,
    };
  }
  if (!response.ok) throw new Error(`metadata_http_${response.status}`);
  return {
    status: 'modified',
    xml: await readResponseTextWithLimit(response, maxResponseSize),
    etag: response.headers.get('ETag') ?? undefined,
    lastModified: response.headers.get('Last-Modified') ?? undefined,
  };
}

function withHttpValidators(
  policy: SAMLMetadataRefreshPolicy,
  fetched: FetchedMetadataDocument,
  metadataUrl: string,
  acceptedValidUntil?: string
): SAMLMetadataRefreshPolicy {
  return {
    ...policy,
    // A modified 200 response without a validator invalidates the previously stored validator.
    // The 304 path already copies the request validators into `fetched` above.
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    validatorSourceUrl: metadataUrl,
    acceptedValidUntil,
  };
}

function isAcceptedMetadataExpired(validUntil: string | undefined, now: number): boolean {
  if (!validUntil) return false;
  const expiresAt = Date.parse(validUntil);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function areAllProviderCertificatesExpired(
  config: SAMLIdPConfig | SAMLSPConfig,
  now: number
): boolean {
  const certificates = config.certificateValidation?.certificates ?? [];
  return (
    certificates.length > 0 &&
    certificates.every((certificate) => {
      if (!certificate.validTo) return certificate.expired;
      const validTo = Date.parse(certificate.validTo);
      return Number.isFinite(validTo) ? validTo <= now : certificate.expired;
    })
  );
}

function stableFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'metadata_refresh_failed';
  if (message.includes('entityID changed')) return 'entity_id_change_pending';
  if (message.includes('expired validUntil') || message.includes('metadata_expired')) {
    return 'metadata_expired';
  }
  if (message.includes('metadata_certificates_expired')) {
    return 'metadata_certificates_expired';
  }
  if (message.includes('signature') || message.includes('trust profile')) {
    return 'metadata_verification_failed';
  }
  if (message.includes('does not contain entityID')) return 'federation_entity_missing';
  if (message.includes('metadata_refresh_conflict')) return 'metadata_refresh_conflict';
  if (message.includes('metadata_refresh_superseded')) return 'metadata_refresh_superseded';
  if (message.includes('federation_trust_context_changed')) {
    return 'federation_trust_context_changed';
  }
  if (message.startsWith('metadata_http_')) return message.slice(0, 64);
  return 'metadata_refresh_failed';
}

function sourceStateForFailure(
  code: string
): NonNullable<SAMLMetadataRefreshPolicy['sourceState']> {
  if (code === 'metadata_expired' || code === 'metadata_certificates_expired') return 'expired';
  if (code === 'federation_entity_missing' || code === 'federation_source_missing')
    return 'missing';
  if (code === 'entity_id_change_pending') return 'identity_change_pending';
  return 'error';
}

async function recordAutomaticProviderRefreshAudit(
  env: Env,
  tenantId: string,
  providerId: string,
  metadataUrl: string,
  input: { changed?: boolean; errorCode?: string; expired?: boolean }
): Promise<void> {
  try {
    await createAuditLog(env, {
      tenantId,
      userId: 'saml-metadata-scheduler',
      action: input.errorCode
        ? 'saml.provider.metadata_refresh_failed'
        : 'saml.provider.metadata_refreshed',
      resource: 'saml_provider',
      resourceId: providerId,
      ipAddress: 'automatic',
      userAgent: 'authrim-saml-metadata-polling',
      severity: input.errorCode || input.expired ? 'warning' : 'info',
      metadata: JSON.stringify({
        changed: input.changed,
        expired: input.expired,
        error_code: input.errorCode,
        source_url: metadataUrl,
      }),
    });
  } catch (error) {
    log.warn('Individual SAML metadata polling audit failed', {
      providerId,
      tenantId,
      errorCode: stableFailureCode(error),
    });
  }
}

async function updateProviderFailure(
  adapter: DatabaseAdapter,
  tenantId: string,
  row: ProviderRow,
  config: SAMLIdPConfig | SAMLSPConfig,
  metadataUrl: string,
  code: string,
  now: number
): Promise<boolean> {
  const writeTime = Math.max(now, row.updated_at + 1);
  const failureBase =
    code === 'federation_entity_missing' &&
    config.metadataRefreshPolicy &&
    config.metadataRefreshPolicy?.lastErrorCode !== 'federation_entity_missing'
      ? { ...config.metadataRefreshPolicy, consecutiveFailures: 0 }
      : config.metadataRefreshPolicy;
  const policy = markSAMLMetadataRefreshFailure(
    failureBase,
    metadataUrl,
    code,
    sourceStateForFailure(code),
    writeTime
  );
  const disableForConfirmedRemoval =
    code === 'federation_source_missing' ||
    (code === 'federation_entity_missing' && (policy.consecutiveFailures ?? 0) >= 2);
  const disableForExpiredCertificates = code === 'metadata_certificates_expired';
  const disableForExpiredMetadata = code === 'metadata_expired';
  const disableForMetadataLifecycle =
    disableForConfirmedRemoval || disableForExpiredCertificates || disableForExpiredMetadata;
  const persistedPolicy = {
    ...policy,
    ...((disableForMetadataLifecycle && row.enabled === 1) ||
    config.metadataRefreshPolicy?.suspendedByMetadataSync === true
      ? { suspendedByMetadataSync: true }
      : {}),
  };
  const result = await adapter.execute(
    `UPDATE identity_providers
        SET config_json = ?, enabled = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND updated_at = ?`,
    [
      JSON.stringify({ ...config, metadataRefreshPolicy: persistedPolicy }),
      disableForMetadataLifecycle ? 0 : row.enabled,
      writeTime,
      row.id,
      tenantId,
      row.updated_at,
    ]
  );
  if (result.rowsAffected !== 1) throw new Error('metadata_refresh_conflict');
  return disableForMetadataLifecycle;
}

interface ProviderMetadataApplyResult {
  changed: boolean;
  accepted: boolean;
  expired: boolean;
}

async function applyEntityMetadataToProvider(
  adapter: DatabaseAdapter,
  tenantId: string,
  row: ProviderRow,
  metadataXml: string,
  metadataUrl: string,
  now: number,
  fetched: FetchedMetadataDocument,
  aggregateImport?: SAMLIdPConfig['aggregateImport']
): Promise<ProviderMetadataApplyResult> {
  const writeTime = Math.max(now, row.updated_at + 1);
  const existingConfig = parseConfig(row);
  const result = await refreshSAMLProviderConfigFromMetadata({
    providerType: row.provider_type,
    existingConfig,
    metadataXml,
    metadataUrl,
    now: writeTime,
    allowEntityIdChange: false,
    aggregateImport,
  });
  const certificatesExpired = result.config.certificateValidation?.allExpired === true;
  const rejected = result.expired || certificatesExpired;
  let persistedConfig = result.config;
  const restoreMetadataSuspension =
    existingConfig.metadataRefreshPolicy?.suspendedByMetadataSync === true;
  if (rejected) {
    const failureCode = certificatesExpired ? 'metadata_certificates_expired' : 'metadata_expired';
    persistedConfig = {
      ...existingConfig,
      metadataRefreshStatus: result.metadataRefreshStatus,
      metadataRefreshPolicy: {
        ...markSAMLMetadataRefreshFailure(
          existingConfig.metadataRefreshPolicy,
          metadataUrl,
          failureCode,
          'expired',
          writeTime
        ),
        ...(row.enabled === 1 || restoreMetadataSuspension
          ? { suspendedByMetadataSync: true }
          : {}),
      },
    };
  }
  if (!rejected) {
    persistedConfig.metadataRefreshPolicy = {
      ...withHttpValidators(
        normalizeSAMLMetadataRefreshPolicy(
          persistedConfig.metadataRefreshPolicy,
          persistedConfig.metadataUrl,
          writeTime
        ),
        fetched,
        metadataUrl,
        result.metadataRefreshStatus.current.validUntil
      ),
      suspendedByMetadataSync: undefined,
    };
  }
  const nextEnabled = !rejected && (row.enabled === 1 || restoreMetadataSuspension);
  const update = await adapter.execute(
    `UPDATE identity_providers
        SET config_json = ?, enabled = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND updated_at = ?`,
    [
      JSON.stringify(persistedConfig),
      nextEnabled ? 1 : 0,
      writeTime,
      row.id,
      tenantId,
      row.updated_at,
    ]
  );
  if (update.rowsAffected !== 1) throw new Error('metadata_refresh_conflict');
  return { changed: result.changed, accepted: !rejected, expired: rejected };
}

async function updateFederationSourcePollingState(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  _payload: FederationSourcePayload,
  polling: SAMLMetadataRefreshPolicy,
  now: number,
  operationToken: string,
  activeDocumentId?: string
): Promise<void> {
  const nextUpdatedAt = Math.max(now, source.updated_at + 1);
  const update = await admin.execute(
    `UPDATE federation_trust_sources
        SET protocol_payload_json = json_set(
              COALESCE(protocol_payload_json, '{}'),
              '$.polling', json(?)
            ),
            active_metadata_document_id = COALESCE(?, active_metadata_document_id),
            refresh_operation_token = NULL,
            refresh_operation_expires_at = NULL,
            updated_at = ?
      WHERE id = ? AND tenant_id = ?
        AND updated_at = ?
        AND refresh_operation_token = ?
        AND COALESCE(
              CAST(json_extract(protocol_payload_json, '$.polling.lastAttemptAt') AS INTEGER),
              0
            ) <= ?`,
    [
      JSON.stringify(polling),
      activeDocumentId ?? null,
      nextUpdatedAt,
      source.id,
      source.tenant_id,
      source.updated_at,
      operationToken,
      now,
    ]
  );
  if (update.rowsAffected !== 1) throw new Error('metadata_refresh_conflict');
  source.updated_at = nextUpdatedAt;
  if (activeDocumentId) source.active_metadata_document_id = activeDocumentId;
}

async function claimFederationRefreshLease(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  operationToken: string,
  now: number
): Promise<void> {
  const claimedUpdatedAt = Math.max(now, source.updated_at + 1);
  const claim = await admin.execute(
    `UPDATE federation_trust_sources
        SET refresh_operation_token = ?, refresh_operation_expires_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND updated_at = ?
        AND (refresh_operation_token IS NULL OR refresh_operation_expires_at <= ?)`,
    [
      operationToken,
      now + FEDERATION_REFRESH_LEASE_MS,
      claimedUpdatedAt,
      source.id,
      source.tenant_id,
      source.updated_at,
      now,
    ]
  );
  if (claim.rowsAffected !== 1) throw new Error('metadata_refresh_conflict');
  source.updated_at = claimedUpdatedAt;
}

async function releaseFederationRefreshLease(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  operationToken: string,
  now: number
): Promise<void> {
  const releasedUpdatedAt = Math.max(now, source.updated_at + 1);
  const release = await admin.execute(
    `UPDATE federation_trust_sources
        SET refresh_operation_token = NULL,
            refresh_operation_expires_at = NULL,
            updated_at = ?
      WHERE id = ? AND tenant_id = ? AND updated_at = ?
        AND lifecycle_state = 'active'
        AND refresh_operation_token = ?`,
    [releasedUpdatedAt, source.id, source.tenant_id, source.updated_at, operationToken]
  );
  if (release.rowsAffected === 1) source.updated_at = releasedUpdatedAt;
}

async function renewFederationRefreshLease(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  operationToken: string,
  now: number
): Promise<void> {
  const renewedUpdatedAt = Math.max(now, source.updated_at + 1);
  const renewal = await admin.execute(
    `UPDATE federation_trust_sources
        SET refresh_operation_expires_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND updated_at = ?
        AND refresh_operation_token = ?`,
    [
      now + FEDERATION_REFRESH_LEASE_MS,
      renewedUpdatedAt,
      source.id,
      source.tenant_id,
      source.updated_at,
      operationToken,
    ]
  );
  if (renewal.rowsAffected !== 1) throw new Error('metadata_refresh_superseded');
  source.updated_at = renewedUpdatedAt;
}

async function startFederationRefreshJob(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  trigger: 'automatic' | 'manual',
  now: number
): Promise<string> {
  const id = crypto.randomUUID();
  await admin.execute(
    `INSERT INTO federation_metadata_refresh_jobs (
       id, tenant_id, trust_source_id, status, refresh_mode, scheduled_for,
       cursor_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    [id, source.tenant_id, source.id, trigger, now, JSON.stringify({ phase: 'fetch' }), now, now]
  );
  return id;
}

async function loadFederationProviderCursor(
  admin: DatabaseAdapter,
  source: FederationSourceRow
): Promise<string | undefined> {
  const previous = await admin.queryOne<{ cursor_json: string | null }>(
    `SELECT cursor_json
       FROM federation_metadata_refresh_jobs
      WHERE tenant_id = ? AND trust_source_id = ?
        AND refresh_mode = 'automatic' AND status = 'completed'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [source.tenant_id, source.id]
  );
  if (!previous?.cursor_json) return undefined;
  try {
    const cursor = JSON.parse(previous.cursor_json) as Record<string, unknown>;
    return typeof cursor.providerCursor === 'string' && cursor.providerCursor
      ? cursor.providerCursor
      : undefined;
  } catch {
    return undefined;
  }
}

async function finishFederationRefreshJob(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  jobId: string,
  status: 'completed' | 'failed',
  cursor: Record<string, unknown>,
  now: number
): Promise<void> {
  await admin.execute(
    `UPDATE federation_metadata_refresh_jobs
        SET status = ?, cursor_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND trust_source_id = ?`,
    [status, JSON.stringify(cursor), now, jobId, source.tenant_id, source.id]
  );
  await admin.execute(
    `DELETE FROM federation_metadata_refresh_jobs
      WHERE tenant_id = ? AND trust_source_id = ?
        AND id NOT IN (
          SELECT id
            FROM federation_metadata_refresh_jobs
           WHERE tenant_id = ? AND trust_source_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
        )`,
    [
      source.tenant_id,
      source.id,
      source.tenant_id,
      source.id,
      MAX_RETAINED_FEDERATION_REFRESH_JOBS_PER_SOURCE,
    ]
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildEntitySummaryBatches(
  documentId: string,
  entities: SAMLMetadataEntitySummary[]
): Array<Array<Record<string, string | null>>> {
  const encoder = new TextEncoder();
  const batches: Array<Array<Record<string, string | null>>> = [];
  let current: Array<Record<string, string | null>> = [];
  let currentBytes = 2;

  entities.forEach((entity, index) => {
    const { entityId, role, displayName, ...summary } = entity;
    const row = {
      id: `samlmdent_${documentId.slice('samlmd_'.length)}_${index}`,
      entityId,
      role,
      displayName: displayName ?? null,
      summaryJson: JSON.stringify(summary),
    };
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length > 0 ? 1 : 0);
    if (rowBytes + 2 > MAX_ENTITY_SUMMARY_BATCH_BYTES) {
      throw new Error('federation_entity_summary_too_large');
    }
    if (
      current.length >= MAX_ENTITY_SUMMARIES_PER_BATCH ||
      currentBytes + rowBytes > MAX_ENTITY_SUMMARY_BATCH_BYTES
    ) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildRuntimeEntityBatches(
  documentId: string,
  entities: FederationRuntimeEntityRecord[]
): Array<Array<Record<string, string | null>>> {
  const encoder = new TextEncoder();
  const batches: Array<Array<Record<string, string | null>>> = [];
  let current: Array<Record<string, string | null>> = [];
  let currentBytes = 2;

  entities.forEach((entity, index) => {
    const metadataBytes = encoder.encode(entity.metadataXml).byteLength;
    if (metadataBytes > MAX_RUNTIME_ENTITY_METADATA_BYTES) return;
    const row = {
      id: `samlrte_${documentId.slice('samlmd_'.length)}_${index}`,
      entityId: entity.entityId,
      role: entity.role,
      metadataXml: entity.metadataXml,
      entityCategoriesJson: entity.entityCategories
        ? JSON.stringify(entity.entityCategories)
        : null,
      entityCategorySupportJson: entity.entityCategorySupport
        ? JSON.stringify(entity.entityCategorySupport)
        : null,
      registrationAuthority: entity.registrationAuthority ?? null,
      validUntil: entity.validUntil ?? null,
    };
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length > 0 ? 1 : 0);
    if (rowBytes + 2 > MAX_RUNTIME_ENTITY_BATCH_BYTES) return;
    if (
      current.length >= MAX_RUNTIME_ENTITIES_PER_BATCH ||
      currentBytes + rowBytes > MAX_RUNTIME_ENTITY_BATCH_BYTES
    ) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildRuntimeEntityStatements(
  source: FederationSourceRow,
  trustContextSnapshotHash: string,
  documentId: string,
  entities: FederationRuntimeEntityRecord[],
  now: number
): PreparedStatement[] {
  return buildRuntimeEntityBatches(documentId, entities).map((batch) => ({
    sql: `INSERT OR IGNORE INTO federation_saml_runtime_entities (
            id, tenant_id, trust_source_id, trust_context_snapshot_hash,
            metadata_document_id, entity_id, entity_role,
            metadata_xml, entity_categories_json, entity_category_support_json,
            registration_authority, valid_until, created_at, updated_at
          )
          SELECT json_extract(value, '$.id'), ?, ?, ?, ?,
                 json_extract(value, '$.entityId'), json_extract(value, '$.role'),
                 json_extract(value, '$.metadataXml'),
                 json_extract(value, '$.entityCategoriesJson'),
                 json_extract(value, '$.entityCategorySupportJson'),
                 json_extract(value, '$.registrationAuthority'),
                 json_extract(value, '$.validUntil'), ?, ?
            FROM json_each(?)`,
    params: [
      source.tenant_id,
      source.id,
      trustContextSnapshotHash,
      documentId,
      now,
      now,
      JSON.stringify(batch),
    ],
  }));
}

function buildFederationDocumentRetentionStatements(
  source: FederationSourceRow
): PreparedStatement[] {
  const staleDocumentIds = `SELECT id
      FROM federation_metadata_documents
     WHERE tenant_id = ? AND trust_source_id = ? AND document_type = ?
       AND id <> COALESCE(
         (SELECT active_metadata_document_id
            FROM federation_trust_sources
           WHERE tenant_id = ? AND id = ?),
         ''
       )
     ORDER BY fetched_at DESC, created_at DESC, id DESC
     LIMIT -1 OFFSET ?`;
  const params = [
    source.tenant_id,
    source.id,
    SAML_RUNTIME_DOCUMENT_TYPE,
    source.tenant_id,
    source.id,
    MAX_RETAINED_FEDERATION_DOCUMENTS_PER_SOURCE,
  ];
  return [
    {
      sql: `DELETE FROM federation_saml_runtime_entities
             WHERE tenant_id = ? AND metadata_document_id IN (${staleDocumentIds})`,
      params: [source.tenant_id, ...params],
    },
    {
      sql: `DELETE FROM federation_metadata_entity_summaries
             WHERE tenant_id = ? AND metadata_document_id IN (${staleDocumentIds})`,
      params: [source.tenant_id, ...params],
    },
    {
      sql: `DELETE FROM federation_metadata_validation_events
             WHERE tenant_id = ? AND metadata_document_id IN (${staleDocumentIds})`,
      params: [source.tenant_id, ...params],
    },
    {
      sql: `DELETE FROM federation_metadata_documents
             WHERE tenant_id = ? AND trust_source_id = ?
               AND id IN (${staleDocumentIds})`,
      params: [source.tenant_id, source.id, ...params],
    },
    buildFederationValidationEventRetentionStatement(source),
  ];
}

function buildFederationValidationEventRetentionStatement(
  source: FederationSourceRow
): PreparedStatement {
  return {
    sql: `DELETE FROM federation_metadata_validation_events
           WHERE tenant_id = ? AND trust_source_id = ?
             AND (
               metadata_document_id IS NULL OR metadata_document_id IN (
                 SELECT id
                   FROM federation_metadata_documents
                  WHERE tenant_id = ? AND trust_source_id = ? AND document_type = ?
               )
             )
             AND id NOT IN (
               SELECT event.id
                 FROM federation_metadata_validation_events event
                 LEFT JOIN federation_metadata_documents document
                   ON document.tenant_id = event.tenant_id
                  AND document.id = event.metadata_document_id
                WHERE event.tenant_id = ? AND event.trust_source_id = ?
                  AND (
                    event.metadata_document_id IS NULL OR document.document_type = ?
                  )
                ORDER BY event.created_at DESC, event.id DESC
                LIMIT ?
             )`,
    params: [
      source.tenant_id,
      source.id,
      source.tenant_id,
      source.id,
      SAML_RUNTIME_DOCUMENT_TYPE,
      source.tenant_id,
      source.id,
      SAML_RUNTIME_DOCUMENT_TYPE,
      MAX_RETAINED_FEDERATION_VALIDATION_EVENTS_PER_SOURCE,
    ],
  };
}

async function recordFederationDocument(
  admin: DatabaseAdapter,
  source: FederationSourceRow,
  metadataUrl: string,
  metadataXml: string,
  verificationStatus: string,
  trustContextSnapshotHash: string,
  entities: SAMLMetadataEntitySummary[],
  runtimeEntities: FederationRuntimeEntityRecord[],
  now: number,
  operationToken: string
): Promise<{ changed: boolean; documentId: string }> {
  const documentHash = await sha256Hex(metadataXml);
  const previous = await admin.queryOne<{
    id: string;
    document_hash: string;
    source_url: string | null;
    fetched_at: number;
  }>(
    `SELECT id, document_hash, source_url, fetched_at
       FROM federation_metadata_documents
      WHERE tenant_id = ? AND trust_source_id = ? AND document_type = ? AND id = ?
      LIMIT 1`,
    [
      source.tenant_id,
      source.id,
      SAML_RUNTIME_DOCUMENT_TYPE,
      source.active_metadata_document_id ?? '',
    ]
  );
  if (previous && previous.fetched_at > now) {
    throw new Error('metadata_refresh_superseded');
  }
  const validationState = verificationStatus === 'verified' ? 'valid' : 'warning';
  const changed = previous?.document_hash !== documentHash || previous.source_url !== metadataUrl;

  // A content hash identifies bytes, not an observation. A fresh ID is required so A→B→A
  // reactivates the restored document instead of colliding with historical A.
  const documentId = `samlmd_${crypto.randomUUID()}`;
  const statements: PreparedStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO federation_metadata_documents (
         id, tenant_id, trust_source_id, document_type, source_url, document_hash,
         document_ref, fetched_at, validated_at, validation_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        documentId,
        source.tenant_id,
        source.id,
        SAML_RUNTIME_DOCUMENT_TYPE,
        metadataUrl,
        documentHash,
        operationToken,
        now,
        now,
        validationState,
        now,
        now,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO federation_metadata_validation_events (
         id, tenant_id, trust_source_id, metadata_document_id, validation_state,
         reason_codes_json, trace_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        `${documentId}:validation`,
        source.tenant_id,
        source.id,
        documentId,
        validationState,
        JSON.stringify([`saml.aggregate.${verificationStatus}`]),
        `metadata-document:${documentId}`,
        now,
      ],
    },
  ];
  for (const batch of buildEntitySummaryBatches(documentId, entities)) {
    statements.push({
      sql: `INSERT OR IGNORE INTO federation_metadata_entity_summaries (
              id, tenant_id, metadata_document_id, entity_id, entity_role,
              display_name, summary_json, created_at, updated_at
            )
            SELECT json_extract(value, '$.id'), ?, ?,
                   json_extract(value, '$.entityId'), json_extract(value, '$.role'),
                   json_extract(value, '$.displayName'), json_extract(value, '$.summaryJson'), ?, ?
              FROM json_each(?)`,
      params: [source.tenant_id, documentId, now, now, JSON.stringify(batch)],
    });
  }
  statements.push(
    ...buildRuntimeEntityStatements(
      source,
      trustContextSnapshotHash,
      documentId,
      runtimeEntities,
      now
    )
  );
  statements.push(...buildFederationDocumentRetentionStatements(source));
  await admin.batch(statements);
  return { changed, documentId };
}

async function listFederationProviderPage(
  adapter: DatabaseAdapter,
  tenantId: string,
  afterProviderId: string | undefined,
  limit: number | undefined
): Promise<FederationProviderPage> {
  if (limit === undefined) {
    return {
      rows: await adapter.query<ProviderRow>(
        `SELECT id, provider_type, config_json, enabled, updated_at
           FROM identity_providers
          WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')
          ORDER BY id ASC`,
        [tenantId]
      ),
    };
  }
  const rows = await adapter.query<ProviderRow>(
    `SELECT id, provider_type, config_json, enabled, updated_at
       FROM identity_providers
      WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp') AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [tenantId, afterProviderId ?? '', limit + 1]
  );
  const page = rows.slice(0, limit);
  return {
    rows: page,
    ...(rows.length > limit && page.length > 0 ? { nextCursor: page.at(-1)!.id } : {}),
  };
}

async function reconcileFederationProviders(
  env: Env,
  source: FederationSourceRow,
  metadataUrl: string,
  aggregateXml: string,
  verification: SAMLMetadataAggregateImportSnapshot['verification'],
  fetched: FetchedMetadataDocument,
  now: number,
  includeManualProviders: boolean,
  afterProviderId?: string,
  providerLimit?: number,
  beforeProviderMutation?: () => Promise<void>
): Promise<{ updated: number; missing: number; failed: number; nextCursor?: string }> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-metadata-polling', {
    tenantId: source.tenant_id,
  });
  const page = await listFederationProviderPage(
    adapter,
    source.tenant_id,
    afterProviderId,
    providerLimit
  );
  const linked = page.rows.filter((row) => {
    try {
      const config = parseConfig(row);
      const aggregateImport = config.aggregateImport;
      return (
        (aggregateImport && getFederationTrustSourceId(config) === source.id) ||
        (!getFederationTrustSourceId(config) && aggregateImport?.aggregateSourceUrl === metadataUrl)
      );
    } catch {
      return false;
    }
  });
  const selected = linked.filter((row) => {
    const config = parseConfig(row);
    return (
      includeManualProviders ||
      normalizeSAMLMetadataRefreshPolicy(config.metadataRefreshPolicy, config.metadataUrl, now)
        .mode === 'automatic'
    );
  });
  const entityIds = selected.flatMap((row) => {
    const entityId = parseConfig(row).aggregateImport?.aggregateEntityId;
    return entityId ? [entityId] : [];
  });
  const extracted = extractEntityDescriptorXmls(aggregateXml, entityIds);
  let updated = 0;
  let missing = 0;
  let failed = 0;

  for (const row of selected) {
    const config = parseConfig(row);
    const aggregateImport = config.aggregateImport;
    if (!aggregateImport) continue;
    const entityXml = extracted.get(aggregateImport.aggregateEntityId);
    if (!entityXml) {
      missing += 1;
      await beforeProviderMutation?.();
      try {
        await updateProviderFailure(
          adapter,
          source.tenant_id,
          row,
          config,
          metadataUrl,
          'federation_entity_missing',
          now
        );
      } catch (error) {
        failed += 1;
        log.warn('Federation provider missing-state update failed', {
          providerId: row.id,
          tenantId: source.tenant_id,
          errorCode: stableFailureCode(error),
        });
      }
      continue;
    }
    await beforeProviderMutation?.();
    try {
      const applied = await applyEntityMetadataToProvider(
        adapter,
        source.tenant_id,
        row,
        entityXml,
        metadataUrl,
        now,
        fetched,
        {
          ...aggregateImport,
          aggregateSourceUrl: metadataUrl,
          federationTrustProfileId: source.id,
          verification,
        }
      );
      if (applied.changed && applied.accepted) updated += 1;
      if (applied.expired) failed += 1;
    } catch (error) {
      if (stableFailureCode(error) === 'metadata_refresh_superseded') throw error;
      failed += 1;
      const code = stableFailureCode(error);
      if (code !== 'metadata_refresh_conflict') {
        try {
          await updateProviderFailure(
            adapter,
            source.tenant_id,
            row,
            config,
            metadataUrl,
            code,
            now
          );
        } catch (persistenceError) {
          log.warn('Federation provider failure-state update failed', {
            providerId: row.id,
            tenantId: source.tenant_id,
            errorCode: stableFailureCode(persistenceError),
          });
        }
      }
      log.warn('Federation provider metadata reconciliation failed', {
        providerId: row.id,
        tenantId: source.tenant_id,
        errorCode: code,
      });
    }
  }

  if (updated > 0 || missing > 0 || failed > 0) {
    await bumpAuthenticationMethodsCacheRevision(env, source.tenant_id);
  }
  return {
    updated,
    missing,
    failed,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

async function markExpiredProvidersFromUnmodifiedFederation(
  env: Env,
  source: FederationSourceRow,
  metadataUrl: string,
  now: number,
  afterProviderId?: string,
  providerLimit?: number,
  beforeProviderMutation?: () => Promise<void>
): Promise<{ expired: number; nextCursor?: string }> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-metadata-polling', {
    tenantId: source.tenant_id,
  });
  const page = await listFederationProviderPage(
    adapter,
    source.tenant_id,
    afterProviderId,
    providerLimit
  );
  let expired = 0;
  for (const row of page.rows) {
    try {
      const config = parseConfig(row);
      if (getFederationTrustSourceId(config) !== source.id) continue;
      if (
        normalizeSAMLMetadataRefreshPolicy(config.metadataRefreshPolicy, config.metadataUrl, now)
          .mode !== 'automatic'
      ) {
        continue;
      }
      const failureCode = isAcceptedMetadataExpired(config.metadataCriticalFields?.validUntil, now)
        ? 'metadata_expired'
        : areAllProviderCertificatesExpired(config, now)
          ? 'metadata_certificates_expired'
          : null;
      if (!failureCode) continue;
      await beforeProviderMutation?.();
      await updateProviderFailure(
        adapter,
        source.tenant_id,
        row,
        config,
        metadataUrl,
        failureCode,
        now
      );
      expired += 1;
    } catch (error) {
      if (stableFailureCode(error) === 'metadata_refresh_superseded') throw error;
      log.warn('Unmodified federation expiry-state update failed', {
        providerId: row.id,
        tenantId: source.tenant_id,
        errorCode: stableFailureCode(error),
      });
    }
  }
  if (expired > 0) await bumpAuthenticationMethodsCacheRevision(env, source.tenant_id);
  return {
    expired,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function refreshFederationMetadataSource(
  env: Env,
  sourceId: string,
  tenantId: string,
  trigger: 'automatic' | 'manual' = 'manual',
  now = Date.now()
): Promise<FederationMetadataRefreshResult> {
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-metadata-polling');
  const source = await admin.queryOne<FederationSourceRow>(
    `SELECT source.id, source.tenant_id, source.source_type, source.protocol_payload_json,
            source.updated_at, source.active_metadata_document_id,
            snapshot.snapshot_hash AS trust_context_snapshot_hash
       FROM federation_trust_sources source
       JOIN federation_trust_context_snapshots snapshot
         ON snapshot.id = (
           SELECT current.id
             FROM federation_trust_context_snapshots current
            WHERE current.tenant_id = source.tenant_id
              AND current.trust_source_id = source.id
              AND current.lifecycle_state = 'active'
            ORDER BY current.activated_at DESC, current.created_at DESC, current.id DESC
            LIMIT 1
         )
      WHERE source.id = ? AND source.tenant_id = ?
        AND source.source_type IN ('saml_aggregate', 'saml_metadata', 'saml_federation')
        AND source.lifecycle_state = 'active'`,
    [sourceId, tenantId]
  );
  if (!source) throw new Error('federation_source_not_found');
  const payload = parseFederationSourcePayload(source.protocol_payload_json);
  const metadataUrl = resolveFederationSourceMetadataUrl(payload);
  if (!metadataUrl) throw new Error('federation_source_metadata_url_required');
  let polling = normalizeSAMLMetadataRefreshPolicy(payload.polling, metadataUrl, now);
  const providerCursor =
    trigger === 'automatic' ? await loadFederationProviderCursor(admin, source) : undefined;
  const providerLimit =
    trigger === 'automatic' ? MAX_FEDERATION_PROVIDER_ROWS_PER_REFRESH : undefined;
  const jobId = await startFederationRefreshJob(admin, source, trigger, now);
  let leaseClaimed = false;

  try {
    await claimFederationRefreshLease(admin, source, jobId, now);
    leaseClaimed = true;
    const fetched = await fetchMetadataDocument(
      metadataUrl,
      polling,
      AGGREGATE_METADATA_FETCH_LIMIT_BYTES,
      trigger === 'automatic' && !providerCursor
    );
    if (fetched.status === 'not_modified') {
      if (isAcceptedMetadataExpired(polling.acceptedValidUntil, now)) {
        throw new Error('metadata_expired');
      }
      await renewFederationRefreshLease(admin, source, jobId, Math.max(now, Date.now()));
      const providerPage = await markExpiredProvidersFromUnmodifiedFederation(
        env,
        source,
        metadataUrl,
        now,
        providerCursor,
        providerLimit,
        () => renewFederationRefreshLease(admin, source, jobId, Math.max(now, Date.now()))
      );
      polling = withHttpValidators(
        markSAMLMetadataRefreshSuccess(polling, metadataUrl, now),
        fetched,
        metadataUrl,
        polling.acceptedValidUntil
      );
      await updateFederationSourcePollingState(
        admin,
        source,
        { ...payload, metadataUrl },
        polling,
        now,
        jobId
      );
      leaseClaimed = false;
      await finishFederationRefreshJob(
        admin,
        source,
        jobId,
        'completed',
        {
          notModified: true,
          ...(providerPage.nextCursor ? { providerCursor: providerPage.nextCursor } : {}),
        },
        now
      );
      return {
        sourceId,
        changed: false,
        entityCount: 0,
        providersUpdated: 0,
        providersMissing: 0,
        providersFailed: providerPage.expired,
        verificationStatus: 'not_modified',
      };
    }

    const metadataXml = fetched.xml;
    if (metadataXml === undefined) throw new Error('metadata_response_body_missing');
    if (!isAggregateMetadata(metadataXml)) throw new Error('federation_source_not_aggregate');
    const profile = (await listFederationTrustProfiles(env, tenantId)).find(
      (candidate) => candidate.id === source.id
    );
    if (!profile) throw new Error('federation_trust_profile_not_found');
    const { aggregate, verification } = await verifyAggregateMetadata(
      metadataXml,
      metadataUrl,
      [profile],
      profile.policy ?? 'strict'
    );
    if (verification.trustContextSnapshotHash !== source.trust_context_snapshot_hash) {
      throw new Error('federation_trust_context_changed');
    }
    if (aggregate.validUntil && Date.parse(aggregate.validUntil) <= now) {
      throw new Error('metadata_expired');
    }
    const runtimeEntityXml = extractEntityDescriptorXmls(
      aggregate.metadataXml,
      aggregate.entities
        .filter(
          (entity) =>
            entity.role === 'saml_idp' || entity.role === 'saml_sp' || entity.role === 'ambiguous'
        )
        .map((entity) => entity.entityId)
    );
    const runtimeEntities = aggregate.entities.flatMap((entity) => {
      if (entity.role !== 'saml_idp' && entity.role !== 'saml_sp' && entity.role !== 'ambiguous') {
        return [];
      }
      const metadataXml = runtimeEntityXml.get(entity.entityId);
      return metadataXml ? [{ ...entity, role: entity.role, metadataXml }] : [];
    });
    const document = await recordFederationDocument(
      admin,
      source,
      metadataUrl,
      aggregate.metadataXml,
      verification.status,
      verification.trustContextSnapshotHash,
      aggregate.entities,
      runtimeEntities,
      now,
      jobId
    );
    // Revalidate and extend the source fence immediately before touching the Core provider store.
    // Combined with the bounded provider page, this prevents an expired operation from publishing
    // stale provider configuration after a newer refresh or trust-source update has won.
    await renewFederationRefreshLease(admin, source, jobId, Math.max(now, Date.now()));
    const providers = await reconcileFederationProviders(
      env,
      source,
      metadataUrl,
      aggregate.metadataXml,
      verification,
      fetched,
      now,
      trigger === 'manual',
      document.changed ? undefined : providerCursor,
      providerLimit,
      () => renewFederationRefreshLease(admin, source, jobId, Math.max(now, Date.now()))
    );
    polling = withHttpValidators(
      markSAMLMetadataRefreshSuccess(polling, metadataUrl, now),
      fetched,
      metadataUrl,
      aggregate.validUntil
    );
    await updateFederationSourcePollingState(
      admin,
      source,
      { ...payload, metadataUrl },
      polling,
      now,
      jobId,
      document.documentId
    );
    leaseClaimed = false;
    await finishFederationRefreshJob(
      admin,
      source,
      jobId,
      'completed',
      {
        documentId: document.documentId,
        changed: document.changed,
        entityCount: aggregate.entities.length,
        providersUpdated: providers.updated,
        providersMissing: providers.missing,
        providersFailed: providers.failed,
        ...(providers.nextCursor ? { providerCursor: providers.nextCursor } : {}),
      },
      now
    );
    try {
      await createAuditLog(env, {
        tenantId,
        userId: trigger === 'automatic' ? 'saml-metadata-scheduler' : 'saml-admin',
        action: 'saml.federation.metadata_refreshed',
        resource: 'federation_trust_source',
        resourceId: source.id,
        ipAddress: trigger,
        userAgent: 'authrim-saml-metadata-polling',
        severity: providers.missing > 0 || providers.failed > 0 ? 'warning' : 'info',
        metadata: JSON.stringify({
          changed: document.changed,
          entity_count: aggregate.entities.length,
          providers_updated: providers.updated,
          providers_missing: providers.missing,
          providers_failed: providers.failed,
          verification_status: verification.status,
        }),
      });
    } catch (auditError) {
      log.warn('Federation metadata polling audit failed', {
        sourceId: source.id,
        tenantId,
        errorCode: stableFailureCode(auditError),
      });
    }
    return {
      sourceId,
      changed: document.changed,
      entityCount: aggregate.entities.length,
      providersUpdated: providers.updated,
      providersMissing: providers.missing,
      providersFailed: providers.failed,
      verificationStatus: verification.status,
    };
  } catch (error) {
    const code = stableFailureCode(error);
    if (
      code !== 'metadata_refresh_conflict' &&
      code !== 'metadata_refresh_superseded' &&
      code !== 'federation_trust_context_changed'
    ) {
      polling = markSAMLMetadataRefreshFailure(
        polling,
        metadataUrl,
        code,
        sourceStateForFailure(code),
        now
      );
      try {
        await updateFederationSourcePollingState(
          admin,
          source,
          { ...payload, metadataUrl },
          polling,
          now,
          jobId
        );
        leaseClaimed = false;
      } catch (updateError) {
        log.warn('Federation polling failure state was superseded', {
          sourceId: source.id,
          tenantId,
          errorCode: stableFailureCode(updateError),
        });
      }
    }
    if (leaseClaimed) {
      try {
        await releaseFederationRefreshLease(admin, source, jobId, now);
      } catch (releaseError) {
        log.warn('Federation metadata refresh lease release failed', {
          sourceId: source.id,
          tenantId,
          errorCode: stableFailureCode(releaseError),
        });
      }
    }
    await admin.execute(
      `INSERT INTO federation_metadata_validation_events (
         id, tenant_id, trust_source_id, metadata_document_id, validation_state,
         reason_codes_json, trace_ref, created_at
       ) VALUES (?, ?, ?, NULL, 'invalid', ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        source.id,
        JSON.stringify([code]),
        `metadata-refresh-job:${jobId}`,
        now,
      ]
    );
    const validationRetention = buildFederationValidationEventRetentionStatement(source);
    await admin.execute(validationRetention.sql, validationRetention.params);
    await finishFederationRefreshJob(admin, source, jobId, 'failed', { errorCode: code }, now);
    throw error;
  }
}

async function pollFederationSources(
  env: Env,
  now: number
): Promise<{ processed: number; failed: number }> {
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'saml-federation-source-scan');
  const cursor = (await env.SETTINGS?.get(FEDERATION_CURSOR_KEY)) ?? '';
  let rows = await admin.query<FederationSourceRow>(
    `SELECT id, tenant_id, source_type, protocol_payload_json
       FROM federation_trust_sources
      WHERE source_type IN ('saml_aggregate', 'saml_metadata', 'saml_federation')
        AND lifecycle_state = 'active'
        AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [cursor, MAX_FEDERATION_SOURCES_PER_RUN]
  );
  if (rows.length === 0 && cursor) {
    rows = await admin.query<FederationSourceRow>(
      `SELECT id, tenant_id, source_type, protocol_payload_json
         FROM federation_trust_sources
        WHERE source_type IN ('saml_aggregate', 'saml_metadata', 'saml_federation')
          AND lifecycle_state = 'active'
        ORDER BY id ASC
        LIMIT ?`,
      [MAX_FEDERATION_SOURCES_PER_RUN]
    );
  }
  const lastSource = rows.at(-1);
  if (lastSource) await env.SETTINGS?.put(FEDERATION_CURSOR_KEY, lastSource.id);
  const due = rows.filter((source) => {
    const payload = parseFederationSourcePayload(source.protocol_payload_json);
    const url = resolveFederationSourceMetadataUrl(payload);
    return url && isSAMLMetadataRefreshDue(payload.polling, url, now);
  });
  let processed = 0;
  let failed = 0;
  for (const source of due.slice(0, MAX_FEDERATION_SOURCES_PER_RUN)) {
    try {
      await refreshFederationMetadataSource(env, source.id, source.tenant_id, 'automatic', now);
      processed += 1;
    } catch (error) {
      failed += 1;
      log.warn('Federation metadata polling failed', {
        sourceId: source.id,
        tenantId: source.tenant_id,
        errorCode: stableFailureCode(error),
      });
    }
  }
  return { processed, failed };
}

async function listScheduledTenantIds(env: Env): Promise<string[]> {
  const cursor = (await env.SETTINGS?.get(TENANT_CURSOR_KEY)) ?? undefined;
  try {
    let page = await listEnvironmentTenantDefaultStores(env, {
      limit: TENANT_BATCH_SIZE,
      afterTenantId: cursor,
    });
    if (page.length === 0 && cursor) {
      page = await listEnvironmentTenantDefaultStores(env, { limit: TENANT_BATCH_SIZE });
    }
    const tenantIds = page.map((entry) => entry.tenantId);
    if (tenantIds.length === 0) return [getDefaultTenantId(env)];
    const lastTenantId = tenantIds.at(-1);
    if (lastTenantId) await env.SETTINGS?.put(TENANT_CURSOR_KEY, lastTenantId);
    return tenantIds;
  } catch {
    return [getDefaultTenantId(env)];
  }
}

async function pollIndividualProvidersForTenant(
  env: Env,
  tenantId: string,
  now: number,
  limit: number
): Promise<{ processed: number; failed: number }> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-provider-polling', {
    tenantId,
  });
  const cursorKey = `${PROVIDER_CURSOR_KEY_PREFIX}${encodeURIComponent(tenantId)}`;
  const cursor = (await env.SETTINGS?.get(cursorKey)) ?? '';
  let rows = await adapter.query<ProviderRow>(
    `SELECT id, provider_type, config_json, enabled, updated_at
       FROM identity_providers
      WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp') AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [tenantId, cursor, limit]
  );
  if (rows.length === 0 && cursor) {
    rows = await adapter.query<ProviderRow>(
      `SELECT id, provider_type, config_json, enabled, updated_at
         FROM identity_providers
        WHERE tenant_id = ? AND provider_type IN ('saml_idp', 'saml_sp')
        ORDER BY id ASC
        LIMIT ?`,
      [tenantId, limit]
    );
  }
  const lastProvider = rows.at(-1);
  if (lastProvider) await env.SETTINGS?.put(cursorKey, lastProvider.id);
  const linkedSourceIds = [
    ...new Set(
      rows.flatMap((row) => {
        try {
          const sourceId = getFederationTrustSourceId(parseConfig(row));
          return sourceId ? [sourceId] : [];
        } catch {
          return [];
        }
      })
    ),
  ];
  let activeLinkedSourceIds = new Set<string>();
  if (linkedSourceIds.length > 0) {
    const admin = requireDedicatedAdminDatabaseAdapter(env, 'saml-provider-source-reconciliation');
    const placeholders = linkedSourceIds.map(() => '?').join(', ');
    const activeSources = await admin.query<{ id: string }>(
      `SELECT id
         FROM federation_trust_sources
        WHERE tenant_id = ? AND lifecycle_state = 'active' AND id IN (${placeholders})`,
      [tenantId, ...linkedSourceIds]
    );
    activeLinkedSourceIds = new Set(activeSources.map((source) => source.id));
  }
  let failed = 0;
  for (const row of rows) {
    const config = parseConfig(row);
    const sourceId = getFederationTrustSourceId(config);
    if (!sourceId || activeLinkedSourceIds.has(sourceId)) continue;
    const metadataUrl = config.metadataUrl ?? config.aggregateImport?.aggregateSourceUrl;
    if (!metadataUrl) continue;
    await updateProviderFailure(
      adapter,
      tenantId,
      row,
      config,
      metadataUrl,
      'federation_source_missing',
      now
    );
    await recordAutomaticProviderRefreshAudit(env, tenantId, row.id, metadataUrl, {
      errorCode: 'federation_source_missing',
    });
    failed += 1;
  }
  const due = rows
    .filter((row) => {
      try {
        const config = parseConfig(row);
        if (getFederationTrustSourceId(config)) return false;
        return isSAMLMetadataRefreshDue(config.metadataRefreshPolicy, config.metadataUrl, now);
      } catch {
        return false;
      }
    })
    .slice(0, limit);
  let processed = 0;

  for (const row of due) {
    const config = parseConfig(row);
    const metadataUrl = config.metadataUrl;
    if (!metadataUrl) continue;
    try {
      const normalizedPolicy = normalizeSAMLMetadataRefreshPolicy(
        config.metadataRefreshPolicy,
        metadataUrl,
        now
      );
      const fetched = await fetchMetadataDocument(
        metadataUrl,
        normalizedPolicy,
        config.aggregateImport
          ? AGGREGATE_METADATA_FETCH_LIMIT_BYTES
          : SINGLE_METADATA_FETCH_LIMIT_BYTES
      );
      if (fetched.status === 'not_modified') {
        const writeTime = Math.max(now, row.updated_at + 1);
        const expiryFailureCode = isAcceptedMetadataExpired(
          config.metadataCriticalFields?.validUntil,
          now
        )
          ? 'metadata_expired'
          : areAllProviderCertificatesExpired(config, now)
            ? 'metadata_certificates_expired'
            : null;
        if (expiryFailureCode) {
          await updateProviderFailure(
            adapter,
            tenantId,
            row,
            config,
            metadataUrl,
            expiryFailureCode,
            now
          );
          await recordAutomaticProviderRefreshAudit(env, tenantId, row.id, metadataUrl, {
            errorCode: expiryFailureCode,
            expired: true,
          });
          failed += 1;
          continue;
        }
        const policy = withHttpValidators(
          markSAMLMetadataRefreshSuccess(normalizedPolicy, metadataUrl, writeTime),
          fetched,
          metadataUrl,
          config.metadataCriticalFields?.validUntil
        );
        const update = await adapter.execute(
          `UPDATE identity_providers
              SET config_json = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND updated_at = ?`,
          [
            JSON.stringify({ ...config, metadataRefreshPolicy: policy }),
            writeTime,
            row.id,
            tenantId,
            row.updated_at,
          ]
        );
        if (update.rowsAffected !== 1) throw new Error('metadata_refresh_conflict');
        processed += 1;
        continue;
      }

      let metadataXml = fetched.xml;
      if (metadataXml === undefined) throw new Error('metadata_response_body_missing');
      let aggregateImport = config.aggregateImport;
      if (isAggregateMetadata(metadataXml)) {
        if (!aggregateImport?.aggregateEntityId)
          throw new Error('aggregate_entity_snapshot_required');
        const profiles = await listFederationTrustProfiles(env, tenantId);
        const pinnedTrustProfileId =
          aggregateImport.federationTrustProfileId ?? aggregateImport.verification.trustProfileId;
        const pinnedProfile = pinnedTrustProfileId
          ? profiles.find((profile) => profile.id === pinnedTrustProfileId)
          : undefined;
        const verificationProfiles = pinnedTrustProfileId
          ? pinnedProfile
            ? [pinnedProfile]
            : []
          : profiles;
        const verified = await verifyAggregateMetadata(
          metadataXml,
          metadataUrl,
          verificationProfiles,
          pinnedProfile?.policy ?? 'strict'
        );
        metadataXml =
          extractEntityDescriptorXmls(verified.aggregate.metadataXml, [
            aggregateImport.aggregateEntityId,
          ]).get(aggregateImport.aggregateEntityId) ?? '';
        if (!metadataXml) throw new Error('federation_entity_missing');
        aggregateImport = {
          ...aggregateImport,
          aggregateSourceUrl: metadataUrl,
          federationTrustProfileId: verified.verification.trustProfileId ?? pinnedTrustProfileId,
          verification: verified.verification,
        };
      } else if (aggregateImport) {
        throw new Error('aggregate_source_not_aggregate');
      }
      const applied = await applyEntityMetadataToProvider(
        adapter,
        tenantId,
        row,
        metadataXml,
        metadataUrl,
        now,
        fetched,
        aggregateImport
      );
      if (applied.accepted) processed += 1;
      else failed += 1;
      if (applied.changed || applied.expired) {
        await recordAutomaticProviderRefreshAudit(env, tenantId, row.id, metadataUrl, {
          changed: applied.changed,
          errorCode: applied.expired ? 'metadata_expired' : undefined,
          expired: applied.expired,
        });
      }
    } catch (error) {
      failed += 1;
      const code = stableFailureCode(error);
      if (code !== 'metadata_refresh_conflict') {
        try {
          await updateProviderFailure(adapter, tenantId, row, config, metadataUrl, code, now);
        } catch (persistenceError) {
          log.warn('Individual SAML metadata failure-state update failed', {
            providerId: row.id,
            tenantId,
            errorCode: stableFailureCode(persistenceError),
          });
        }
      }
      await recordAutomaticProviderRefreshAudit(env, tenantId, row.id, metadataUrl, {
        errorCode: code,
      });
      log.warn('Individual SAML metadata polling failed', {
        providerId: row.id,
        tenantId,
        errorCode: code,
      });
    }
  }
  if (processed > 0 || failed > 0) await bumpAuthenticationMethodsCacheRevision(env, tenantId);
  return { processed, failed };
}

export async function pollSAMLMetadata(
  env: Env,
  now = Date.now()
): Promise<SAMLMetadataPollingResult> {
  let federation = { processed: 0, failed: 0 };
  try {
    federation = await pollFederationSources(env, now);
  } catch (error) {
    federation.failed = 1;
    log.warn('Federation source scan failed; continuing individual metadata polling', {
      errorCode: stableFailureCode(error),
    });
  }
  const tenantIds = await listScheduledTenantIds(env);
  let individualProvidersProcessed = 0;
  let individualProvidersFailed = 0;
  let tenantsProcessed = 0;
  let remainingIndividualBudget = MAX_INDIVIDUAL_SOURCES_PER_RUN;
  for (const [index, tenantId] of tenantIds.entries()) {
    if (remainingIndividualBudget <= 0) break;
    const tenantsRemaining = tenantIds.length - index;
    const tenantBudget = Math.max(1, Math.floor(remainingIndividualBudget / tenantsRemaining));
    try {
      const result = await pollIndividualProvidersForTenant(env, tenantId, now, tenantBudget);
      individualProvidersProcessed += result.processed;
      individualProvidersFailed += result.failed;
      remainingIndividualBudget -= result.processed + result.failed;
    } catch (error) {
      individualProvidersFailed += 1;
      remainingIndividualBudget -= 1;
      log.warn('SAML metadata tenant polling failed', {
        tenantId,
        errorCode: stableFailureCode(error),
      });
    }
    tenantsProcessed += 1;
  }
  return {
    federationSourcesProcessed: federation.processed,
    federationSourcesFailed: federation.failed,
    individualProvidersProcessed,
    individualProvidersFailed,
    tenantsProcessed,
  };
}
