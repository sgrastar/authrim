/**
 * Admin Jobs API Endpoints
 *
 * Async job management for administrative bulk operations:
 * - GET  /api/admin/jobs          - List all jobs with cursor-based pagination
 * - GET  /api/admin/jobs/:id      - Get job status
 * - GET  /api/admin/jobs/:id/result - Get job result (completed/partial_failure only)
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Rate limit: moderate profile
 * - Tenant isolation: All queries filtered by tenant_id
 *
 * @packageDocumentation
 */

import type { Context, Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  requireAdminPermissions,
  requireAnyRole,
  createAuthContextFromHono,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
  listObjectCatalogObjects,
  type AdminAuthContext,
  type ObjectCatalogListResult,
  type ObjectCatalogPhysicalRecord,
  type ObjectRepresentation,
  readR2ObjectTextWithLimit,
} from '@authrim/ar-lib-core';
import {
  loadCatalogObjectArtifact,
  loadCatalogObjectRepresentation,
} from '@authrim/ar-lib-core/services/object-artifact-store';
import { z } from 'zod';
import {
  auditAdminSensitiveRead,
  requireAdminPermissionOrElevationGrant,
  type AdminElevationAccessResolution,
} from './admin-elevation-access';
import {
  listAdminJobTypeDefinitions,
  getAdminJobResultObjectClass,
  isAdminJobTypeCreatableFromAdminApi,
} from './admin-job-types';
import { countBulkUserUpdateTargets, validateBulkUserUpdateConfig } from './admin-job-executor';
import {
  USER_IMPORT_MAX_UPLOAD_BYTES,
  buildUserImportResultKey,
  buildUserImportUploadKey,
  sanitizeUserImportFilename,
} from './user-import-jobs';

const ADMIN_JOB_MANAGER_ROLES = ['system_admin', 'distributor_admin', 'tenant_admin'];
const TENANT_D1_STORAGE_PROFILE_ID = 'builtin:storage:tenant-d1';

export function registerAdminJobPermissionMiddleware(app: Hono<any, any, any>) {
  app.use('/api/admin/jobs', requireAnyRole(ADMIN_JOB_MANAGER_ROLES));
  app.use('/api/admin/jobs/*', requireAnyRole(ADMIN_JOB_MANAGER_ROLES));

  app.use('/api/admin/jobs', requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ]));
  app.use(
    '/api/admin/jobs/users/import/upload-url',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use(
    '/api/admin/jobs/users/import/upload/:upload_id',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use('/api/admin/jobs/users/import', requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE]));
  app.use(
    '/api/admin/jobs/users/bulk-update',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use(
    '/api/admin/jobs/tenant-databases/provision',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use(
    '/api/admin/jobs/tenant-databases/activate-batch',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use(
    '/api/admin/jobs/reports/generate',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use(
    '/api/admin/jobs/organizations/:id/bulk-members',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_WRITE])
  );
  app.use('/api/admin/jobs/types', requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ]));
  app.use(
    '/api/admin/jobs/artifacts/:artifactId',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ])
  );
  app.use(
    '/api/admin/jobs/artifacts/:artifactId/download',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ])
  );
  app.use(
    '/api/admin/jobs/artifacts/:artifactId/chunks/:index',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ])
  );
  app.use('/api/admin/jobs/:id/result', requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ]));
  app.use(
    '/api/admin/jobs/:id/result/download',
    requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ])
  );
  app.use('/api/admin/jobs/:id', requireAdminPermissions([ADMIN_PERMISSIONS.JOBS_READ]));
}

// =============================================================================
// Types
// =============================================================================

/**
 * Job status values
 */
type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'partial_failure';

/**
 * Job failure entry
 */
interface JobFailure {
  row?: number;
  error_code: string;
  field?: string;
  message?: string;
}

/**
 * Job result summary
 */
interface JobResultSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped?: number;
}

/**
 * Job database row
 */
interface JobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  status: JobStatus;
  progress: string | null;
  config: string | null;
  input_r2_key: string | null;
  result_r2_key: string | null;
  object_catalog_id: string | null;
  public_artifact_id?: string | null;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  estimated_completion: number | null;
  attempt_count?: number | null;
  max_attempts?: number | null;
  next_run_at?: number | null;
  dead_lettered_at?: number | null;
}

type JobArtifactFormat = 'json' | 'csv';

interface JobArtifactManifestObject {
  format: JobArtifactFormat | null;
  representation: ObjectRepresentation;
  objectKind: 'single' | 'manifest' | 'chunk';
  objectIndex: number;
  totalBytes?: number | null;
  checksumSha256?: string | null;
  downloadUrl?: string;
  chunkUrl?: string;
}

interface JobArtifactManifestResponse {
  artifactId: string;
  jobId: string;
  jobType: string;
  status: JobStatus;
  defaultFormat: JobArtifactFormat;
  availableFormats: JobArtifactFormat[];
  objectClass: string;
  createdAt: number;
  objects: JobArtifactManifestObject[];
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Job error codes (defined in plan for SDK stability)
 */
export const JOB_ERROR_CODES = {
  // Validation errors
  invalid_email: 'Invalid email format',
  invalid_phone: 'Invalid phone format',
  invalid_date: 'Invalid date format',
  missing_required: 'Required field missing',
  value_too_long: 'Value exceeds maximum length',
  value_too_short: 'Value below minimum length',

  // Duplicate errors
  duplicate_email: 'Email already exists',
  duplicate_user: 'User already exists',
  duplicate_external_id: 'External ID already exists',

  // Reference errors
  org_not_found: 'Organization not found',
  role_not_found: 'Role not found',
  tenant_mismatch: 'Tenant ID mismatch',

  // Limit errors
  quota_exceeded: 'User quota exceeded',
  rate_limited: 'Rate limit exceeded during processing',

  // System errors
  internal_error: 'Internal processing error',
  timeout: 'Processing timeout',
} as const;

/**
 * Allowed sort fields for jobs list
 */
const ALLOWED_SORT_FIELDS = ['created_at', 'updated_at', 'status', 'job_type'];

/**
 * Allowed filter fields for jobs list
 */
const ALLOWED_FILTER_FIELDS = ['status', 'job_type'];

/**
 * Default and max limits for pagination
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ADMIN_JOB_RESULT_FALLBACK_OBJECT_MAX_BYTES = 10 * 1024 * 1024;
const USER_IMPORT_ALLOWED_CONTENT_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
]);

function jobArtifactFormatForRepresentation(
  representation: ObjectRepresentation
): JobArtifactFormat | null {
  if (representation === 'csv_projection') {
    return 'csv';
  }
  if (representation === 'canonical_json') {
    return 'json';
  }
  return null;
}

function jobArtifactRepresentationForFormat(format: JobArtifactFormat): ObjectRepresentation {
  return format === 'csv' ? 'csv_projection' : 'canonical_json';
}

function normalizeRequestedJobArtifactFormat(
  value: string | undefined,
  fallback: JobArtifactFormat = 'json'
): JobArtifactFormat {
  if (value === 'csv' || value === 'json') {
    return value;
  }
  return fallback;
}

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function expectedObjectClassForJobType(
  jobType: string
): 'user_import_result' | 'admin_job_result' | null {
  return getAdminJobResultObjectClass(jobType);
}

// =============================================================================
// Validation Schemas
// =============================================================================

/**
 * List query schema (cursor-based pagination only)
 */
const ListJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  filter: z.string().optional(),
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create database adapter from context
 */
function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  const tenantId = getTenantIdFromContext(c);
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function getJobResultBucket(env: Env): R2Bucket | null {
  return env.EXPORT_ARTIFACTS ?? null;
}

async function loadJobResultArtifact(
  adapter: DatabaseAdapter,
  env: Env,
  row: Pick<JobRow, 'tenant_id' | 'object_catalog_id' | 'result_r2_key' | 'job_type'>,
  options?: {
    format?: JobArtifactFormat;
    objectIndex?: number;
  }
): Promise<{ content: string; contentType: string } | null> {
  const resultBucket = getJobResultBucket(env);
  if (!resultBucket) {
    return null;
  }

  if (row.object_catalog_id && env.OBJECT_ENCRYPTION_ROOT_KEY) {
    const expectedClass = expectedObjectClassForJobType(row.job_type);
    if (!expectedClass) {
      return null;
    }
    const representation = jobArtifactRepresentationForFormat(options?.format ?? 'json');
    const loaded =
      options?.objectIndex !== undefined
        ? await loadCatalogObjectArtifact(adapter, env, {
            tenantId: row.tenant_id,
            objectCatalogId: row.object_catalog_id,
            representation,
            objectIndex: options.objectIndex,
            expectedClass,
            expectedBucketBinding: 'EXPORT_ARTIFACTS',
            allowPlaintextFallback: false,
          })
        : await loadCatalogObjectRepresentation(adapter, env, {
            tenantId: row.tenant_id,
            objectCatalogId: row.object_catalog_id,
            representation,
            expectedClass,
            expectedBucketBinding: 'EXPORT_ARTIFACTS',
            allowPlaintextFallback: false,
          });
    if (loaded) {
      return {
        content: loaded.content,
        contentType: loaded.contentType,
      };
    }
  }

  if (!row.result_r2_key) {
    return null;
  }

  const object = await resultBucket.get(row.result_r2_key);
  if (!object) {
    return null;
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  return {
    content: await readR2ObjectTextWithLimit(object, ADMIN_JOB_RESULT_FALLBACK_OBJECT_MAX_BYTES),
    contentType: headers.get('Content-Type') || 'application/json',
  };
}

function buildJobResultArtifactFilename(
  jobType: string,
  jobId: string,
  format: JobArtifactFormat
): string {
  const extension = format === 'csv' ? 'csv' : 'json';
  return sanitizeUserImportFilename(`${jobType.replace(/[/:]/g, '-')}-${jobId}.${extension}`);
}

function buildJobResultManifestResponse(
  row: Pick<JobRow, 'id' | 'job_type' | 'status'>,
  catalog: ObjectCatalogListResult
): JobArtifactManifestResponse {
  const objects = catalog.physical.map<JobArtifactManifestObject>(
    (physical: ObjectCatalogPhysicalRecord) => {
      const format = jobArtifactFormatForRepresentation(physical.representation);
      const manifestObject: JobArtifactManifestObject = {
        format,
        representation: physical.representation,
        objectKind: physical.objectKind,
        objectIndex: physical.chunkIndex ?? 0,
        totalBytes: physical.totalBytes,
        checksumSha256: physical.checksumSha256,
      };

      if (physical.objectKind === 'chunk') {
        manifestObject.chunkUrl =
          `/api/admin/jobs/artifacts/${catalog.logical.publicArtifactId}` +
          `/chunks/${physical.chunkIndex ?? 0}${format ? `?format=${format}` : ''}`;
      } else if (format) {
        manifestObject.downloadUrl = `/api/admin/jobs/artifacts/${catalog.logical.publicArtifactId}/download?format=${format}`;
      }

      return manifestObject;
    }
  );

  const availableFormats: JobArtifactFormat[] = Array.from(
    new Set(
      objects
        .map((object: JobArtifactManifestObject) => object.format)
        .filter(
          (format: JobArtifactFormat | null): format is JobArtifactFormat =>
            format === 'json' || format === 'csv'
        )
    )
  );

  return {
    artifactId: catalog.logical.publicArtifactId,
    jobId: row.id,
    jobType: row.job_type,
    status: row.status,
    defaultFormat: availableFormats[0] ?? 'json',
    availableFormats,
    objectClass: catalog.logical.objectClass,
    createdAt: catalog.logical.createdAt,
    objects,
  };
}

interface JobResultArtifactRow {
  id: string;
  tenant_id: string;
  job_type: string;
  status: JobStatus;
  result_r2_key: string | null;
  object_catalog_id: string | null;
  public_artifact_id: string | null;
}

async function getJobResultArtifactRowById(
  adapter: DatabaseAdapter,
  jobId: string,
  tenantId: string
): Promise<JobResultArtifactRow | null> {
  return adapter.queryOne<JobResultArtifactRow>(
    `SELECT aj.id, aj.tenant_id, aj.job_type, aj.status, aj.result_r2_key,
            aj.object_catalog_id, oc.public_artifact_id
       FROM admin_jobs aj
       LEFT JOIN object_catalog oc
         ON oc.id = aj.object_catalog_id
        AND oc.tenant_id = aj.tenant_id
        AND oc.deleted_at IS NULL
      WHERE aj.id = ? AND aj.tenant_id = ?`,
    [jobId, tenantId]
  );
}

async function getJobResultArtifactRowByArtifactId(
  adapter: DatabaseAdapter,
  artifactId: string,
  tenantId: string
): Promise<JobResultArtifactRow | null> {
  return adapter.queryOne<JobResultArtifactRow>(
    `SELECT aj.id, aj.tenant_id, aj.job_type, aj.status, aj.result_r2_key,
            aj.object_catalog_id, oc.public_artifact_id
       FROM admin_jobs aj
       INNER JOIN object_catalog oc
         ON oc.id = aj.object_catalog_id
        AND oc.tenant_id = aj.tenant_id
      WHERE oc.public_artifact_id = ?
        AND oc.deleted_at IS NULL
        AND aj.tenant_id = ?`,
    [artifactId, tenantId]
  );
}

async function requireJobArtifactAccess(
  c: Context<{ Bindings: Env }>,
  row: Pick<JobResultArtifactRow, 'id' | 'job_type' | 'object_catalog_id' | 'public_artifact_id'>,
  artifactId?: string | null
): Promise<Response | AdminElevationAccessResolution> {
  const resourceClass = expectedObjectClassForJobType(row.job_type);
  if (!resourceClass) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  return requireAdminPermissionOrElevationGrant(c as any, {
    directPermission: ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ,
    requestSurface: 'admin_jobs',
    requestedAction: 'artifact_read',
    resourceClass,
    resourceIds: [row.id, artifactId ?? row.public_artifact_id, row.object_catalog_id],
    detailClass: 'job_result_artifact',
    targetAudience: 'admin_api',
  });
}

/**
 * Parse filter string into filter object
 * Format: "status=completed,job_type=users/import"
 */
function parseFilter(filter: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = filter.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
}

/**
 * Validate filter fields against allowlist
 */
function validateFilterFields(filter: string): { valid: boolean; error?: string } {
  const parsed = parseFilter(filter);
  const fields = Object.keys(parsed);
  const invalid = fields.filter((f) => !ALLOWED_FILTER_FIELDS.includes(f));
  if (invalid.length > 0) {
    return { valid: false, error: `Invalid filter fields: ${invalid.join(', ')}` };
  }
  return { valid: true };
}

/**
 * Validate sort field against allowlist
 */
function validateSortField(sort: string): { valid: boolean; error?: string } {
  const field = sort.replace(/^-/, '');
  if (!ALLOWED_SORT_FIELDS.includes(field)) {
    return { valid: false, error: `Invalid sort field: ${field}` };
  }
  return { valid: true };
}

/**
 * Encode cursor from job ID and created_at
 */
function encodeCursor(id: string, createdAt: number): string {
  return Buffer.from(JSON.stringify({ id, created_at: createdAt })).toString('base64url');
}

/**
 * Cursor data type for pagination
 */
interface CursorData {
  id: string;
  created_at: number;
}

/**
 * Decode cursor to get job ID and created_at
 */
function decodeCursor(cursor: string): CursorData | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorData>;
    if (parsed.id && typeof parsed.created_at === 'number') {
      return { id: parsed.id, created_at: parsed.created_at };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert Unix timestamp (seconds) to ISO 8601 string
 */
function toISOString(timestamp: number | null): string | null {
  if (!timestamp) return null;
  // Handle both seconds and milliseconds
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Date(ms).toISOString();
}

/**
 * Job progress structure for formatting
 */
interface JobProgress {
  total?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  stage?: string;
}

const SUPPORT_OPS_SNAPSHOT_JOB_TYPE = 'support-ops/cohort-snapshot';
const SUPPORT_OPS_JOB_COUNT_PRECISION = 10;

function bucketSupportOpsJobCount(value: unknown): number | null {
  const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (count > 0 && count < SUPPORT_OPS_JOB_COUNT_PRECISION) {
    return null;
  }
  return Math.floor(count / SUPPORT_OPS_JOB_COUNT_PRECISION) * SUPPORT_OPS_JOB_COUNT_PRECISION;
}

function sanitizeSupportOpsJobProgress(
  progress: JobProgress | null
): Record<string, unknown> | null {
  if (!progress) {
    return null;
  }
  return {
    stage: typeof progress.stage === 'string' ? progress.stage : undefined,
    total: bucketSupportOpsJobCount(progress.total),
    processed: bucketSupportOpsJobCount(progress.processed),
    succeeded: bucketSupportOpsJobCount(progress.succeeded),
    failed: bucketSupportOpsJobCount(progress.failed),
    privacy: {
      count_exact: false,
      count_precision: SUPPORT_OPS_JOB_COUNT_PRECISION,
    },
  };
}

/**
 * Format job row for API response
 */
function formatJob(row: JobRow) {
  let progress: JobProgress | null = null;
  if (row.progress) {
    try {
      progress = JSON.parse(row.progress) as JobProgress;
    } catch {
      progress = null;
    }
  }

  return {
    job_id: row.id,
    type: row.job_type,
    status: row.status,
    progress:
      row.job_type === SUPPORT_OPS_SNAPSHOT_JOB_TYPE
        ? sanitizeSupportOpsJobProgress(progress)
        : progress,
    created_by: row.created_by,
    created_at: toISOString(row.created_at),
    updated_at: toISOString(row.updated_at),
    started_at: toISOString(row.started_at),
    completed_at: toISOString(row.completed_at),
    estimated_completion: toISOString(row.estimated_completion),
    next_run_at: toISOString(row.next_run_at ?? null),
    attempts: row.attempt_count ?? 0,
    max_attempts: row.max_attempts ?? 3,
    dead_lettered_at: toISOString(row.dead_lettered_at ?? null),
    ...(row.error_code && { error_code: row.error_code }),
    ...(row.error_message && { error_message: row.error_message }),
  };
}

/**
 * Parsed job result structure
 */
interface ParsedJobResult {
  summary?: JobResultSummary;
  failures?: JobFailure[];
  logs?: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    code: string;
    message: string;
    row?: number;
    email?: string;
  }>;
}

/**
 * Format job result for API response
 */
function formatJobResult(row: JobRow) {
  let summary: JobResultSummary | null = null;
  let failures: JobFailure[] = [];
  let logs: ParsedJobResult['logs'] = [];

  if (row.result) {
    try {
      const parsed = JSON.parse(row.result) as ParsedJobResult;
      summary = parsed.summary ?? null;
      failures = parsed.failures ?? [];
      logs = parsed.logs ?? [];
    } catch {
      // Invalid JSON, ignore
    }
  }

  return {
    job_id: row.id,
    summary,
    failures,
    logs,
    ...(row.public_artifact_id && {
      artifact_id: row.public_artifact_id,
      available_formats: ['json'],
      manifest_url: `/api/admin/jobs/artifacts/${row.public_artifact_id}`,
    }),
    ...((row.object_catalog_id || row.result_r2_key) && {
      download_url: `/api/admin/jobs/${row.id}/result/download`,
    }),
  };
}

function parseJobConfig(
  config: string | null,
  jobType?: string
): Record<string, unknown> | undefined {
  if (!config) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    if (jobType !== SUPPORT_OPS_SNAPSHOT_JOB_TYPE) {
      return parsed;
    }
    return {
      cohort_id: parsed.cohort_id,
      resource: parsed.resource,
      intended_action: parsed.intended_action,
      selector_hash: parsed.selector_hash,
      support_case_id: parsed.support_case_id ?? null,
    };
  } catch {
    return undefined;
  }
}

// =============================================================================
// Handlers
// =============================================================================

function createUnsupportedJobTypeResponse(
  c: Context<{ Bindings: Env }>,
  jobType: string
): Promise<Response> {
  return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED, {
    variables: {
      field: 'job_type',
      value: jobType,
      reason: 'This job type is not enabled because its processor is not implemented.',
    },
  });
}

/**
 * GET /api/admin/jobs
 * List all jobs for the tenant with cursor-based pagination
 */
export async function adminJobsListHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  // Reject page-based pagination (plan specification)
  const page = c.req.query('page');
  const pageSize = c.req.query('page_size');
  if (page || pageSize) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'pagination',
        reason: 'Use cursor-based pagination. page/page_size not supported.',
      },
    });
  }

  // Parse and validate query parameters
  const rawQuery = {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    sort: c.req.query('sort'),
    filter: c.req.query('filter'),
  };

  const parseResult = ListJobsQuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'query',
        reason: parseResult.error.issues.map((i) => i.message).join(', '),
      },
    });
  }

  const query = parseResult.data;

  // Validate filter fields
  if (query.filter) {
    const filterValidation = validateFilterFields(query.filter);
    if (!filterValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'filter', reason: filterValidation.error ?? 'Invalid filter' },
      });
    }
  }

  // Validate sort field
  if (query.sort) {
    const sortValidation = validateSortField(query.sort);
    if (!sortValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'sort', reason: sortValidation.error ?? 'Invalid sort field' },
      });
    }
  }

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    let cursorData: { id: string; created_at: number } | null = null;
    if (query.cursor) {
      cursorData = decodeCursor(query.cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      // Cursor-based pagination: get rows after the cursor
      whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (query.filter) {
      const filters = parseFilter(query.filter);
      for (const [key, value] of Object.entries(filters)) {
        if (key === 'status') {
          whereClauses.push('status = ?');
          bindings.push(value);
        } else if (key === 'job_type') {
          whereClauses.push('job_type = ?');
          bindings.push(value);
        }
      }
    }

    // Build ORDER BY
    let orderBy = 'created_at DESC, id ASC';
    if (query.sort) {
      const desc = query.sort.startsWith('-');
      const field = query.sort.replace(/^-/, '');
      orderBy = `${field} ${desc ? 'DESC' : 'ASC'}, id ASC`;
    }

    // Fetch one extra row to determine has_more
    const limitPlusOne = query.limit + 1;
    const sql = `
      SELECT id, tenant_id, job_type, status, progress, error_code, error_message,
             created_by, created_at, updated_at, started_at, completed_at, estimated_completion,
             attempt_count, max_attempts, next_run_at, dead_lettered_at
      FROM admin_jobs
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<JobRow>(sql, bindings);

    // Determine has_more and trim results
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    // Generate next cursor
    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.created_at);
    }

    return c.json({
      data: data.map(formatJob),
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to list jobs', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/jobs/:id
 * Get job status by ID
 */
export async function adminJobGetHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const jobId = c.req.param('id')!;

  if (!jobId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const row = await adapter.queryOne<JobRow>(
      `SELECT id, tenant_id, job_type, status, progress, config, error_code, error_message,
              created_by, created_at, updated_at, started_at, completed_at, estimated_completion,
              attempt_count, max_attempts, next_run_at, dead_lettered_at
       FROM admin_jobs
       WHERE id = ? AND tenant_id = ?`,
      [jobId, tenantId]
    );

    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({
      ...formatJob(row),
      ...(parseJobConfig(row.config, row.job_type)
        ? { parameters: parseJobConfig(row.config, row.job_type) }
        : {}),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to get job', { jobId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminJobTypesHandler(c: Context<{ Bindings: Env }>) {
  return c.json({
    result_delivery_options: [
      {
        value: 'auto',
        description:
          'Inline small results and materialize large results when artifact storage is configured.',
      },
      {
        value: 'inline',
        description: 'Keep the result summary in admin_jobs.result.',
      },
      {
        value: 'artifact',
        description:
          'Require encrypted EXPORT_ARTIFACTS materialization and expose artifact download metadata.',
      },
    ],
    job_types: listAdminJobTypeDefinitions().map((definition) => ({
      job_type: definition.jobType,
      processor_status: definition.processorStatus,
      creatable_from_admin_api: definition.creatableFromAdminApi,
      result_object_class: definition.resultObjectClass ?? null,
      supported_result_delivery: definition.supportedResultDelivery ?? [],
      create_endpoint: definition.createEndpoint ?? null,
      notes: definition.notes ?? null,
    })),
  });
}

/**
 * GET /api/admin/jobs/:id/result/download
 * Download full job result artifact from R2
 */
export async function adminJobResultDownloadHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const jobId = c.req.param('id')!;

  if (!jobId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const adapter = createAdapter(c);
    const row = await getJobResultArtifactRowById(adapter, jobId, tenantId);

    if (!row || (!row.result_r2_key && !row.object_catalog_id)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result', id: jobId },
      });
    }

    const access = await requireJobArtifactAccess(c, row);
    if (access instanceof Response) {
      return access;
    }

    const view = c.req.query('view');
    const requestedFormat =
      view === 'manifest' ? null : normalizeRequestedJobArtifactFormat(c.req.query('format'));
    if (view === 'manifest') {
      if (!row.object_catalog_id || !row.public_artifact_id) {
        return c.json(
          {
            error: 'not_supported',
            error_description: 'Manifest view is only available for object-backed job results',
          },
          409
        );
      }

      const catalog = await listObjectCatalogObjects(adapter, tenantId, row.object_catalog_id);
      if (!catalog) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'job_result_manifest', id: jobId },
        });
      }

      await auditAdminSensitiveRead(c as any, access, {
        action: 'admin_job.artifact_manifest_read',
        resourceType: 'admin_job',
        resourceId: row.id,
        metadata: {
          artifact_id: row.public_artifact_id ?? null,
          route: 'job_result_manifest',
        },
      });

      return c.json(buildJobResultManifestResponse(row, catalog));
    }

    const artifact = await loadJobResultArtifact(adapter, c.env, row, {
      format: requestedFormat ?? 'json',
    });
    if (!artifact) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result', id: jobId },
      });
    }

    await auditAdminSensitiveRead(c as any, access, {
      action: 'admin_job.artifact_download',
      resourceType: 'admin_job',
      resourceId: row.id,
      metadata: {
        artifact_id: row.public_artifact_id ?? null,
        route: 'job_result_download',
        format: requestedFormat,
      },
    });

    const headers = new Headers();
    headers.set(
      'Content-Type',
      artifact.contentType || (requestedFormat === 'csv' ? 'text/csv' : 'application/json')
    );
    headers.set(
      'Content-Disposition',
      `attachment; filename="${buildJobResultArtifactFilename(row.job_type, jobId, requestedFormat ?? 'json')}"`
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store');
    return new Response(artifact.content, {
      status: 200,
      headers,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to download job result', { jobId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/jobs/:id/result
 * Get job result (only available for completed/partial_failure jobs)
 */
export async function adminJobResultHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const jobId = c.req.param('id')!;

  if (!jobId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const row = await adapter.queryOne<JobRow>(
      `SELECT aj.id, aj.tenant_id, aj.job_type, aj.status, aj.result, aj.result_r2_key,
              aj.object_catalog_id, oc.public_artifact_id
       FROM admin_jobs aj
       LEFT JOIN object_catalog oc
         ON oc.id = aj.object_catalog_id
        AND oc.tenant_id = aj.tenant_id
        AND oc.deleted_at IS NULL
       WHERE aj.id = ? AND aj.tenant_id = ?`,
      [jobId, tenantId]
    );

    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Result only available for completed or partial_failure status
    if (row.status !== 'completed' && row.status !== 'partial_failure') {
      return c.json(
        {
          error: 'result_not_available',
          error_description: `Job result is only available for completed or partial_failure jobs. Current status: ${row.status}`,
        },
        400
      );
    }

    const result = formatJobResult(row);

    // Note: If result is stored in R2, the download_url will be the R2 key.
    // Actual signed URL generation should be handled by a separate endpoint
    // or when R2 bucket is properly configured in Env type.
    // For now, result.download_url will be set from result_r2_key if present.

    return c.json(result);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to get job result', { jobId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminJobResultArtifactManifestHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const artifactId = c.req.param('artifactId')!;

  if (!artifactId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'artifactId' },
    });
  }

  try {
    const adapter = createAdapter(c);
    const row = await getJobResultArtifactRowByArtifactId(adapter, artifactId, tenantId);
    if (!row || !row.object_catalog_id || !row.public_artifact_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_artifact', id: artifactId },
      });
    }

    const access = await requireJobArtifactAccess(c, row, artifactId);
    if (access instanceof Response) {
      return access;
    }

    const catalog = await listObjectCatalogObjects(adapter, tenantId, row.object_catalog_id);
    if (!catalog) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_manifest', id: artifactId },
      });
    }

    await auditAdminSensitiveRead(c as any, access, {
      action: 'admin_job.artifact_manifest_read',
      resourceType: 'admin_job',
      resourceId: row.id,
      metadata: {
        artifact_id: artifactId,
        route: 'artifact_manifest',
      },
    });

    return c.json(buildJobResultManifestResponse(row, catalog));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to get job result artifact manifest', { artifactId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminJobResultArtifactDownloadHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const artifactId = c.req.param('artifactId')!;

  if (!artifactId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'artifactId' },
    });
  }

  try {
    const adapter = createAdapter(c);
    const row = await getJobResultArtifactRowByArtifactId(adapter, artifactId, tenantId);
    if (!row || (!row.result_r2_key && !row.object_catalog_id)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_artifact', id: artifactId },
      });
    }

    const access = await requireJobArtifactAccess(c, row, artifactId);
    if (access instanceof Response) {
      return access;
    }

    const requestedFormat = normalizeRequestedJobArtifactFormat(c.req.query('format'));
    const artifact = await loadJobResultArtifact(adapter, c.env, row, {
      format: requestedFormat,
    });
    if (!artifact) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_artifact', id: artifactId },
      });
    }

    await auditAdminSensitiveRead(c as any, access, {
      action: 'admin_job.artifact_download',
      resourceType: 'admin_job',
      resourceId: row.id,
      metadata: {
        artifact_id: artifactId,
        route: 'artifact_download',
        format: requestedFormat,
      },
    });

    const headers = new Headers();
    headers.set(
      'Content-Type',
      artifact.contentType || (requestedFormat === 'csv' ? 'text/csv' : 'application/json')
    );
    headers.set(
      'Content-Disposition',
      `attachment; filename="${buildJobResultArtifactFilename(row.job_type, row.id, requestedFormat)}"`
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store');
    return new Response(artifact.content, {
      status: 200,
      headers,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to download job result artifact', { artifactId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

export async function adminJobResultArtifactChunkHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const artifactId = c.req.param('artifactId')!;
  const chunkIndex = Number.parseInt(c.req.param('index') || '0', 10);

  if (!artifactId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'artifactId' },
    });
  }

  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'index', reason: 'Chunk index must be a non-negative integer' },
    });
  }

  try {
    const adapter = createAdapter(c);
    const row = await getJobResultArtifactRowByArtifactId(adapter, artifactId, tenantId);
    if (!row || !row.object_catalog_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_artifact', id: artifactId },
      });
    }

    const access = await requireJobArtifactAccess(c, row, artifactId);
    if (access instanceof Response) {
      return access;
    }

    const requestedFormat = normalizeRequestedJobArtifactFormat(c.req.query('format'));
    const artifact = await loadJobResultArtifact(adapter, c.env, row, {
      format: requestedFormat,
      objectIndex: chunkIndex,
    });
    if (!artifact) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'job_result_chunk', id: `${artifactId}:${chunkIndex}` },
      });
    }

    await auditAdminSensitiveRead(c as any, access, {
      action: 'admin_job.artifact_chunk_read',
      resourceType: 'admin_job',
      resourceId: row.id,
      metadata: {
        artifact_id: artifactId,
        route: 'artifact_chunk',
        chunk_index: chunkIndex,
        format: requestedFormat,
      },
    });

    const headers = new Headers();
    headers.set(
      'Content-Type',
      artifact.contentType || (requestedFormat === 'csv' ? 'text/csv' : 'application/json')
    );
    headers.set(
      'Content-Disposition',
      `attachment; filename="${buildJobResultArtifactFilename(row.job_type, row.id, requestedFormat)}"`
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store');
    return new Response(artifact.content, {
      status: 200,
      headers,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error(
      'Failed to download job result artifact chunk',
      { artifactId, chunkIndex },
      error as Error
    );
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2: Job Creation Endpoints
// =============================================================================

/**
 * Import options
 */
const ImportOptionsSchema = z.object({
  skip_header: z.boolean().default(true),
  on_duplicate: z.enum(['update', 'skip', 'error']).default('skip'),
  validate_only: z.boolean().default(false),
});

const JobResultDeliverySchema = z.enum(['auto', 'inline', 'artifact']).default('auto');

/**
 * Bulk update options
 */
const BulkUpdateOptionsSchema = z.object({
  fields: z.array(z.string()).min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  values: z.record(z.string(), z.unknown()),
  dry_run: z.boolean().default(false),
  batch_size: z.number().int().min(1).max(1000).optional(),
  result_delivery: JobResultDeliverySchema,
});

const TenantDatabaseProvisionOptionsSchema = z.object({
  tenant_slug: z.string().trim().min(1).max(128).optional(),
  generation: z.number().int().min(1).optional(),
  activate: z.boolean().default(false),
  execution_mode: z.enum(['plan_only', 'operator_cli']).default('plan_only'),
  reason: z.string().trim().min(1).max(500).optional(),
});

const TenantDatabaseActivateBatchOptionsSchema = z.object({
  activation_batch_id: z.string().trim().min(1).max(128).optional(),
  targets: z
    .array(
      z.object({
        tenant_id: z.string().trim().min(1).max(128),
        generation: z.number().int().min(1),
        roles: z
          .array(z.enum(['tenant_core', 'tenant_pii']))
          .min(1)
          .optional(),
      })
    )
    .min(1)
    .max(500),
  scheduled_window: z
    .object({
      not_before: z.string().datetime().optional(),
      not_after: z.string().datetime().optional(),
      timezone: z.string().trim().min(1).max(64).optional(),
    })
    .optional(),
  require_health_check: z.boolean().default(true),
  require_binding_reconciliation: z.boolean().default(true),
  execution_mode: z.enum(['plan_only', 'operator_cli']).default('plan_only'),
  reason: z.string().trim().min(1).max(500).optional(),
});

/**
 * Report options
 */
const ReportOptionsSchema = z.object({
  type: z.enum(['user_activity', 'access_summary', 'compliance_audit', 'security_events']),
  from_date: z.string().datetime(),
  to_date: z.string().datetime(),
  format: z.enum(['json', 'csv']).default('json'),
  filters: z.record(z.string(), z.unknown()).optional(),
  result_delivery: JobResultDeliverySchema,
});

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): { adminId?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get('adminAuth') as { adminId?: string } | null;
}

function getStorageOperatorAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get('adminAuth') as AdminAuthContext | null;
}

function isSystemStorageOperator(auth: AdminAuthContext | null): boolean {
  const roles = auth?.roles ?? [];
  return roles.includes('system_admin') || roles.includes('super_admin');
}

/**
 * POST /api/admin/jobs/users/import/upload-url
 * Get a presigned URL for uploading import file to R2
 */
export async function adminJobsImportUploadUrlHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const body = await c.req.json<{
      filename: string;
      content_type: string;
      size_bytes: number;
      checksum_sha256?: string;
    }>();

    if (!c.env.IMPORT_ARTIFACTS) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
        variables: { reason: 'IMPORT_ARTIFACTS binding is not configured' },
      });
    }

    // Validate request
    if (!body.filename || typeof body.filename !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'filename' },
      });
    }

    if (!body.content_type || !USER_IMPORT_ALLOWED_CONTENT_TYPES.has(body.content_type)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'content_type', reason: 'Only CSV uploads are supported' },
      });
    }

    if (!body.size_bytes || body.size_bytes > USER_IMPORT_MAX_UPLOAD_BYTES) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'size_bytes',
          reason: `Maximum file size is ${USER_IMPORT_MAX_UPLOAD_BYTES} bytes`,
        },
      });
    }

    const uploadId = crypto.randomUUID();
    const sanitizedFilename = sanitizeUserImportFilename(body.filename);
    const r2Key = buildUserImportUploadKey(tenantId, uploadId, sanitizedFilename);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    return c.json({
      upload_url: `/api/admin/jobs/users/import/upload/${uploadId}?filename=${encodeURIComponent(sanitizedFilename)}`,
      upload_method: 'PUT',
      file_key: r2Key,
      r2_key: r2Key,
      expires_at: expiresAt.toISOString(),
      upload_id: uploadId,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to generate upload URL', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/jobs/users/import/upload/:upload_id
 * Upload CSV payload to the dedicated import artifact bucket.
 */
export async function adminJobsImportUploadHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const uploadId = c.req.param('upload_id')!;
  const filename = c.req.query('filename');

  if (!c.env.IMPORT_ARTIFACTS) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
      variables: { reason: 'IMPORT_ARTIFACTS binding is not configured' },
    });
  }

  if (!uploadId || !filename) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: !uploadId ? 'upload_id' : 'filename' },
    });
  }

  const contentType = c.req.header('Content-Type') || 'text/csv';
  if (!USER_IMPORT_ALLOWED_CONTENT_TYPES.has(contentType)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'content_type', reason: 'Only CSV uploads are supported' },
    });
  }

  try {
    const payload = await c.req.raw.arrayBuffer();
    if (payload.byteLength === 0 || payload.byteLength > USER_IMPORT_MAX_UPLOAD_BYTES) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'size_bytes',
          reason: `Maximum file size is ${USER_IMPORT_MAX_UPLOAD_BYTES} bytes`,
        },
      });
    }

    const payloadBytes = new Uint8Array(payload);
    const checksumSha256 = await sha256HexFromBytes(payloadBytes);
    const key = buildUserImportUploadKey(tenantId, uploadId, filename);
    await c.env.IMPORT_ARTIFACTS.put(key, payload, {
      httpMetadata: {
        contentType: 'text/csv',
      },
      customMetadata: {
        checksum_sha256: checksumSha256,
        uploaded_bytes: String(payload.byteLength),
        content_type: 'text/csv',
      },
    });

    return c.json(
      {
        upload_id: uploadId,
        file_key: key,
        r2_key: key,
        uploaded_bytes: payload.byteLength,
        checksum_sha256: checksumSha256,
        content_type: 'text/csv',
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to upload import artifact', { uploadId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/jobs/users/import
 * Create a user import job
 */
export async function adminJobsUsersImportHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    if (!isAdminJobTypeCreatableFromAdminApi('users/import')) {
      return createUnsupportedJobTypeResponse(c, 'users/import');
    }

    const body = await c.req.json<{
      file_key?: string;
      r2_key?: string;
      size_bytes?: number;
      content_type?: string;
      checksum_sha256?: string;
      options?: z.infer<typeof ImportOptionsSchema>;
    }>();

    if (!c.env.IMPORT_ARTIFACTS) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
        variables: { reason: 'IMPORT_ARTIFACTS binding is not configured' },
      });
    }

    const inputKey = body.file_key ?? body.r2_key;

    if (!inputKey || typeof inputKey !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'file_key' },
      });
    }

    if (!inputKey.startsWith(`imports/${tenantId}/`)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'file_key', reason: 'Import artifact does not belong to the tenant' },
      });
    }

    const inputObject = await c.env.IMPORT_ARTIFACTS.get(inputKey);
    if (!inputObject) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'import_artifact', id: inputKey },
      });
    }

    const metadataHeaders = new Headers();
    inputObject.writeHttpMetadata(metadataHeaders);
    const storedContentType = metadataHeaders.get('Content-Type') || 'application/octet-stream';
    if (!USER_IMPORT_ALLOWED_CONTENT_TYPES.has(storedContentType)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'file_key', reason: 'Stored import artifact is not a CSV upload' },
      });
    }

    const inputBytes = new Uint8Array(await inputObject.arrayBuffer());
    if (inputBytes.byteLength === 0 || inputBytes.byteLength > USER_IMPORT_MAX_UPLOAD_BYTES) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'file_key',
          reason: `Stored import artifact exceeds ${USER_IMPORT_MAX_UPLOAD_BYTES} bytes`,
        },
      });
    }

    const actualChecksumSha256 = await sha256HexFromBytes(inputBytes);
    const storedMetadata = (
      inputObject as unknown as {
        customMetadata?: Record<string, string | undefined>;
      }
    ).customMetadata;
    const storedChecksumSha256 = storedMetadata?.checksum_sha256;
    if (storedChecksumSha256 && storedChecksumSha256 !== actualChecksumSha256) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'file_key', reason: 'Stored import artifact checksum mismatch' },
      });
    }
    if (body.checksum_sha256 && body.checksum_sha256 !== actualChecksumSha256) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'checksum_sha256', reason: 'Import artifact checksum mismatch' },
      });
    }
    if (body.size_bytes !== undefined && body.size_bytes !== inputBytes.byteLength) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'size_bytes',
          reason: 'Import artifact size does not match upload receipt',
        },
      });
    }
    if (body.content_type && body.content_type !== storedContentType) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'content_type',
          reason: 'Import artifact content type does not match upload receipt',
        },
      });
    }

    // Validate options
    let options: z.infer<typeof ImportOptionsSchema> = {
      skip_header: true,
      on_duplicate: 'skip',
      validate_only: false,
    };
    if (body.options) {
      const optionsResult = ImportOptionsSchema.safeParse(body.options);
      if (!optionsResult.success) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: {
            field: 'options',
            reason: optionsResult.error.issues.map((i) => i.message).join(', '),
          },
        });
      }
      options = optionsResult.data;
    }

    const adapter = createAdapter(c);
    const adminAuth = getAdminAuth(c);
    const createdBy = adminAuth?.adminId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    // Estimate completion (5 minutes for import)
    const estimatedCompletion = nowTs + 5 * 60;

    // Create job record
    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config, input_r2_key,
        result_r2_key, created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'users/import',
        'pending',
        JSON.stringify({
          total: 0,
          processed: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          percentage: 0,
          stage: options.validate_only ? 'validation' : 'queued',
        }),
        JSON.stringify(options),
        inputKey,
        buildUserImportResultKey(tenantId, jobId),
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'job.created', 'job', jobId, {
      job_type: 'users/import',
      r2_key: inputKey,
      options,
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        job_type: 'users/import',
        created_at: new Date(nowTs * 1000).toISOString(),
        estimated_completion: new Date(estimatedCompletion * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create import job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/jobs/users/bulk-update
 * Create a bulk user update job
 */
export async function adminJobsUsersBulkUpdateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  if (!isAdminJobTypeCreatableFromAdminApi('users/bulk-update')) {
    return createUnsupportedJobTypeResponse(c, 'users/bulk-update');
  }

  try {
    const body = await c.req.json<z.infer<typeof BulkUpdateOptionsSchema>>();

    const parseResult = BulkUpdateOptionsSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const options = parseResult.data;
    try {
      validateBulkUserUpdateConfig(options);
    } catch (validationError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason:
            validationError instanceof Error
              ? validationError.message
              : 'Invalid bulk update config',
        },
      });
    }

    const adapter = createAdapter(c);
    const adminAuth = getAdminAuth(c);
    const createdBy = adminAuth?.adminId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    const affectedCount = await countBulkUserUpdateTargets(adapter, tenantId, options);

    // Estimate completion (1 minute per 100 users)
    const estimatedDuration = Math.max(60, Math.ceil(affectedCount / 100) * 60);
    const estimatedCompletion = nowTs + estimatedDuration;

    // Create job record
    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'users/bulk-update',
        'pending',
        JSON.stringify({ total: affectedCount, processed: 0, succeeded: 0, failed: 0 }),
        JSON.stringify(options),
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'job.created', 'job', jobId, {
      job_type: 'users/bulk-update',
      affected_users: affectedCount,
      fields: options.fields,
      dry_run: options.dry_run,
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        job_type: 'users/bulk-update',
        affected_users: affectedCount,
        dry_run: options.dry_run,
        created_at: new Date(nowTs * 1000).toISOString(),
        estimated_completion: new Date(estimatedCompletion * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create bulk update job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/jobs/tenant-databases/provision
 * Create a tenant database provisioning/deployment request.
 */
export async function adminJobsTenantDatabaseProvisionHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    if (c.env.DEFAULT_STORAGE_PROFILE_ID === TENANT_D1_STORAGE_PROFILE_ID) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'storage_profile',
          reason:
            'Tenant D1 pool expansion is managed by the setup tool/wrangler, not Admin UI jobs.',
        },
      });
    }

    if (!isAdminJobTypeCreatableFromAdminApi('tenant-database/provision')) {
      return createUnsupportedJobTypeResponse(c, 'tenant-database/provision');
    }

    const adminAuth = getStorageOperatorAuth(c);
    if (!isSystemStorageOperator(adminAuth)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
        variables: {
          reason: 'Tenant database provisioning requires system_admin or super_admin.',
        },
      });
    }

    const parseResult = TenantDatabaseProvisionOptionsSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'request',
          reason: parseResult.error.issues.map((issue) => issue.message).join(', '),
        },
      });
    }

    const options = parseResult.data;
    const adapter = createAdapter(c);
    const createdBy = adminAuth?.userId ?? adminAuth?.actorId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    const result = {
      summary: {
        total: 1,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      },
      deployment_request: {
        execution_mode: options.execution_mode,
        required_operator_steps: [
          'Run authrim-setup tenant-db with the requested tenant, slug, generation, and activation mode.',
          'Deploy generated Worker bindings before activation when activate=true.',
          'Confirm tenant database health and binding reconciliation before runtime cutover.',
        ],
      },
    };

    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        result, created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'tenant-database/provision',
        'pending',
        JSON.stringify({
          total: 1,
          processed: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          percentage: 0,
          stage: 'deployment_request_created',
        }),
        JSON.stringify({
          ...options,
          tenant_id: tenantId,
          requested_from: 'admin_ui',
        }),
        JSON.stringify(result),
        createdBy,
        nowTs,
        nowTs,
        nowTs + 60 * 60,
      ]
    );

    await createAuditLogFromContext(c, 'tenant_database.provision.requested', 'admin_job', jobId, {
      job_type: 'tenant-database/provision',
      tenant_id: tenantId,
      generation: options.generation ?? null,
      activate: options.activate,
      execution_mode: options.execution_mode,
    });

    return c.json(
      {
        job_id: jobId,
        job_type: 'tenant-database/provision',
        status: 'pending',
        tenant_id: tenantId,
        created_by: createdBy,
        created_at: new Date(nowTs * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create tenant database provisioning job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/jobs/tenant-databases/activate-batch
 * Create a tenant database activation batch request.
 */
export async function adminJobsTenantDatabaseActivateBatchHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    if (c.env.DEFAULT_STORAGE_PROFILE_ID === TENANT_D1_STORAGE_PROFILE_ID) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'storage_profile',
          reason:
            'Tenant D1 pool activation is managed by the setup tool/wrangler, not Admin UI jobs.',
        },
      });
    }

    if (!isAdminJobTypeCreatableFromAdminApi('tenant-database/activate-batch')) {
      return createUnsupportedJobTypeResponse(c, 'tenant-database/activate-batch');
    }

    const adminAuth = getStorageOperatorAuth(c);
    if (!isSystemStorageOperator(adminAuth)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
        variables: {
          reason: 'Tenant database activation requires system_admin or super_admin.',
        },
      });
    }

    const parseResult = TenantDatabaseActivateBatchOptionsSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'request',
          reason: parseResult.error.issues.map((issue) => issue.message).join(', '),
        },
      });
    }

    const options = parseResult.data;
    const adapter = createAdapter(c);
    const createdBy = adminAuth?.userId ?? adminAuth?.actorId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    const targetCount = options.targets.length;

    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        result, created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'tenant-database/activate-batch',
        'pending',
        JSON.stringify({
          total: targetCount,
          processed: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          percentage: 0,
          stage: 'activation_request_created',
        }),
        JSON.stringify({
          ...options,
          requested_from: 'admin_ui',
        }),
        JSON.stringify({
          summary: {
            total: targetCount,
            succeeded: 0,
            failed: 0,
            skipped: 0,
          },
          deployment_request: {
            execution_mode: options.execution_mode,
            requires_health_check: options.require_health_check,
            requires_binding_reconciliation: options.require_binding_reconciliation,
          },
        }),
        createdBy,
        nowTs,
        nowTs,
        nowTs + 60 * 60,
      ]
    );

    await createAuditLogFromContext(
      c,
      'tenant_database.activate_batch.requested',
      'admin_job',
      jobId,
      {
        job_type: 'tenant-database/activate-batch',
        target_count: targetCount,
        execution_mode: options.execution_mode,
      }
    );

    return c.json(
      {
        job_id: jobId,
        job_type: 'tenant-database/activate-batch',
        status: 'pending',
        target_count: targetCount,
        created_by: createdBy,
        created_at: new Date(nowTs * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create tenant database activation job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/jobs/reports/generate
 * Create a report generation job
 */
export async function adminJobsReportsGenerateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  if (!isAdminJobTypeCreatableFromAdminApi('reports/generate')) {
    return createUnsupportedJobTypeResponse(c, 'reports/generate');
  }

  try {
    const body = await c.req.json<z.infer<typeof ReportOptionsSchema>>();

    const parseResult = ReportOptionsSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const options = parseResult.data;

    // Validate date range
    const fromDate = new Date(options.from_date);
    const toDate = new Date(options.to_date);
    if (fromDate > toDate) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'from_date', reason: 'from_date must be before to_date' },
      });
    }

    // Max range: 90 days
    const maxRangeDays = 90;
    const rangeDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (rangeDays > maxRangeDays) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'date_range',
          reason: `Maximum date range is ${maxRangeDays} days`,
        },
      });
    }

    const adapter = createAdapter(c);
    const adminAuth = getAdminAuth(c);
    const createdBy = adminAuth?.adminId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    // Estimate completion (2 minutes for report generation)
    const estimatedCompletion = nowTs + 2 * 60;

    // Create job record
    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'reports/generate',
        'pending',
        JSON.stringify({ stage: 'queued' }),
        JSON.stringify(options),
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'job.created', 'job', jobId, {
      job_type: 'reports/generate',
      report_type: options.type,
      format: options.format,
      date_range: { from: options.from_date, to: options.to_date },
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        job_type: 'reports/generate',
        report_type: options.type,
        format: options.format,
        created_at: new Date(nowTs * 1000).toISOString(),
        estimated_completion: new Date(estimatedCompletion * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create report job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Bulk members options schema
 */
const BulkMembersOptionsSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(1000),
  role: z.enum(['member', 'admin', 'owner']).optional(),
  action: z.enum(['add', 'remove']).default('add'),
  result_delivery: JobResultDeliverySchema,
});

/**
 * POST /api/admin/jobs/organizations/:id/bulk-members
 * Create a bulk member add/remove job for an organization
 */
export async function adminJobsOrgBulkMembersHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const organizationId = c.req.param('id')!;

  if (!isAdminJobTypeCreatableFromAdminApi('organizations/bulk-members')) {
    return createUnsupportedJobTypeResponse(c, 'organizations/bulk-members');
  }

  if (!organizationId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'organization_id' },
    });
  }

  try {
    const body = await c.req.json<z.infer<typeof BulkMembersOptionsSchema>>();

    const parseResult = BulkMembersOptionsSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const options = parseResult.data;
    const adapter = createAdapter(c);

    // Verify organization exists and belongs to tenant
    const org = await adapter.queryOne<{ id: string; tenant_id: string; name: string }>(
      'SELECT id, tenant_id, name FROM organizations WHERE id = ? AND tenant_id = ?',
      [organizationId, tenantId]
    );

    if (!org) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'organization', id: organizationId },
      });
    }

    // Validate that all user_ids exist in tenant
    const userPlaceholders = options.user_ids.map(() => '?').join(',');
    const existingUsers = await adapter.query<{ id: string }>(
      `SELECT id FROM users_core WHERE id IN (${userPlaceholders}) AND tenant_id = ?`,
      [...options.user_ids, tenantId]
    );

    const existingUserIds = new Set(existingUsers.map((u) => u.id));
    const invalidUserIds = options.user_ids.filter((id) => !existingUserIds.has(id));

    if (invalidUserIds.length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'user_ids',
          reason: `Users not found: ${invalidUserIds.slice(0, 5).join(', ')}${invalidUserIds.length > 5 ? '...' : ''}`,
        },
      });
    }

    const adminAuth = getAdminAuth(c);
    const createdBy = adminAuth?.adminId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    // Estimate completion (1 second per 10 users, minimum 30 seconds)
    const estimatedSeconds = Math.max(30, Math.ceil(options.user_ids.length / 10));
    const estimatedCompletion = nowTs + estimatedSeconds;

    // Create job record
    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config,
        created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'organizations/bulk-members',
        'pending',
        JSON.stringify({
          total: options.user_ids.length,
          processed: 0,
          succeeded: 0,
          failed: 0,
        }),
        JSON.stringify({
          organization_id: organizationId,
          organization_name: org.name,
          action: options.action,
          role: options.role,
          user_ids: options.user_ids,
          result_delivery: options.result_delivery,
        }),
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'job.created', 'job', jobId, {
      job_type: 'organizations/bulk-members',
      organization_id: organizationId,
      action: options.action,
      user_count: options.user_ids.length,
      role: options.role,
    });

    return c.json(
      {
        job_id: jobId,
        status: 'pending',
        job_type: 'organizations/bulk-members',
        organization_id: organizationId,
        organization_name: org.name,
        action: options.action,
        user_count: options.user_ids.length,
        role: options.role,
        created_at: new Date(nowTs * 1000).toISOString(),
        estimated_completion: new Date(estimatedCompletion * 1000).toISOString(),
      },
      202
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to create bulk members job', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}
