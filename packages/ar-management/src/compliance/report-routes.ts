/**
 * Compliance report endpoints:
 * - GET  /api/admin/compliance/reports               reports, newest first (cursor pagination)
 * - POST /api/admin/compliance/reports               generate one (compliance/reports.ts)
 * - GET  /api/admin/compliance/reports/:id           one report
 * - GET  /api/admin/compliance/reports/:id/download  its file, while it has not expired
 *
 * Generating and downloading are audited. The file is kept encrypted in EXPORT_ARTIFACTS,
 * catalogued in the admin database, and its SHA-256 recorded and checked on download.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import {
  AR_ERROR_CODES,
  createAuditLogFromContext,
  createAuthContextFromHono,
  createErrorResponse,
  getLogger,
  getTenantIdFromContext,
  getTenantMetadataContextFromHono,
  loadCatalogObjectRepresentation,
  requireAdminDatabaseAdapter,
  resolveTenantRuntimeProfilesFromEnv,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { readComplianceStatus } from '../admin-compliance';
import { materializeEncryptedObjectArtifact } from '../object-artifact-materialization';
import { usesRoutedAccountStorage } from '../tenant-routed-storage';
import {
  removeReportFile,
  accessReviewReport,
  auditLogReport,
  complianceStatusReport,
  COMPLIANCE_REPORT_TYPES,
  MAX_AUDIT_REPORT_DAYS,
  mfaCoverageReport,
  REPORT_EXPIRY_DAYS,
  ReportTooLargeError,
  ReportUnavailableError,
  type ComplianceReportType,
  type GeneratedReport,
} from './reports';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * generating: stored, its generation not audited yet (not downloadable); failed: error says why;
 * expired: its download period ended and its file is deleted.
 */
const REPORT_STATUSES = ['generating', 'completed', 'failed', 'expired'] as const;

interface ComplianceReportRow {
  id: string;
  type: string;
  name: string;
  status: string;
  requested_by: string | null;
  parameters: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  object_catalog_id: string | null;
  object_key_base: string | null;
  artifact_sha256: string | null;
  format: string | null;
  row_count: number | null;
  size_bytes: number | null;
}

const REPORT_COLUMNS = `id, type, name, status, requested_by, parameters, error_message,
  created_at, completed_at, expires_at, object_catalog_id, object_key_base, artifact_sha256, format,
  row_count, size_bytes`;

const CreateSchema = z
  .object({
    type: z.enum(COMPLIANCE_REPORT_TYPES),
    name: z.string().trim().min(1).max(200).optional(),
    parameters: z
      .object({
        review_id: z.string().trim().min(1).max(128).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const parameters = value.parameters ?? {};
    if (value.type === 'access_review' && !parameters.review_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters', 'review_id'],
        message: 'Required for an access review report',
      });
    }
    if (value.type === 'audit_log') {
      const from = Date.parse(parameters.from ?? '');
      const to = Date.parse(parameters.to ?? '');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameters'],
          message: 'from and to (after from) are required for an audit log report',
        });
      } else if (to - from > MAX_AUDIT_REPORT_DAYS * DAY_MS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameters'],
          message: `An audit log report covers at most ${MAX_AUDIT_REPORT_DAYS} days`,
        });
      }
    }
  });

function coreAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function adminId(c: Context<{ Bindings: Env }>): string | null {
  const admin = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | { userId?: string }
    | undefined;
  return admin?.userId ?? null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseParameters(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A report as the API shows it (its storage reference stays internal). */
function serializeReport(row: ComplianceReportRow, now = Date.now()) {
  const expired =
    row.status === 'expired' ||
    (row.status === 'completed' && row.expires_at !== null && Date.parse(row.expires_at) <= now);
  return {
    report_id: row.id,
    type: row.type,
    name: row.name,
    status: expired ? 'expired' : row.status,
    requested_by: row.requested_by,
    parameters: parseParameters(row.parameters),
    format: row.format,
    row_count: row.row_count,
    size_bytes: row.size_bytes,
    sha256: row.artifact_sha256,
    error: row.error_message,
    created_at: row.created_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    downloadable: row.status === 'completed' && !expired && row.object_catalog_id !== null,
  };
}

function reportNotFound(c: Context<{ Bindings: Env }>, id: string) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
    variables: { resource: 'compliance_report', id },
  });
}

function encodeCursor(row: ComplianceReportRow): string {
  return Buffer.from(JSON.stringify({ id: row.id, created_at: row.created_at })).toString(
    'base64url'
  );
}

function decodeCursor(cursor: string): { id: string; created_at: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      id?: unknown;
      created_at?: unknown;
    };
    return typeof parsed.id === 'string' && typeof parsed.created_at === 'string'
      ? { id: parsed.id, created_at: parsed.created_at }
      : null;
  } catch {
    return null;
  }
}

/** GET /api/admin/compliance/reports */
export async function listComplianceReports(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query('limit') || '', 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  const where = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  const cursor = c.req.query('cursor');
  if (cursor) {
    const position = decodeCursor(cursor);
    if (!position) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'cursor', reason: 'Invalid cursor' },
      });
    }
    where.push('(created_at < ? OR (created_at = ? AND id > ?))');
    params.push(position.created_at, position.created_at, position.id);
  }
  const status = c.req.query('status');
  if (status) {
    if (!(REPORT_STATUSES as readonly string[]).includes(status)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'status', reason: `One of ${REPORT_STATUSES.join(', ')}` },
      });
    }
    // As each report is shown: a completed one past its download period is expired, though
    // the retention task may not have marked it yet.
    if (status === 'expired') {
      where.push("(status = 'expired' OR (status = 'completed' AND expires_at <= ?))");
      params.push(nowIso);
    } else if (status === 'completed') {
      where.push("status = 'completed' AND (expires_at IS NULL OR expires_at > ?)");
      params.push(nowIso);
    } else {
      where.push('status = ?');
      params.push(status);
    }
  }
  const type = c.req.query('type');
  if (type) {
    if (!(COMPLIANCE_REPORT_TYPES as readonly string[]).includes(type)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'type', reason: `One of ${COMPLIANCE_REPORT_TYPES.join(', ')}` },
      });
    }
    where.push('type = ?');
    params.push(type);
  }
  try {
    const rows = await coreAdapter(c, tenantId).query<ComplianceReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM compliance_reports
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id ASC
        LIMIT ?`,
      [...params, limit + 1]
    );
    const page = rows.slice(0, limit);
    return c.json({
      data: page.map((row) => serializeReport(row, now)),
      pagination: {
        has_more: rows.length > limit,
        ...(rows.length > limit ? { next_cursor: encodeCursor(page[page.length - 1]!) } : {}),
      },
    });
  } catch (error) {
    getLogger(c)
      .module('COMPLIANCE-REPORTS')
      .error('Failed to list compliance reports', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/** GET /api/admin/compliance/reports/:id */
export async function getComplianceReport(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const row = await coreAdapter(c, tenantId).queryOne<ComplianceReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM compliance_reports WHERE tenant_id = ? AND id = ?`,
    [tenantId, id]
  );
  if (!row) return reportNotFound(c, id);
  return c.json(serializeReport(row));
}

/** Makes the report's content; an error that is the request's fault becomes a response. */
async function generate(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  input: z.infer<typeof CreateSchema>,
  adminAdapter: DatabaseAdapter
): Promise<GeneratedReport> {
  const type: ComplianceReportType = input.type;
  if (type === 'access_review') {
    return accessReviewReport(coreAdapter(c, tenantId), tenantId, input.parameters!.review_id!);
  }
  if (type === 'mfa_coverage') {
    return mfaCoverageReport(c.env, adminAdapter, tenantId, {
      routed: usesRoutedAccountStorage(getTenantMetadataContextFromHono(c)),
    });
  }
  if (type === 'audit_log') {
    const { auditProfile } = await resolveTenantRuntimeProfilesFromEnv(c.env, tenantId, {
      strict: true,
    });
    return auditLogReport(c.env, auditProfile, tenantId, {
      fromMs: Date.parse(input.parameters!.from!),
      toMs: Date.parse(input.parameters!.to!),
    });
  }
  return complianceStatusReport(await readComplianceStatus(c));
}

/** POST /api/admin/compliance/reports */
export async function createComplianceReport(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('COMPLIANCE-REPORTS');
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'body',
        reason: parsed.error.issues.map((issue) => issue.message).join(', '),
      },
    });
  }
  const input = parsed.data;
  if (!c.env.DB_ADMIN || !c.env.EXPORT_ARTIFACTS || !c.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return c.json(
      {
        error: 'report_storage_unavailable',
        error_description:
          'Report storage (admin database, artifact bucket, encryption key) is not configured',
      },
      503
    );
  }
  const adminAdapter = requireAdminDatabaseAdapter(c.env, 'compliance-reports');
  const core = coreAdapter(c, tenantId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const name = input.name ?? `${input.type} ${createdAt.slice(0, 10)}`;
  const parameters = input.parameters ? JSON.stringify(input.parameters) : null;
  const record = (status: 'generating' | 'failed', fields: Record<string, unknown>) =>
    core.execute(
      `INSERT INTO compliance_reports (id, tenant_id, type, name, status, requested_by, parameters,
         error_message, created_at, completed_at, expires_at, object_key_base, artifact_sha256,
         format, row_count, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.type,
        name,
        status,
        adminId(c),
        parameters,
        fields.error ?? null,
        createdAt,
        status === 'failed' ? new Date().toISOString() : null,
        fields.expires_at ?? null,
        fields.object_key_base ?? null,
        fields.sha256 ?? null,
        fields.format ?? null,
        fields.row_count ?? null,
        fields.size_bytes ?? null,
      ]
    );
  const load = async () =>
    (await core.queryOne<ComplianceReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM compliance_reports WHERE tenant_id = ? AND id = ?`,
      [tenantId, id]
    ))!;

  let report: GeneratedReport;
  try {
    report = await generate(c, tenantId, input, adminAdapter);
  } catch (error) {
    if (error instanceof ReportUnavailableError) {
      if (error.message === 'access_review_not_found') {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'access_review', id: input.parameters?.review_id ?? '' },
        });
      }
      return c.json(
        {
          error: error.message,
          error_description: 'This tenant keeps no audit log that can be queried',
        },
        409
      );
    }
    if (error instanceof ReportTooLargeError) {
      // Recorded as failed, so the attempt is part of the evidence trail too.
      await record('failed', { error: 'too_large' });
      await createAuditLogFromContext(c, 'compliance_report.failed', 'compliance_report', id, {
        type: input.type,
        error: 'too_large',
      });
      return c.json(
        {
          error: 'report_too_large',
          error_description: 'The report has more rows than one report holds; narrow it',
          report: serializeReport(await load()),
        },
        422
      );
    }
    log.warn('Compliance report could not be generated', {
      type: input.type,
      errorType: error instanceof Error ? error.message : 'Unknown',
    });
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The report cannot be generated now; try again',
      },
      503
    );
  }

  // The report is recorded first, not downloadable (generating), with where its file goes: a
  // file stored but never completed (an error, or a stop part way) is deleted from there, now or
  // by the retention task once the report's time is up.
  const keyBase = `compliance-reports/${tenantId}/${id}`;
  /**
   * Fails a report still generating, then removes its file: a report that completed meanwhile
   * (or whose state is unknown) keeps it. Removed now if possible; otherwise its file stays
   * referenced, due at once, for the retention task. Whether the report failed here.
   */
  const failNow = async (error: string): Promise<boolean> => {
    const now = new Date().toISOString();
    const marked = await core.execute(
      `UPDATE compliance_reports
          SET status = 'failed', error_message = ?, completed_at = ?, expires_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'generating'`,
      [error, now, now, tenantId, id]
    );
    if ((marked.rowsAffected ?? 0) === 0) return false;
    const cleaned = await removeReportFile(c.env, adminAdapter, tenantId, keyBase, catalogId)
      .then(() => true)
      .catch(() => false);
    if (cleaned) {
      await core
        .execute(
          `UPDATE compliance_reports SET object_key_base = NULL, object_catalog_id = NULL
            WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
          [tenantId, id]
        )
        .catch(() => undefined);
    }
    return true;
  };
  let catalogId: string | null = null;
  let audited = false;
  try {
    await record('generating', {
      expires_at: new Date(now + REPORT_EXPIRY_DAYS * DAY_MS).toISOString(),
      object_key_base: keyBase,
      sha256: await sha256Hex(report.content),
      format: report.format,
      row_count: report.rowCount,
      size_bytes: new TextEncoder().encode(report.content).byteLength,
    });
  } catch (error) {
    log.warn('Compliance report could not be recorded', {
      type: input.type,
      errorType: error instanceof Error ? error.message : 'Unknown',
    });
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The report cannot be stored now; try again',
      },
      503
    );
  }
  try {
    const artifact = await materializeEncryptedObjectArtifact(
      adminAdapter,
      c.env.EXPORT_ARTIFACTS,
      {
        tenantId,
        objectClass: 'admin_job_result',
        representation: report.format === 'csv' ? 'csv_projection' : 'canonical_json',
        objectKeyBase: `${keyBase}.${report.format}`,
        content: report.content,
        contentType: report.contentType,
        rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
        keyVersion: Number.parseInt(c.env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1,
      }
    );
    catalogId = artifact.catalogId;
    await core.execute(
      'UPDATE compliance_reports SET object_catalog_id = ? WHERE tenant_id = ? AND id = ?',
      [catalogId, tenantId, id]
    );
    // Downloadable only once its generation is audited.
    await createAuditLogFromContext(c, 'compliance_report.created', 'compliance_report', id, {
      type: input.type,
      format: report.format,
      row_count: report.rowCount,
    });
    audited = true;
    const completed = await core
      .execute(
        `UPDATE compliance_reports SET status = 'completed', completed_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'generating'`,
        [new Date().toISOString(), tenantId, id]
      )
      .catch(() => null);
    // Not updated, or no answer (a retried statement may have done it already): completed
    // only if the report says so, with this file.
    if ((completed?.rowsAffected ?? 0) === 0) {
      const now = await core.queryOne<{ status: string; object_catalog_id: string | null }>(
        'SELECT status, object_catalog_id FROM compliance_reports WHERE tenant_id = ? AND id = ?',
        [tenantId, id],
        { consistencyClass: 'primary_required' }
      );
      if (now?.status !== 'completed' || now.object_catalog_id !== catalogId) {
        throw new Error('compliance_report_not_completed');
      }
    }
  } catch (error) {
    log.warn('Compliance report could not be stored', {
      type: input.type,
      errorType: error instanceof Error ? error.message : 'Unknown',
    });
    let failed = await failNow('storage_failed').catch(() => false);
    if (!failed) {
      // Completed after all (a statement answered late), or its state is unknown: its file
      // stays. A report found completed is answered as created.
      const row = await core
        .queryOne<ComplianceReportRow>(
          `SELECT ${REPORT_COLUMNS} FROM compliance_reports WHERE tenant_id = ? AND id = ?`,
          [tenantId, id],
          { consistencyClass: 'primary_required' }
        )
        .catch(() => null);
      if (row?.status === 'completed') return c.json(serializeReport(row), 201);
      // Failed here though its answer was lost: its file, still referenced and due, is left to
      // the retention task, but the failure is audited all the same.
      failed = row?.status === 'failed' && row.error_message === 'storage_failed';
    }
    // Its generation was audited: the audit says it failed after all.
    if (audited && failed) {
      await createAuditLogFromContext(c, 'compliance_report.failed', 'compliance_report', id, {
        type: input.type,
        error: 'storage_failed',
      }).catch(() => undefined);
    }
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The report cannot be stored now; try again',
      },
      503
    );
  }
  return c.json(serializeReport(await load()), 201);
}

/** GET /api/admin/compliance/reports/:id/download */
export async function downloadComplianceReport(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const row = await coreAdapter(c, tenantId).queryOne<ComplianceReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM compliance_reports WHERE tenant_id = ? AND id = ?`,
    [tenantId, id]
  );
  if (!row || !serializeReport(row).downloadable || !c.env.DB_ADMIN) {
    return reportNotFound(c, id);
  }
  const loaded = await loadCatalogObjectRepresentation(
    requireAdminDatabaseAdapter(c.env, 'compliance-reports'),
    c.env,
    {
      tenantId,
      objectCatalogId: row.object_catalog_id!,
      representation: row.format === 'csv' ? 'csv_projection' : 'canonical_json',
      expectedClass: 'admin_job_result',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
      allowPlaintextFallback: false,
    }
  );
  if (!loaded) return reportNotFound(c, id);
  // The file is the one generated: its hash is checked before it is handed out.
  if ((await sha256Hex(loaded.content)) !== row.artifact_sha256) {
    getLogger(c)
      .module('COMPLIANCE-REPORTS')
      .error('Compliance report content does not match its recorded hash', { reportId: id });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
  await createAuditLogFromContext(c, 'compliance_report.downloaded', 'compliance_report', id, {
    type: row.type,
    sha256: row.artifact_sha256,
  });
  const extension = row.format === 'csv' ? 'csv' : 'json';
  return new Response(loaded.content, {
    status: 200,
    headers: {
      'Content-Type': `${row.format === 'csv' ? 'text/csv' : 'application/json'}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="compliance-${row.type}-${row.id}.${extension}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
