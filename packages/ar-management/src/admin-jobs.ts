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

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import { z } from 'zod';

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
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  estimated_completion: number | null;
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
  return new D1Adapter({ db: c.env.DB });
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
    progress,
    created_by: row.created_by,
    created_at: toISOString(row.created_at),
    updated_at: toISOString(row.updated_at),
    started_at: toISOString(row.started_at),
    completed_at: toISOString(row.completed_at),
    estimated_completion: toISOString(row.estimated_completion),
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
}

/**
 * Format job result for API response
 */
function formatJobResult(row: JobRow) {
  let summary: JobResultSummary | null = null;
  let failures: JobFailure[] = [];

  if (row.result) {
    try {
      const parsed = JSON.parse(row.result) as ParsedJobResult;
      summary = parsed.summary ?? null;
      failures = parsed.failures ?? [];
    } catch {
      // Invalid JSON, ignore
    }
  }

  return {
    job_id: row.id,
    summary,
    failures,
    ...(row.result_r2_key && {
      download_url: row.result_r2_key, // Actual signed URL would be generated
    }),
  };
}

// =============================================================================
// Handlers
// =============================================================================

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
             created_by, created_at, updated_at, started_at, completed_at, estimated_completion
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
  const jobId = c.req.param('id');

  if (!jobId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const row = await adapter.queryOne<JobRow>(
      `SELECT id, tenant_id, job_type, status, progress, error_code, error_message,
              created_by, created_at, updated_at, started_at, completed_at, estimated_completion
       FROM admin_jobs
       WHERE id = ? AND tenant_id = ?`,
      [jobId, tenantId]
    );

    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json(formatJob(row));
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to get job', { jobId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/jobs/:id/result
 * Get job result (only available for completed/partial_failure jobs)
 */
export async function adminJobResultHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const jobId = c.req.param('id');

  if (!jobId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const adapter = createAdapter(c);

    const row = await adapter.queryOne<JobRow>(
      `SELECT id, tenant_id, job_type, status, result, result_r2_key
       FROM admin_jobs
       WHERE id = ? AND tenant_id = ?`,
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

/**
 * Bulk update options
 */
const BulkUpdateOptionsSchema = z.object({
  fields: z.array(z.string()).min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  values: z.record(z.string(), z.unknown()),
  dry_run: z.boolean().default(false),
});

/**
 * Report options
 */
const ReportOptionsSchema = z.object({
  type: z.enum(['user_activity', 'access_summary', 'compliance_audit', 'security_events']),
  from_date: z.string().datetime(),
  to_date: z.string().datetime(),
  format: z.enum(['json', 'csv', 'pdf']).default('json'),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): { adminId?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get('adminAuth') as { adminId?: string } | null;
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
    }>();

    // Validate request
    if (!body.filename || typeof body.filename !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'filename' },
      });
    }

    if (!body.content_type || body.content_type !== 'text/csv') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'content_type', reason: 'Only text/csv is supported' },
      });
    }

    // Size limit: 50MB
    const MAX_SIZE = 50 * 1024 * 1024;
    if (!body.size_bytes || body.size_bytes > MAX_SIZE) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'size_bytes', reason: `Maximum file size is ${MAX_SIZE} bytes` },
      });
    }

    // Generate unique key for R2
    const jobId = crypto.randomUUID();
    const r2Key = `imports/${tenantId}/${jobId}/${body.filename}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Note: Actual R2 presigned URL generation would require R2 bucket binding
    // For now, return placeholder structure that shows the expected format
    // Production implementation would use: await c.env.IMPORT_BUCKET.createMultipartUpload(r2Key)

    return c.json({
      upload_url: `https://storage.authrim.com/upload/${r2Key}?signature=placeholder`,
      r2_key: r2Key,
      expires_at: expiresAt.toISOString(),
      job_id: jobId,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-JOBS');
    log.error('Failed to generate upload URL', {}, error as Error);
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
    const body = await c.req.json<{
      r2_key: string;
      options?: z.infer<typeof ImportOptionsSchema>;
    }>();

    // Validate r2_key
    if (!body.r2_key || typeof body.r2_key !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'r2_key' },
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
        created_by, created_at, updated_at, estimated_completion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        tenantId,
        'users/import',
        'pending',
        JSON.stringify({ total: 0, processed: 0, succeeded: 0, failed: 0 }),
        JSON.stringify(options),
        body.r2_key,
        createdBy,
        nowTs,
        nowTs,
        estimatedCompletion,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'job.created', 'job', jobId, {
      job_type: 'users/import',
      r2_key: body.r2_key,
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
    const adapter = createAdapter(c);
    const adminAuth = getAdminAuth(c);
    const createdBy = adminAuth?.adminId ?? 'unknown';
    const jobId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);

    // Count affected users (for estimation)
    let affectedCount = 0;
    if (options.filter) {
      // Build filter query
      const filterConditions = Object.entries(options.filter)
        .map(([key]) => `${key} = ?`)
        .join(' AND ');
      const filterValues = Object.values(options.filter);

      const countResult = await adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ? AND ${filterConditions}`,
        [tenantId, ...filterValues]
      );
      affectedCount = countResult?.count ?? 0;
    } else {
      const countResult = await adapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM users_core WHERE tenant_id = ?',
        [tenantId]
      );
      affectedCount = countResult?.count ?? 0;
    }

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
 * POST /api/admin/jobs/reports/generate
 * Create a report generation job
 */
export async function adminJobsReportsGenerateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

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
  role: z.string().optional(),
  action: z.enum(['add', 'remove']).default('add'),
});

/**
 * POST /api/admin/jobs/organizations/:id/bulk-members
 * Create a bulk member add/remove job for an organization
 */
export async function adminJobsOrgBulkMembersHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const organizationId = c.req.param('id');

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
