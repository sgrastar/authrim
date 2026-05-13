/**
 * Data Portability API (GDPR Article 20)
 *
 * Provides endpoints for users to export their personal data
 * in a structured, commonly used, and machine-readable format.
 *
 * Implements hybrid processing:
 * - Synchronous export for small data (< threshold KB)
 * - Asynchronous export for large data (returns request ID, processes via Queue)
 *
 * Endpoints:
 * - POST /api/user/data-export - Request data export
 * - GET /api/user/data-export/:id - Check export status
 * - GET /api/user/data-export/:id/download - Download exported data
 */

import { Context } from 'hono';
import type {
  Env,
  DatabaseAdapter,
  DataExportRequest,
  DataExportSection,
  DataExportFormat,
  ExportedUserData,
} from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  ensureDatabaseAdapter,
  listObjectCatalogObjects,
  getTenantIdFromContext,
  introspectTokenFromContext,
  getSessionStoreBySessionId,
  createOAuthConfigManager,
  getLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  type ObjectCatalogListResult,
  type ObjectCatalogPhysicalRecord,
  type ObjectRepresentation,
} from '@authrim/ar-lib-core';
import {
  loadCatalogObjectArtifact,
  loadCatalogObjectRepresentation,
} from '@authrim/ar-lib-core/services/object-artifact-store';
import { getCookie } from 'hono/cookie';
import { materializeEncryptedObjectArtifact } from './object-artifact-materialization';

// Default export sections
const ALL_SECTIONS: DataExportSection[] = [
  'profile',
  'consents',
  'sessions',
  'audit_log',
  'passkeys',
];

const DATA_EXPORT_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DATA_EXPORT_PROCESS_BATCH_LIMIT = 3;
type ExportArtifactFormat = DataExportFormat;

interface ExportArtifactManifestObject {
  format: ExportArtifactFormat | null;
  representation: ObjectRepresentation;
  objectKind: 'single' | 'manifest' | 'chunk';
  objectIndex: number;
  totalBytes?: number | null;
  checksumSha256?: string | null;
  downloadUrl?: string;
  chunkUrl?: string;
}

interface ExportArtifactManifestResponse {
  artifactId: string;
  requestId: string;
  status: string;
  defaultFormat: ExportArtifactFormat;
  availableFormats: ExportArtifactFormat[];
  objectClass: string;
  expiresAt?: number | null;
  createdAt: number;
  objects: ExportArtifactManifestObject[];
}

interface PendingDataExportRow {
  id: string;
  tenant_id: string;
  user_id: string;
  status: 'pending' | 'processing';
  format: DataExportFormat;
  include_sections: string;
  requested_at: number;
}

function buildDataExportObjectKey(
  tenantId: string,
  requestId: string,
  format: DataExportFormat
): string {
  return `exports/${tenantId}/data-export/${requestId}/artifact.${format === 'csv' ? 'csv' : 'json'}`;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function flattenCsvRows(
  rows: string[][],
  section: string,
  itemIndex: number | null,
  fieldPath: string,
  value: unknown
): void {
  if (value === undefined || value === null) {
    rows.push([section, itemIndex === null ? '' : String(itemIndex), fieldPath, '']);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([section, itemIndex === null ? '' : String(itemIndex), fieldPath, '']);
      return;
    }
    value.forEach((entry, index) => {
      const nextPath = `${fieldPath}[${index}]`;
      flattenCsvRows(rows, section, itemIndex, nextPath, entry);
    });
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = fieldPath ? `${fieldPath}.${key}` : key;
      flattenCsvRows(rows, section, itemIndex, nextPath, nestedValue);
    }
    return;
  }

  rows.push([section, itemIndex === null ? '' : String(itemIndex), fieldPath, String(value)]);
}

function serializeExportDataToCsv(data: ExportedUserData): string {
  const rows: string[][] = [['section', 'item_index', 'field', 'value']];

  for (const [section, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        flattenCsvRows(rows, section, index, '', entry);
      });
      continue;
    }

    flattenCsvRows(rows, section, null, '', value);
  }

  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

function representationForExportFormat(format: ExportArtifactFormat): ObjectRepresentation {
  return format === 'csv' ? 'csv_projection' : 'canonical_json';
}

function exportFormatForRepresentation(
  representation: ObjectRepresentation
): ExportArtifactFormat | null {
  if (representation === 'csv_projection') {
    return 'csv';
  }
  if (representation === 'canonical_json') {
    return 'json';
  }
  return null;
}

function normalizeRequestedExportFormat(value: string | undefined, fallback: ExportArtifactFormat) {
  if (value === 'csv' || value === 'json') {
    return value;
  }
  return fallback;
}

async function loadEncryptedExportArtifactRepresentation(
  adapter: DatabaseAdapter,
  env: Env,
  tenantId: string,
  objectCatalogId: string,
  representation: ObjectRepresentation = 'canonical_json'
): Promise<{ content: string; contentType: string } | null> {
  if (!env.EXPORT_ARTIFACTS || !env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const artifact = await loadCatalogObjectRepresentation(adapter, env, {
    tenantId,
    objectCatalogId,
    representation,
    expectedClass: 'user_export',
    expectedBucketBinding: 'EXPORT_ARTIFACTS',
    allowPlaintextFallback: false,
  });
  if (!artifact) {
    return null;
  }

  return {
    content: artifact.content,
    contentType: artifact.contentType,
  };
}

async function loadEncryptedExportArtifactChunk(
  adapter: DatabaseAdapter,
  env: Env,
  tenantId: string,
  objectCatalogId: string,
  representation: ObjectRepresentation,
  objectIndex: number
): Promise<{ content: string; contentType: string } | null> {
  if (!env.EXPORT_ARTIFACTS || !env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return null;
  }

  const artifact = await loadCatalogObjectArtifact(adapter, env, {
    tenantId,
    objectCatalogId,
    representation,
    objectIndex,
    expectedClass: 'user_export',
    expectedBucketBinding: 'EXPORT_ARTIFACTS',
    allowPlaintextFallback: false,
  });
  if (!artifact) {
    return null;
  }

  return {
    content: artifact.content,
    contentType: artifact.contentType,
  };
}

function buildExportArtifactManifestResponse(
  request: {
    requestId: string;
    status: string;
    format: ExportArtifactFormat;
    expiresAt?: number | null;
  },
  catalog: ObjectCatalogListResult
): ExportArtifactManifestResponse {
  const objects = catalog.physical.map<ExportArtifactManifestObject>(
    (physical: ObjectCatalogPhysicalRecord) => {
      const format = exportFormatForRepresentation(physical.representation);
      const manifestObject: ExportArtifactManifestObject = {
        format,
        representation: physical.representation,
        objectKind: physical.objectKind,
        objectIndex: physical.chunkIndex ?? 0,
        totalBytes: physical.totalBytes,
        checksumSha256: physical.checksumSha256,
      };

      if (physical.objectKind === 'chunk') {
        manifestObject.chunkUrl =
          `/api/user/data-export/artifacts/${catalog.logical.publicArtifactId}` +
          `/chunks/${physical.chunkIndex ?? 0}${format ? `?format=${format}` : ''}`;
      } else if (format) {
        manifestObject.downloadUrl = `/api/user/data-export/artifacts/${catalog.logical.publicArtifactId}/download?format=${format}`;
      }

      return manifestObject;
    }
  );

  const availableFormats: ExportArtifactFormat[] = Array.from(
    new Set(
      objects
        .map((object: ExportArtifactManifestObject) => object.format)
        .filter(
          (format: ExportArtifactFormat | null): format is ExportArtifactFormat =>
            format === 'json' || format === 'csv'
        )
    )
  );

  return {
    artifactId: catalog.logical.publicArtifactId,
    requestId: request.requestId,
    status: request.status,
    defaultFormat: request.format,
    availableFormats,
    objectClass: catalog.logical.objectClass,
    expiresAt: request.expiresAt,
    createdAt: catalog.logical.createdAt,
    objects,
  };
}

/**
 * Get user ID from request context
 * Supports both access token (Bearer) and session-based (Cookie) auth
 */
async function getUserIdFromContext(c: Context<{ Bindings: Env }>): Promise<string | null> {
  // 1. Try Bearer token authentication first
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const introspection = await introspectTokenFromContext(c);
    if (introspection.valid && introspection.claims?.sub) {
      return introspection.claims.sub as string;
    }
    return null;
  }

  // 2. Try session-based authentication
  const sid = getCookie(c, 'sid');
  if (sid) {
    try {
      const { stub: sessionStore } = getSessionStoreBySessionId(
        c.env,
        sid,
        getTenantIdFromContext(c)
      );
      const response = await sessionStore.fetch(
        new Request(`https://do/session/${sid}`, { method: 'GET' })
      );
      if (response.ok) {
        const session = await response.json();
        if (session && typeof session === 'object' && 'userId' in session) {
          return (session as { userId: string }).userId;
        }
      }
    } catch (error) {
      const log = getLogger(c).module('DATA-EXPORT');
      log.error('Session validation error', {}, error as Error);
    }
  }

  return null;
}

/**
 * Request data export
 * POST /api/user/data-export
 *
 * Body:
 * - sections: string[] - Sections to include (optional, defaults to all)
 * - format: 'json' | 'csv' - Export format (optional, defaults to 'json')
 */
export async function dataExportRequestHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    // Parse request body
    let sections: DataExportSection[] = ALL_SECTIONS;
    let format: DataExportFormat = 'json';

    const contentType = c.req.header('Content-Type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = await c.req.json<{
          sections?: DataExportSection[];
          format?: DataExportFormat;
        }>();
        if (body.sections && Array.isArray(body.sections)) {
          // Validate sections
          const validSections = body.sections.filter((s) =>
            ALL_SECTIONS.includes(s as DataExportSection)
          );
          if (validSections.length > 0) {
            sections = validSections;
          }
        }
        if (body.format === 'json' || body.format === 'csv') {
          format = body.format;
        }
      } catch {
        // Ignore parse errors, use defaults
      }
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if data export is enabled
    const configManager = createOAuthConfigManager(c.env);
    const exportEnabled = await configManager.getConsentDataExportEnabled();

    if (!exportEnabled) {
      return c.json(
        {
          error: 'feature_disabled',
          error_description: 'Data export is not enabled',
        },
        403
      );
    }

    // Get sync threshold from config
    const syncThresholdKB = await configManager.getConsentDataExportSyncThresholdKB();

    // Estimate data size (simplified - just count records)
    const estimatedSize = await estimateExportSize(authCtx.coreAdapter, tenantId, userId, sections);

    const now = Date.now();
    const requestId = crypto.randomUUID();

    if (estimatedSize < syncThresholdKB * 1024) {
      // Synchronous export for small data
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const exportedData = await collectExportData(
        authCtx.coreAdapter,
        piiCtx?.defaultPiiAdapter ?? null,
        userId,
        tenantId,
        sections
      );

      // Return JSON directly
      return c.json({
        status: 'completed',
        requestId,
        format,
        data: exportedData,
        exportedAt: now,
      });
    } else {
      // Asynchronous export for large data - create export request
      await authCtx.coreAdapter.execute(
        `INSERT INTO data_export_requests
         (id, tenant_id, user_id, status, format, include_sections, requested_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        [requestId, tenantId, userId, format, JSON.stringify(sections), now]
      );

      // Queue the export job (if queue is available)
      // For now, return pending status - actual processing would be done by scheduled worker
      return c.json(
        {
          status: 'pending',
          requestId,
          message: 'Export request created. Use GET /api/user/data-export/:id to check status.',
          estimatedWaitSeconds: Math.ceil(estimatedSize / (50 * 1024)), // Rough estimate
        },
        202
      );
    }
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to create export request', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create export request',
      },
      500
    );
  }
}

/**
 * Check export status
 * GET /api/user/data-export/:id
 */
export async function dataExportStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const requestId = c.req.param('id')!;
    if (!requestId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const result = await authCtx.coreAdapter.query<{
      id: string;
      status: string;
      format: string;
      include_sections: string;
      requested_at: number;
      started_at: number | null;
      completed_at: number | null;
      expires_at: number | null;
      file_size: number | null;
      error_message: string | null;
      object_catalog_id: string | null;
      public_artifact_id: string | null;
    }>(
      `SELECT der.id, der.status, der.format, der.include_sections, der.requested_at,
              der.started_at, der.completed_at, der.expires_at, der.file_size, der.error_message,
              der.object_catalog_id, oc.public_artifact_id
       FROM data_export_requests der
       LEFT JOIN object_catalog oc
         ON oc.id = der.object_catalog_id
        AND oc.tenant_id = der.tenant_id
        AND oc.deleted_at IS NULL
       WHERE der.id = ? AND der.user_id = ? AND der.tenant_id = ?`,
      [requestId, userId, tenantId]
    );

    if (result.length === 0) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export request not found',
        },
        404
      );
    }

    const request = result[0];

    const response: DataExportRequest = {
      id: request.id,
      publicArtifactId: request.public_artifact_id ?? undefined,
      userId,
      status: request.status as DataExportRequest['status'],
      format: request.format as DataExportFormat,
      includeSections: JSON.parse(request.include_sections) as DataExportSection[],
      requestedAt: request.requested_at,
      startedAt: request.started_at ?? undefined,
      completedAt: request.completed_at ?? undefined,
      expiresAt: request.expires_at ?? undefined,
      fileSize: request.file_size ?? undefined,
      availableFormats: request.object_catalog_id
        ? [request.format as DataExportFormat]
        : undefined,
      errorMessage: request.error_message ?? undefined,
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to check export status', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check export status',
      },
      500
    );
  }
}

interface DataExportDownloadRow {
  id: string;
  status: string;
  format: DataExportFormat;
  include_sections: string;
  expires_at: number | null;
  file_path: string | null;
  object_catalog_id: string | null;
  public_artifact_id: string | null;
}

async function getDataExportRequestById(
  adapter: DatabaseAdapter,
  requestId: string,
  userId: string,
  tenantId: string
): Promise<DataExportDownloadRow | null> {
  return (
    (
      await adapter.query<DataExportDownloadRow>(
        `SELECT der.id, der.status, der.format, der.include_sections, der.expires_at, der.file_path,
              der.object_catalog_id, oc.public_artifact_id
         FROM data_export_requests der
         LEFT JOIN object_catalog oc
           ON oc.id = der.object_catalog_id
          AND oc.tenant_id = der.tenant_id
          AND oc.deleted_at IS NULL
        WHERE der.id = ? AND der.user_id = ? AND der.tenant_id = ?`,
        [requestId, userId, tenantId]
      )
    )[0] ?? null
  );
}

async function getDataExportRequestByArtifactId(
  adapter: DatabaseAdapter,
  artifactId: string,
  userId: string,
  tenantId: string
): Promise<DataExportDownloadRow | null> {
  return (
    (
      await adapter.query<DataExportDownloadRow>(
        `SELECT der.id, der.status, der.format, der.include_sections, der.expires_at, der.file_path,
              der.object_catalog_id, oc.public_artifact_id
         FROM data_export_requests der
         INNER JOIN object_catalog oc
           ON oc.id = der.object_catalog_id
          AND oc.tenant_id = der.tenant_id
        WHERE oc.public_artifact_id = ?
          AND oc.deleted_at IS NULL
          AND der.user_id = ?
          AND der.tenant_id = ?`,
        [artifactId, userId, tenantId]
      )
    )[0] ?? null
  );
}

function createExportFilename(format: DataExportFormat): string {
  return `data-export-${new Date().toISOString().split('T')[0]}.${format}`;
}

async function createMaterializedExportDownloadResponse(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  tenantId: string,
  request: DataExportDownloadRow,
  requestedFormat: ExportArtifactFormat
): Promise<Response | null> {
  if (!request.object_catalog_id) {
    return null;
  }

  const artifact = await loadEncryptedExportArtifactRepresentation(
    adapter,
    c.env,
    tenantId,
    request.object_catalog_id,
    representationForExportFormat(requestedFormat)
  );
  if (!artifact) {
    return null;
  }

  return new Response(artifact.content, {
    status: 200,
    headers: {
      'Content-Type':
        artifact.contentType || (requestedFormat === 'csv' ? 'text/csv' : 'application/json'),
      'Content-Disposition': `attachment; filename="${createExportFilename(requestedFormat)}"`,
    },
  });
}

/**
 * Download exported data
 * GET /api/user/data-export/:id/download
 */
export async function dataExportDownloadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const requestId = c.req.param('id')!;
    if (!requestId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Request ID is required',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const request = await getDataExportRequestById(
      authCtx.coreAdapter,
      requestId,
      userId,
      tenantId
    );
    if (!request) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export request not found',
        },
        404
      );
    }

    if (request.status !== 'completed') {
      return c.json(
        {
          error: 'not_ready',
          error_description: `Export is ${request.status}`,
        },
        409
      );
    }

    // Check expiration
    const now = Date.now();
    if (request.expires_at && request.expires_at < now) {
      return c.json(
        {
          error: 'expired',
          error_description: 'Export has expired',
        },
        410
      );
    }

    const manifestView = c.req.header('X-Authrim-Artifact-View') === 'manifest';
    const queryAccessor = c.req as { query?: (key: string) => string | undefined };
    const requestedFormat = normalizeRequestedExportFormat(
      queryAccessor.query?.('format'),
      request.format
    );
    const viewQuery = queryAccessor.query?.('view');
    if (manifestView || viewQuery === 'manifest') {
      if (!request.object_catalog_id || !request.public_artifact_id) {
        return c.json(
          {
            error: 'not_supported',
            error_description: 'Manifest view is only available for materialized exports',
          },
          409
        );
      }

      const catalog = await listObjectCatalogObjects(
        authCtx.coreAdapter,
        tenantId,
        request.object_catalog_id
      );
      if (!catalog) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'Export artifact manifest not found',
          },
          404
        );
      }

      return c.json(
        buildExportArtifactManifestResponse(
          {
            requestId,
            status: request.status,
            format: request.format,
            expiresAt: request.expires_at,
          },
          catalog
        )
      );
    }

    if (!request.object_catalog_id) {
      return c.json(
        {
          error: 'not_materialized',
          error_description:
            'Completed export does not have a materialized artifact. Retry after background processing or recreate the export request.',
        },
        409
      );
    }

    const materializedResponse = await createMaterializedExportDownloadResponse(
      c,
      authCtx.coreAdapter,
      tenantId,
      request,
      requestedFormat
    );
    if (materializedResponse) {
      return materializedResponse;
    }

    return c.json(
      {
        error: 'not_found',
        error_description: 'Materialized export artifact not found',
      },
      404
    );
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to download export', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to download export',
      },
      500
    );
  }
}

export async function dataExportArtifactManifestHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const artifactId = c.req.param('artifactId')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const request = await getDataExportRequestByArtifactId(
      authCtx.coreAdapter,
      artifactId,
      userId,
      tenantId
    );
    if (!request || !request.object_catalog_id || !request.public_artifact_id) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact not found',
        },
        404
      );
    }

    const catalog = await listObjectCatalogObjects(
      authCtx.coreAdapter,
      tenantId,
      request.object_catalog_id
    );
    if (!catalog) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact manifest not found',
        },
        404
      );
    }

    return c.json(
      buildExportArtifactManifestResponse(
        {
          requestId: request.id,
          status: request.status,
          format: request.format,
          expiresAt: request.expires_at,
        },
        catalog
      )
    );
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to get export artifact manifest', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get export artifact manifest',
      },
      500
    );
  }
}

export async function dataExportArtifactDownloadHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const artifactId = c.req.param('artifactId')!;
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const request = await getDataExportRequestByArtifactId(
      authCtx.coreAdapter,
      artifactId,
      userId,
      tenantId
    );
    if (!request) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact not found',
        },
        404
      );
    }

    if (request.status !== 'completed') {
      return c.json(
        {
          error: 'not_ready',
          error_description: `Export is ${request.status}`,
        },
        409
      );
    }

    if (request.expires_at && request.expires_at < Date.now()) {
      return c.json(
        {
          error: 'expired',
          error_description: 'Export has expired',
        },
        410
      );
    }

    const requestedFormat = normalizeRequestedExportFormat(
      (c.req as { query?: (key: string) => string | undefined }).query?.('format'),
      request.format
    );
    const response = await createMaterializedExportDownloadResponse(
      c,
      authCtx.coreAdapter,
      tenantId,
      request,
      requestedFormat
    );
    if (!response) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Requested artifact representation is not available',
        },
        404
      );
    }

    return response;
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to download export artifact', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to download export artifact',
      },
      500
    );
  }
}

export async function dataExportArtifactChunkHandler(c: Context<{ Bindings: Env }>) {
  try {
    const userId = await getUserIdFromContext(c);
    if (!userId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Authentication required',
        },
        401
      );
    }

    const artifactId = c.req.param('artifactId')!;
    const chunkIndex = Number.parseInt(c.req.param('index') || '0', 10);
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Chunk index must be a non-negative integer',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const request = await getDataExportRequestByArtifactId(
      authCtx.coreAdapter,
      artifactId,
      userId,
      tenantId
    );
    if (!request || !request.object_catalog_id) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact not found',
        },
        404
      );
    }

    if (request.status !== 'completed') {
      return c.json(
        {
          error: 'not_ready',
          error_description: `Export is ${request.status}`,
        },
        409
      );
    }

    if (request.expires_at && request.expires_at < Date.now()) {
      return c.json(
        {
          error: 'expired',
          error_description: 'Export has expired',
        },
        410
      );
    }

    const requestedFormat = normalizeRequestedExportFormat(
      (c.req as { query?: (key: string) => string | undefined }).query?.('format'),
      request.format
    );
    const chunkArtifact = await loadEncryptedExportArtifactChunk(
      authCtx.coreAdapter,
      c.env,
      tenantId,
      request.object_catalog_id,
      representationForExportFormat(requestedFormat),
      chunkIndex
    );
    if (!chunkArtifact) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact chunk not found',
        },
        404
      );
    }

    const chunkMetadata = await loadCatalogObjectRepresentation(authCtx.coreAdapter, c.env, {
      tenantId,
      objectCatalogId: request.object_catalog_id,
      representation: representationForExportFormat(requestedFormat),
      expectedClass: 'user_export',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
      allowPlaintextFallback: false,
    });
    if (!chunkMetadata) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact chunk not found',
        },
        404
      );
    }

    const singleObject = chunkMetadata.physical.find(
      (entry: ObjectCatalogPhysicalRecord) => entry.objectKind === 'single'
    );
    if (singleObject) {
      if (chunkIndex !== 0) {
        return c.json(
          {
            error: 'not_found',
            error_description: 'Export artifact chunk not found',
          },
          404
        );
      }

      return new Response(chunkArtifact.content, {
        status: 200,
        headers: {
          'Content-Type':
            chunkArtifact.contentType ||
            (requestedFormat === 'csv' ? 'text/csv' : 'application/json'),
        },
      });
    }

    const chunkRecords = chunkMetadata.physical
      .filter(
        (entry: ObjectCatalogPhysicalRecord) =>
          entry.objectKind === 'chunk' && (entry.chunkIndex ?? -1) >= 0
      )
      .sort(
        (left: ObjectCatalogPhysicalRecord, right: ObjectCatalogPhysicalRecord) =>
          (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0)
      );
    if (chunkIndex >= chunkRecords.length) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Export artifact chunk not found',
        },
        404
      );
    }

    return new Response(chunkArtifact.content, {
      status: 200,
      headers: {
        'Content-Type':
          chunkArtifact.contentType ||
          (requestedFormat === 'csv' ? 'text/csv' : 'application/json'),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('DATA-EXPORT');
    log.error('Failed to download export artifact chunk', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to download export artifact chunk',
      },
      500
    );
  }
}

export async function processPendingDataExportRequests(
  env: Env,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<void> {
  if (!env.EXPORT_ARTIFACTS) {
    logger.info('Skipping data export jobs because EXPORT_ARTIFACTS is not configured');
    return;
  }
  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    logger.info('Skipping data export jobs because OBJECT_ENCRYPTION_ROOT_KEY is not configured');
    return;
  }

  const keyVersion = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
  const rootKeyHex = env.OBJECT_ENCRYPTION_ROOT_KEY;
  const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'management-data-export-jobs'
  );
  const piiAdapter = ensureDatabaseAdapter(env.DB_PII, 'management-data-export-pii');
  const pendingRequests = await coreAdapter.query<PendingDataExportRow>(
    `SELECT id, tenant_id, user_id, status, format, include_sections, requested_at
       FROM data_export_requests
      WHERE status IN ('pending', 'processing')
      ORDER BY requested_at ASC
      LIMIT ${DATA_EXPORT_PROCESS_BATCH_LIMIT}`
  );

  for (const request of pendingRequests) {
    if (request.status === 'pending') {
      const claimed = await coreAdapter.execute(
        "UPDATE data_export_requests SET status = 'processing', started_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [Date.now(), request.id, request.tenant_id]
      );
      if ((claimed.rowsAffected ?? 0) === 0) {
        continue;
      }
    }

    try {
      const sections = JSON.parse(request.include_sections) as DataExportSection[];
      const exportedData = await collectExportData(
        coreAdapter,
        piiAdapter,
        request.user_id,
        request.tenant_id,
        sections
      );

      const content =
        request.format === 'csv'
          ? serializeExportDataToCsv(exportedData)
          : JSON.stringify(exportedData, null, 2);
      const contentType = request.format === 'csv' ? 'text/csv' : 'application/json';
      const filePath = buildDataExportObjectKey(request.tenant_id, request.id, request.format);
      const now = Date.now();
      const expiresAt = now + DATA_EXPORT_DOWNLOAD_TTL_MS;

      await coreAdapter.transaction(async (tx) => {
        const { catalogId, primaryObjectKey } = await materializeEncryptedObjectArtifact(
          tx as unknown as DatabaseAdapter,
          env.EXPORT_ARTIFACTS!,
          {
            tenantId: request.tenant_id,
            objectClass: 'user_export',
            representation: representationForExportFormat(request.format),
            objectKeyBase: filePath,
            content,
            contentType,
            rootKeyHex,
            keyVersion,
          }
        );
        await tx.execute(
          `UPDATE data_export_requests
              SET status = 'completed',
                  completed_at = ?,
                  expires_at = ?,
                  file_path = ?,
                  object_catalog_id = ?,
                  file_size = ?,
                  error_message = NULL
            WHERE id = ? AND tenant_id = ?`,
          [
            now,
            expiresAt,
            primaryObjectKey,
            catalogId,
            new TextEncoder().encode(content).byteLength,
            request.id,
            request.tenant_id,
          ]
        );
      });

      logger.info('Data export request materialized', {
        request_id: request.id,
        tenant_id: request.tenant_id,
        format: request.format,
        file_path: filePath,
      });
    } catch (error) {
      await coreAdapter.execute(
        `UPDATE data_export_requests
            SET status = 'failed',
                completed_at = ?,
                error_message = ?
          WHERE id = ? AND tenant_id = ?`,
        [
          Date.now(),
          error instanceof Error ? error.message : String(error),
          request.id,
          request.tenant_id,
        ]
      );
      logger.error(
        'Data export request processing failed',
        { request_id: request.id },
        error as Error
      );
    }
  }
}

/**
 * Estimate export data size (simplified)
 */
async function estimateExportSize(
  adapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  tenantId: string,
  userId: string,
  sections: DataExportSection[]
): Promise<number> {
  let totalSize = 0;

  // Estimate ~500 bytes per consent record
  if (sections.includes('consents')) {
    const consents = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM oauth_client_consents WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    totalSize += (consents[0]?.count || 0) * 500;
  }

  // Estimate ~200 bytes per session
  if (sections.includes('sessions')) {
    const sessions = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    totalSize += (sessions[0]?.count || 0) * 200;
  }

  // Estimate ~300 bytes per audit log entry
  if (sections.includes('audit_log')) {
    const logs = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM consent_history WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    totalSize += (logs[0]?.count || 0) * 300;
  }

  // Estimate ~400 bytes per passkey
  if (sections.includes('passkeys')) {
    const passkeys = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM user_passkeys WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    totalSize += (passkeys[0]?.count || 0) * 400;
  }

  // Add base overhead for profile
  if (sections.includes('profile')) {
    totalSize += 2000; // Profile data estimate
  }

  return totalSize;
}

/**
 * Convert Unix timestamp to ISO string
 */
function toISOString(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Collect user data for export
 */
async function collectExportData(
  coreAdapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  piiAdapter: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> } | null,
  userId: string,
  tenantId: string,
  sections: DataExportSection[]
): Promise<ExportedUserData> {
  const now = Date.now();
  const exportedData: ExportedUserData = {
    metadata: {
      exportedAt: toISOString(now),
      format: 'json',
      version: '1.0',
      userId,
      tenantId,
    },
  };

  // Collect profile data
  if (sections.includes('profile')) {
    // Core user data
    const coreUser = await coreAdapter.query<{
      id: string;
      email_domain_hash: string | null;
      created_at: number;
      updated_at: number;
      email_verified: number | null;
      phone_number_verified: number | null;
    }>(
      `SELECT id, email_domain_hash, created_at, updated_at, email_verified, phone_number_verified
       FROM users_core WHERE id = ? AND tenant_id = ?`,
      [userId, tenantId]
    );

    // PII data (if available)
    let piiData: {
      email?: string;
      phone_number?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      middle_name?: string;
      nickname?: string;
      preferred_username?: string;
      picture?: string;
      website?: string;
      gender?: string;
      birthdate?: string;
      zoneinfo?: string;
      locale?: string;
    } = {};
    if (piiAdapter) {
      const piiUser = await piiAdapter.query<{
        email?: string;
        phone_number?: string;
        name?: string;
        given_name?: string;
        family_name?: string;
        middle_name?: string;
        nickname?: string;
        preferred_username?: string;
        picture?: string;
        website?: string;
        gender?: string;
        birthdate?: string;
        zoneinfo?: string;
        locale?: string;
      }>('SELECT * FROM users_pii WHERE id = ? AND tenant_id = ?', [userId, tenantId]);
      if (piiUser.length > 0) {
        piiData = piiUser[0];
      }
    }

    if (coreUser.length > 0) {
      exportedData.profile = {
        id: coreUser[0].id,
        email: piiData.email ?? '',
        emailVerified: coreUser[0].email_verified === 1,
        phoneNumber: piiData.phone_number,
        phoneNumberVerified: coreUser[0].phone_number_verified === 1,
        name: piiData.name,
        givenName: piiData.given_name,
        familyName: piiData.family_name,
        middleName: piiData.middle_name,
        nickname: piiData.nickname,
        preferredUsername: piiData.preferred_username,
        picture: piiData.picture,
        website: piiData.website,
        gender: piiData.gender,
        birthdate: piiData.birthdate,
        zoneinfo: piiData.zoneinfo,
        locale: piiData.locale,
        createdAt: toISOString(coreUser[0].created_at),
        updatedAt: toISOString(coreUser[0].updated_at),
      };
    }
  }

  // Collect consents
  if (sections.includes('consents')) {
    const consents = await coreAdapter.query<{
      client_id: string;
      scope: string;
      selected_scopes: string | null;
      granted_at: number;
      expires_at: number | null;
      privacy_policy_version: string | null;
      tos_version: string | null;
    }>(
      `SELECT client_id, scope, selected_scopes, granted_at, expires_at,
              privacy_policy_version, tos_version
       FROM oauth_client_consents
       WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId]
    );

    exportedData.consents = consents.map((c) => ({
      clientId: c.client_id,
      scopes: c.scope.split(' '),
      selectedScopes: c.selected_scopes ? JSON.parse(c.selected_scopes) : undefined,
      grantedAt: toISOString(c.granted_at),
      expiresAt: c.expires_at ? toISOString(c.expires_at) : undefined,
      policyVersions:
        c.privacy_policy_version || c.tos_version
          ? {
              privacyPolicy: c.privacy_policy_version ?? undefined,
              termsOfService: c.tos_version ?? undefined,
            }
          : undefined,
    }));
  }

  // Collect active sessions (without sensitive data)
  if (sections.includes('sessions')) {
    const sessions = await coreAdapter.query<{
      id: string;
      created_at: number;
      expires_at: number;
      last_activity_at: number | null;
    }>(
      `SELECT id, created_at, expires_at, last_activity_at
       FROM sessions
       WHERE tenant_id = ? AND user_id = ? AND expires_at > ?`,
      [tenantId, userId, now]
    );

    exportedData.sessions = sessions.map((s) => ({
      id: s.id,
      createdAt: toISOString(s.created_at),
      expiresAt: toISOString(s.expires_at),
      lastActiveAt: s.last_activity_at ? toISOString(s.last_activity_at) : undefined,
    }));
  }

  // Collect consent history (audit log)
  if (sections.includes('audit_log')) {
    const history = await coreAdapter.query<{
      client_id: string;
      action: string;
      scopes_before: string | null;
      scopes_after: string | null;
      created_at: number;
    }>(
      `SELECT client_id, action, scopes_before, scopes_after, created_at
       FROM consent_history
       WHERE tenant_id = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [tenantId, userId]
    );

    exportedData.consentHistory = history.map((h) => ({
      action: h.action,
      clientId: h.client_id,
      scopesBefore: h.scopes_before ? JSON.parse(h.scopes_before) : undefined,
      scopesAfter: h.scopes_after ? JSON.parse(h.scopes_after) : undefined,
      timestamp: toISOString(h.created_at),
    }));
  }

  // Collect passkeys (minimal info for portability)
  if (sections.includes('passkeys')) {
    const passkeys = await coreAdapter.query<{
      id: string;
      created_at: number;
      last_used_at: number | null;
      name: string | null;
    }>(
      `SELECT id, created_at, last_used_at, name
       FROM user_passkeys
       WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId]
    );

    exportedData.passkeys = passkeys.map((p) => ({
      id: p.id,
      deviceName: p.name ?? undefined,
      createdAt: toISOString(p.created_at),
      lastUsedAt: p.last_used_at ? toISOString(p.last_used_at) : undefined,
    }));
  }

  return exportedData;
}
