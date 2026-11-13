/**
 * Admin Consent Statement Management API
 *
 * CRUD operations for consent statements, versions, localizations,
 * tenant requirements, client overrides, and user consent records.
 */

import { Context } from 'hono';
import type {
  DatabaseAdapter,
  Env,
  StatementConsentStores,
  PreparedStatement,
} from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  lookupStatementDefinitions,
  getLogger,
  validateVersionFormat,
  activateVersion,
  withdrawStatementConsent,
  enqueueStatementConsentProjection,
} from '@authrim/ar-lib-core';

import { adminAccountCoreAdapter } from './admin-account-storage';
import { getAdminAuth } from './admin-tenant-access';
import { tenantRBACStores } from './rbac-account-stores';

type PublicLinkUrlValidation =
  | { valid: true; value: string | null }
  | { valid: false; fieldName: string };

function normalizeOptionalPublicLinkUrl(
  value: unknown,
  fieldName: string
): PublicLinkUrlValidation {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }

  if (typeof value !== 'string') {
    return { valid: false, fieldName };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: true, value: null };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { valid: true, value: trimmed };
    }
  } catch {
    // Fall through to the uniform invalid_request response.
  }

  return { valid: false, fieldName };
}

function invalidPublicLinkUrlResponse(c: Context, fieldName: string): Response {
  return c.json(
    {
      error: 'invalid_request',
      error_description: `${fieldName} must be an http(s) URL`,
    },
    400
  );
}

function immutableLocalizationResponse(c: Context): Response {
  return c.json(
    {
      error: 'conflict',
      error_description: 'Only draft versions allow localization changes; create a new version',
    },
    409
  );
}

function isMissingLocalizationUserFacingColumnError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const referencesOptionalColumn =
    message.includes('processing_purpose') || message.includes('withdrawal_impact');
  return (
    referencesOptionalColumn &&
    (message.includes('no such column') ||
      message.includes('no column named') ||
      message.includes('does not exist'))
  );
}

async function executeDraftLocalizationMutation(
  adapter: DatabaseAdapter,
  versionId: string,
  tenantId: string,
  now: number,
  mutation: PreparedStatement
) {
  const results = await adapter.batch([
    {
      sql: `UPDATE consent_statement_versions SET updated_at=CASE WHEN updated_at>=? THEN updated_at+1 ELSE ? END
        WHERE id=? AND tenant_id=? AND status='draft'`,
      params: [now, now, versionId, tenantId],
    },
    mutation,
  ]);
  if (results.length !== 2 || results.some((r) => !r.success))
    throw new Error('statement_consent_localization_result_unknown');
  return results[1];
}

async function executeLocalizationUpsert(params: {
  adapter: DatabaseAdapter;
  existing: boolean;
  id: string;
  tenantId: string;
  versionId: string;
  language: string;
  title: string;
  description: string;
  processingPurpose: string | null;
  withdrawalImpact: string | null;
  documentUrl: string | null;
  inlineContent: string | null;
  now: number;
}) {
  try {
    if (params.existing) {
      return await executeDraftLocalizationMutation(
        params.adapter,
        params.versionId,
        params.tenantId,
        params.now,
        {
          sql: `UPDATE consent_statement_localizations
         SET title = ?, description = ?, processing_purpose = ?, withdrawal_impact = ?,
             document_url = ?, inline_content = ?, updated_at = ?
         WHERE version_id = ? AND language = ? AND tenant_id = ?
           AND EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.id=consent_statement_localizations.version_id
             AND v.tenant_id=consent_statement_localizations.tenant_id AND v.status='draft')`,
          params: [
            params.title,
            params.description,
            params.processingPurpose,
            params.withdrawalImpact,
            params.documentUrl,
            params.inlineContent,
            params.now,
            params.versionId,
            params.language,
            params.tenantId,
          ],
        }
      );
    }

    return await executeDraftLocalizationMutation(
      params.adapter,
      params.versionId,
      params.tenantId,
      params.now,
      {
        sql: `INSERT INTO consent_statement_localizations
       (id, tenant_id, version_id, language, title, description, processing_purpose,
        withdrawal_impact, document_url, inline_content, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM consent_statement_versions WHERE id=? AND tenant_id=? AND status='draft')`,
        params: [
          params.id,
          params.tenantId,
          params.versionId,
          params.language,
          params.title,
          params.description,
          params.processingPurpose,
          params.withdrawalImpact,
          params.documentUrl,
          params.inlineContent,
          params.now,
          params.now,
          params.versionId,
          params.tenantId,
        ],
      }
    );
  } catch (error) {
    if (!isMissingLocalizationUserFacingColumnError(error)) {
      throw error;
    }
    if (params.existing) {
      return await executeDraftLocalizationMutation(
        params.adapter,
        params.versionId,
        params.tenantId,
        params.now,
        {
          sql: `UPDATE consent_statement_localizations
         SET title = ?, description = ?, document_url = ?, inline_content = ?, updated_at = ?
         WHERE version_id = ? AND language = ? AND tenant_id = ?
           AND EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.id=consent_statement_localizations.version_id
             AND v.tenant_id=consent_statement_localizations.tenant_id AND v.status='draft')`,
          params: [
            params.title,
            params.description,
            params.documentUrl,
            params.inlineContent,
            params.now,
            params.versionId,
            params.language,
            params.tenantId,
          ],
        }
      );
    }
    return await executeDraftLocalizationMutation(
      params.adapter,
      params.versionId,
      params.tenantId,
      params.now,
      {
        sql: `INSERT INTO consent_statement_localizations
       (id, tenant_id, version_id, language, title, description,
        document_url, inline_content, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM consent_statement_versions WHERE id=? AND tenant_id=? AND status='draft')`,
        params: [
          params.id,
          params.tenantId,
          params.versionId,
          params.language,
          params.title,
          params.description,
          params.documentUrl,
          params.inlineContent,
          params.now,
          params.now,
          params.versionId,
          params.tenantId,
        ],
      }
    );
  }
}

function optionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

// =============================================================================
// Consent Statements CRUD
// =============================================================================

/** Bound parameters per `IN (…)` query (D1 allows 100 per statement). */
const LIST_SUMMARY_CHUNK = 90;

interface StatementListSummary {
  current: Record<string, unknown> | null;
  hasDraft: boolean;
  titles: Record<string, string>;
}

/** The current version, draft presence and shown titles of every statement of a tenant. */
async function statementListSummaries(
  db: DatabaseAdapter,
  tenantId: string
): Promise<Map<string, StatementListSummary>> {
  const versions = await db.query<{
    id: string;
    statement_id: string;
    status: string;
    is_current: number | string | boolean;
    created_at: number | string;
  }>(
    `SELECT * FROM consent_statement_versions WHERE tenant_id = ? ORDER BY created_at DESC, id DESC`,
    [tenantId]
  );
  const summaries = new Map<string, StatementListSummary>();
  const shown = new Map<string, string>();
  for (const version of versions) {
    const summary = summaries.get(version.statement_id) ?? {
      current: null,
      hasDraft: false,
      titles: {},
    };
    const current = Number(version.is_current) === 1 || version.is_current === true;
    if (current && !summary.current) summary.current = version;
    if (version.status === 'draft') summary.hasDraft = true;
    summaries.set(version.statement_id, summary);
    // Newest first: the first draft seen is the latest one; a current version wins over it.
    if (current) shown.set(version.statement_id, version.id);
    else if (version.status === 'draft' && !shown.has(version.statement_id)) {
      shown.set(version.statement_id, version.id);
    }
  }
  const statementOfVersion = new Map(
    [...shown].map(([statement, version]) => [version, statement])
  );
  const versionIds = [...statementOfVersion.keys()];
  for (let start = 0; start < versionIds.length; start += LIST_SUMMARY_CHUNK) {
    const chunk = versionIds.slice(start, start + LIST_SUMMARY_CHUNK);
    const localizations = await db.query<{ version_id: string; language: string; title: string }>(
      `SELECT version_id, language, title FROM consent_statement_localizations
        WHERE tenant_id = ? AND version_id IN (${chunk.map(() => '?').join(',')})`,
      [tenantId, ...chunk]
    );
    for (const item of localizations) {
      const statementId = statementOfVersion.get(item.version_id);
      const summary = statementId ? summaries.get(statementId) : undefined;
      if (summary && typeof item.title === 'string' && item.title) {
        summary.titles[item.language] = item.title;
      }
    }
  }
  return summaries;
}

/** GET /api/admin/consent-statements */
export async function adminConsentStatementsListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const rows = await authCtx.coreAdapter.query<Record<string, unknown> & { id: string }>(
      `SELECT * FROM consent_statements WHERE tenant_id = ? ORDER BY display_order ASC, created_at ASC`,
      [tenantId]
    );
    const summaries = await statementListSummaries(authCtx.coreAdapter, tenantId);

    // Each row also carries its current version, whether a draft exists, and the titles of the
    // version a list shows (the current one, or the latest draft), so a list needs one request.
    return c.json({
      statements: rows.map((row) => ({
        ...row,
        current_version: summaries.get(row.id)?.current ?? null,
        has_draft: summaries.get(row.id)?.hasDraft ?? false,
        titles: summaries.get(row.id)?.titles ?? {},
      })),
    });
  } catch (error) {
    log.error('Failed to list consent statements', { action: 'list' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list statements' }, 500);
  }
}

/** POST /api/admin/consent-statements */
export async function adminConsentStatementCreateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<{
      slug: string;
      category?: string;
      legal_basis?: string;
      processing_purpose?: string;
      display_order?: number;
      record_retention_days?: number | null;
      withdrawal_allowed?: boolean;
      withdrawal_impact?: string | null;
      reconsent_interval_days?: number | null;
    }>();

    if (!body.slug || typeof body.slug !== 'string') {
      return c.json({ error: 'invalid_request', error_description: 'slug is required' }, 400);
    }

    // Validate slug uniqueness
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM consent_statements WHERE tenant_id = ? AND slug = ?`,
      [tenantId, body.slug]
    );
    if (existing.length > 0) {
      return c.json(
        { error: 'conflict', error_description: 'A statement with this slug already exists' },
        409
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const recordRetentionDays = optionalNonNegativeInteger(body.record_retention_days);
    if (recordRetentionDays === undefined && body.record_retention_days !== undefined) {
      return c.json(
        { error: 'invalid_request', error_description: 'record_retention_days must be >= 0' },
        400
      );
    }
    const reconsentIntervalDays = optionalNonNegativeInteger(body.reconsent_interval_days);
    if (reconsentIntervalDays === undefined && body.reconsent_interval_days !== undefined) {
      return c.json(
        { error: 'invalid_request', error_description: 'reconsent_interval_days must be >= 0' },
        400
      );
    }

    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_statements
       (id, tenant_id, slug, category, legal_basis, processing_purpose, display_order, is_active,
        record_retention_days, withdrawal_allowed, withdrawal_impact,
        reconsent_interval_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.slug,
        body.category ?? 'custom',
        body.legal_basis ?? 'consent',
        body.processing_purpose ?? null,
        body.display_order ?? 0,
        recordRetentionDays ?? null,
        body.withdrawal_allowed === false ? 0 : 1,
        typeof body.withdrawal_impact === 'string' && body.withdrawal_impact.trim()
          ? body.withdrawal_impact.trim()
          : null,
        reconsentIntervalDays ?? null,
        now,
        now,
      ]
    );

    const created = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statements WHERE id = ?`,
      [id]
    );

    log.info('Created consent statement', { action: 'create', statementId: id, slug: body.slug });
    return c.json(created[0], 201);
  } catch (error) {
    log.error('Failed to create consent statement', { action: 'create' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create statement' }, 500);
  }
}

/** GET /api/admin/consent-statements/:id */
export async function adminConsentStatementGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;

    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statements WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Statement not found' }, 404);
    }

    return c.json(rows[0]);
  } catch (error) {
    log.error('Failed to get consent statement', { action: 'get' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get statement' }, 500);
  }
}

/** PUT /api/admin/consent-statements/:id */
export async function adminConsentStatementUpdateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      slug?: string;
      category?: string;
      legal_basis?: string;
      processing_purpose?: string;
      display_order?: number;
      is_active?: boolean;
      record_retention_days?: number | null;
      withdrawal_allowed?: boolean;
      withdrawal_impact?: string | null;
      reconsent_interval_days?: number | null;
    }>();

    const existing = await authCtx.coreAdapter.query<{
      id: string;
      retired_at: number | string | null;
    }>(`SELECT * FROM consent_statements WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
    if (existing.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Statement not found' }, 404);
    }

    // Build dynamic update
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.slug !== undefined) {
      sets.push('slug = ?');
      params.push(body.slug);
    }
    if (body.category !== undefined) {
      sets.push('category = ?');
      params.push(body.category);
    }
    if (body.legal_basis !== undefined) {
      sets.push('legal_basis = ?');
      params.push(body.legal_basis);
    }
    if (body.processing_purpose !== undefined) {
      sets.push('processing_purpose = ?');
      params.push(body.processing_purpose);
    }
    if (body.display_order !== undefined) {
      sets.push('display_order = ?');
      params.push(body.display_order);
    }
    if (body.is_active !== undefined) {
      if (body.is_active && existing[0].retired_at != null)
        return c.json(
          { error: 'conflict', error_description: 'Retired statements cannot be reactivated' },
          409
        );
      sets.push('is_active = CASE WHEN retired_at IS NULL THEN ? ELSE 0 END');
      params.push(body.is_active ? 1 : 0);
    }
    if (body.record_retention_days !== undefined) {
      const value = optionalNonNegativeInteger(body.record_retention_days);
      if (value === undefined) {
        return c.json(
          { error: 'invalid_request', error_description: 'record_retention_days must be >= 0' },
          400
        );
      }
      sets.push('record_retention_days = ?');
      params.push(value);
    }
    if (body.withdrawal_allowed !== undefined) {
      sets.push('withdrawal_allowed = ?');
      params.push(body.withdrawal_allowed ? 1 : 0);
    }
    if (body.withdrawal_impact !== undefined) {
      sets.push('withdrawal_impact = ?');
      params.push(
        typeof body.withdrawal_impact === 'string' && body.withdrawal_impact.trim()
          ? body.withdrawal_impact.trim()
          : null
      );
    }
    if (body.reconsent_interval_days !== undefined) {
      const value = optionalNonNegativeInteger(body.reconsent_interval_days);
      if (value === undefined) {
        return c.json(
          { error: 'invalid_request', error_description: 'reconsent_interval_days must be >= 0' },
          400
        );
      }
      sets.push('reconsent_interval_days = ?');
      params.push(value);
    }

    if (sets.length === 0) {
      return c.json({ error: 'invalid_request', error_description: 'No fields to update' }, 400);
    }

    sets.push('definition_generation = definition_generation + 1');
    if (body.is_active === false) sets.push('closed_generation = closed_generation + 1');
    sets.push('updated_at = ?');
    const now = Date.now();
    params.push(now, id, tenantId);
    const result = await authCtx.coreAdapter.batch([
      {
        sql: `UPDATE consent_statements SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
        params,
      },
      enqueueStatementConsentProjection(tenantId, id, now),
    ]);
    if (result.length !== 2 || result.some((entry) => !entry.success))
      throw new Error('statement_consent_definition_result_unknown');

    const updated = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statements WHERE id = ?`,
      [id]
    );

    log.info('Updated consent statement', { action: 'update', statementId: id });
    return c.json(updated[0]);
  } catch (error) {
    log.error('Failed to update consent statement', { action: 'update' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update statement' }, 500);
  }
}

/** DELETE /api/admin/consent-statements/:id */
export async function adminConsentStatementDeleteHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;

    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM consent_statements WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Statement not found' }, 404);
    }

    // Only an inactive, untouched definition proves it has never been active. A statement
    // that was toggled back off has a nonzero generation and must retain its evidence.
    const draft = await authCtx.coreAdapter.query<{ id: string }>(
      `SELECT id FROM consent_statements d WHERE d.tenant_id=? AND d.id=?
       AND d.is_active=0 AND d.definition_generation=0 AND d.retired_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.tenant_id=d.tenant_id
         AND v.statement_id=d.id AND (v.status<>'draft' OR v.content_hash IS NOT NULL))`,
      [tenantId, id]
    );
    if (draft.length) {
      const stores = await tenantRBACStores(c, tenantId);
      if (!stores.accounts.length) throw new Error('statement_consent_account_stores_unavailable');
      let referenced = false;
      // The registry bounds the store count. Each query counts at most one record/history row;
      // a routing/read failure aborts deletion, and legacy metadata evidence is checked as well.
      for (const account of new Set([authCtx.coreAdapter, ...stores.accounts])) {
        const rows = await account.query<{ cnt: number | string }>(
          `SELECT COUNT(*) AS cnt FROM (SELECT id FROM user_consent_records WHERE tenant_id=? AND statement_id=? LIMIT 1) r
           UNION ALL SELECT COUNT(*) AS cnt FROM (SELECT id FROM consent_item_history WHERE tenant_id=? AND statement_id=? LIMIT 1) h`,
          [tenantId, id, tenantId, id]
        );
        if (rows.length !== 2) throw new Error('statement_consent_reference_count_unknown');
        referenced ||= rows.some((row) => Number(row.cnt) !== 0);
      }
      if (!referenced) {
        const proof = `EXISTS (SELECT 1 FROM consent_statements d WHERE d.tenant_id=? AND d.id=?
          AND d.is_active=0 AND d.definition_generation=0 AND d.retired_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.tenant_id=d.tenant_id
            AND v.statement_id=d.id AND (v.status<>'draft' OR v.content_hash IS NOT NULL)))`;
        const result = await authCtx.coreAdapter.batch([
          // Serialize with activation's parent-generation update before touching child bodies.
          // PostgreSQL may abort a conflicting parent/version lock order; batch rollback keeps
          // every body intact. Outer predicates are rechecked after a lock wait (EPQ).
          {
            sql: `UPDATE consent_statements SET updated_at=updated_at WHERE tenant_id=? AND id=?
            AND is_active=0 AND definition_generation=0 AND retired_at IS NULL AND ${proof}`,
            params: [tenantId, id, tenantId, id],
          },
          {
            sql: `DELETE FROM consent_statement_localizations WHERE tenant_id=? AND version_id IN
              (SELECT id FROM consent_statement_versions WHERE tenant_id=? AND statement_id=?) AND ${proof}`,
            params: [tenantId, tenantId, id, tenantId, id],
          },
          {
            sql: `DELETE FROM consent_statement_versions WHERE tenant_id=? AND statement_id=? AND ${proof}`,
            params: [tenantId, id, tenantId, id],
          },
          {
            sql: `DELETE FROM consent_statements WHERE tenant_id=? AND id=? AND ${proof}`,
            params: [tenantId, id, tenantId, id],
          },
        ]);
        if (result.length !== 4 || result.some((entry) => !entry.success))
          throw new Error('statement_consent_deletion_result_unknown');
        if (result[3].rowsAffected === 1) return c.json({ success: true, disposition: 'deleted' });
      }
    }

    const now = Date.now();
    const result = await authCtx.coreAdapter.batch([
      {
        sql: `UPDATE consent_statements SET is_active=0,retired_at=COALESCE(retired_at,?),
          definition_generation=definition_generation+1,closed_generation=closed_generation+1,updated_at=?
          WHERE tenant_id=? AND id=? AND retired_at IS NULL`,
        params: [now, now, tenantId, id],
      },
      enqueueStatementConsentProjection(tenantId, id, now),
    ]);
    if (result.length !== 2 || result.some((entry) => !entry.success))
      throw new Error('statement_consent_retirement_result_unknown');
    log.info('Retired consent statement; evidence retained', { action: 'retire', statementId: id });
    return c.json({ success: true, disposition: 'retired' });
  } catch (error) {
    log.error('Failed to delete consent statement', { action: 'delete' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete statement' }, 500);
  }
}

// =============================================================================
// Versions
// =============================================================================

/** GET /api/admin/consent-statements/:sid/versions */
export async function adminConsentVersionsListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const sid = c.req.param('sid')!;

    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_versions WHERE statement_id = ? AND tenant_id = ? ORDER BY effective_at DESC`,
      [sid, tenantId]
    );

    return c.json({ versions: rows });
  } catch (error) {
    log.error('Failed to list versions', { action: 'list_versions' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to list versions' }, 500);
  }
}

/** POST /api/admin/consent-statements/:sid/versions */
export async function adminConsentVersionCreateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const sid = c.req.param('sid')!;
    const body = await c.req.json<{
      version: string;
      content_type?: string;
      effective_at: number;
      effective_until?: number | null;
    }>();

    if (!body.version || !validateVersionFormat(body.version)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'version must be YYYYMMDD format (8 digits, valid date)',
        },
        400
      );
    }

    if (!body.effective_at) {
      return c.json(
        { error: 'invalid_request', error_description: 'effective_at is required' },
        400
      );
    }
    if (
      body.effective_until !== undefined &&
      body.effective_until !== null &&
      body.effective_until <= body.effective_at
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'effective_until must be after effective_at',
        },
        400
      );
    }

    // Check uniqueness
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM consent_statement_versions WHERE statement_id = ? AND tenant_id = ? AND version = ?`,
      [sid, tenantId, body.version]
    );
    if (existing.length > 0) {
      return c.json(
        { error: 'conflict', error_description: 'This version already exists for this statement' },
        409
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_statement_versions
       (id, tenant_id, statement_id, version, content_type, effective_at, effective_until, is_current, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?)`,
      [
        id,
        tenantId,
        sid,
        body.version,
        body.content_type ?? 'url',
        body.effective_at,
        body.effective_until ?? null,
        now,
        now,
      ]
    );

    const created = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_versions WHERE id = ?`,
      [id]
    );

    log.info('Created consent version', {
      action: 'create_version',
      statementId: sid,
      version: body.version,
    });
    return c.json(created[0], 201);
  } catch (error) {
    log.error('Failed to create version', { action: 'create_version' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create version' }, 500);
  }
}

/** GET /api/admin/consent-statements/:sid/versions/:vid */
export async function adminConsentVersionGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;

    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_versions WHERE id = ? AND tenant_id = ?`,
      [vid, tenantId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Version not found' }, 404);
    }

    return c.json(rows[0]);
  } catch (error) {
    log.error('Failed to get version', { action: 'get_version' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get version' }, 500);
  }
}

/** PUT /api/admin/consent-statements/:sid/versions/:vid */
export async function adminConsentVersionUpdateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;
    const body = await c.req.json<{
      version?: string;
      content_type?: string;
      effective_at?: number;
      effective_until?: number | null;
    }>();

    // Only allow editing draft versions
    const existing = await authCtx.coreAdapter.query<{ status: string; effective_at: number }>(
      `SELECT status, effective_at FROM consent_statement_versions WHERE id = ? AND tenant_id = ?`,
      [vid, tenantId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Version not found' }, 404);
    }
    if (existing[0].status !== 'draft') {
      return c.json(
        { error: 'invalid_request', error_description: 'Only draft versions can be edited' },
        400
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.version !== undefined) {
      if (!validateVersionFormat(body.version)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'version must be YYYYMMDD format (8 digits, valid date)',
          },
          400
        );
      }
      sets.push('version = ?');
      params.push(body.version);
    }
    if (body.content_type !== undefined) {
      sets.push('content_type = ?');
      params.push(body.content_type);
    }
    if (body.effective_at !== undefined) {
      sets.push('effective_at = ?');
      params.push(body.effective_at);
    }
    if (body.effective_until !== undefined) {
      const effectiveAt = body.effective_at ?? existing[0].effective_at;
      if (body.effective_until !== null && body.effective_until <= effectiveAt) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'effective_until must be after effective_at',
          },
          400
        );
      }
      sets.push('effective_until = ?');
      params.push(body.effective_until);
    }

    if (sets.length === 0) {
      return c.json({ error: 'invalid_request', error_description: 'No fields to update' }, 400);
    }

    sets.push('updated_at = CASE WHEN updated_at>=? THEN updated_at+1 ELSE ? END');
    const now = Date.now();
    params.push(now, now, vid, tenantId);

    await authCtx.coreAdapter.execute(
      `UPDATE consent_statement_versions SET ${sets.join(', ')} WHERE id = ? AND tenant_id=? AND status='draft'`,
      params
    );

    const updated = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_versions WHERE id = ?`,
      [vid]
    );
    return c.json(updated[0]);
  } catch (error) {
    log.error('Failed to update version', { action: 'update_version' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update version' }, 500);
  }
}

/** POST /api/admin/consent-statements/:sid/versions/:vid/activate */
export async function adminConsentVersionActivateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const sid = c.req.param('sid')!;
    const vid = c.req.param('vid')!;
    // Ask people who agreed to an earlier version again unless told not to (the safer default).
    const body: { reconsent?: unknown } = await c.req
      .json<{ reconsent?: unknown }>()
      .catch(() => ({}));
    if (body.reconsent !== undefined && typeof body.reconsent !== 'boolean') {
      return c.json(
        { error: 'invalid_request', error_description: 'reconsent must be a boolean' },
        400
      );
    }

    await activateVersion(authCtx.coreAdapter, tenantId, sid, vid, {
      reconsent: body.reconsent !== false,
    });

    const activated = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_versions WHERE id = ?`,
      [vid]
    );

    log.info('Activated consent version', {
      action: 'activate_version',
      statementId: sid,
      versionId: vid,
    });
    return c.json(activated[0]);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errMsg === 'document_changed')
      return c.json(
        {
          error: 'document_changed',
          error_description: 'Version changed during activation; retry',
        },
        409
      );
    if (errMsg === 'version_older_than_required_consent_version') {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'This version is older than the one agreement is required from; publish it asking people again (reconsent: true)',
        },
        400
      );
    }
    if (errMsg.includes('not found') || errMsg.includes('localization')) {
      return c.json({ error: 'invalid_request', error_description: errMsg }, 400);
    }
    log.error('Failed to activate version', { action: 'activate_version' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to activate version' }, 500);
  }
}

/** DELETE /api/admin/consent-statements/:sid/versions/:vid (draft only) */
export async function adminConsentVersionDeleteHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;

    const existing = await authCtx.coreAdapter.query<{ status: string }>(
      `SELECT status FROM consent_statement_versions WHERE id = ? AND tenant_id = ?`,
      [vid, tenantId]
    );
    if (existing.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Version not found' }, 404);
    }
    if (existing[0].status !== 'draft') {
      return c.json(
        { error: 'invalid_request', error_description: 'Only draft versions can be deleted' },
        400
      );
    }

    await authCtx.coreAdapter.execute(
      `DELETE FROM consent_statement_versions WHERE id = ? AND tenant_id = ? AND status = 'draft'`,
      [vid, tenantId]
    );

    log.info('Deleted draft version', { action: 'delete_version', versionId: vid });
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete version', { action: 'delete_version' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete version' }, 500);
  }
}

// =============================================================================
// Localizations
// =============================================================================

/** GET /api/admin/consent-statements/:sid/versions/:vid/localizations */
export async function adminConsentLocalizationsListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;

    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_localizations WHERE version_id = ? AND tenant_id = ? ORDER BY language ASC`,
      [vid, tenantId]
    );

    return c.json({ localizations: rows });
  } catch (error) {
    log.error('Failed to list localizations', { action: 'list_localizations' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list localizations' },
      500
    );
  }
}

/** PUT /api/admin/consent-statements/:sid/versions/:vid/localizations/:lang */
export async function adminConsentLocalizationUpsertHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;
    const lang = c.req.param('lang')!;
    const body = await c.req.json<{
      title: string;
      description: string;
      processing_purpose?: string | null;
      withdrawal_impact?: string | null;
      document_url?: string;
      inline_content?: string;
    }>();

    if (!body.title || !body.description) {
      return c.json(
        { error: 'invalid_request', error_description: 'title and description are required' },
        400
      );
    }

    const documentUrl = normalizeOptionalPublicLinkUrl(body.document_url, 'document_url');
    if (!documentUrl.valid) {
      return invalidPublicLinkUrlResponse(c, documentUrl.fieldName);
    }

    // The version must be one of this tenant's, and belong to the statement in the path.
    const version = await authCtx.coreAdapter.query<{ id: string; status: string }>(
      `SELECT id, status FROM consent_statement_versions WHERE id = ? AND statement_id = ? AND tenant_id = ?`,
      [vid, c.req.param('sid')!, tenantId]
    );
    if (version.length === 0) {
      return c.json({ error: 'not_found', error_description: 'Version not found' }, 404);
    }

    if (version[0].status !== 'draft') return immutableLocalizationResponse(c);

    const now = Date.now();

    // Check if existing
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM consent_statement_localizations WHERE version_id = ? AND language = ? AND tenant_id = ?`,
      [vid, lang, tenantId]
    );

    const written = await executeLocalizationUpsert({
      adapter: authCtx.coreAdapter,
      existing: existing.length > 0,
      id: crypto.randomUUID(),
      tenantId,
      versionId: vid,
      language: lang,
      title: body.title,
      description: body.description,
      processingPurpose: body.processing_purpose ?? null,
      withdrawalImpact: body.withdrawal_impact ?? null,
      documentUrl: documentUrl.value,
      inlineContent: body.inline_content ?? null,
      now,
    });

    if (written.rowsAffected !== 1) return immutableLocalizationResponse(c);
    const result = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_statement_localizations WHERE version_id = ? AND language = ? AND tenant_id = ?`,
      [vid, lang, tenantId]
    );

    log.info('Upserted localization', {
      action: 'upsert_localization',
      versionId: vid,
      language: lang,
    });
    return c.json(result[0]);
  } catch (error) {
    log.error('Failed to upsert localization', { action: 'upsert_localization' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to upsert localization' },
      500
    );
  }
}

/** DELETE /api/admin/consent-statements/:sid/versions/:vid/localizations/:lang */
export async function adminConsentLocalizationDeleteHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const vid = c.req.param('vid')!;
    const lang = c.req.param('lang')!;

    const version = await authCtx.coreAdapter.query<{ status: string }>(
      'SELECT status FROM consent_statement_versions WHERE id=? AND statement_id=? AND tenant_id=?',
      [vid, c.req.param('sid')!, tenantId]
    );
    if (!version.length)
      return c.json({ error: 'not_found', error_description: 'Version not found' }, 404);
    if (version[0].status !== 'draft') return immutableLocalizationResponse(c);

    const removed = await executeDraftLocalizationMutation(
      authCtx.coreAdapter,
      vid,
      tenantId,
      Date.now(),
      {
        sql: `DELETE FROM consent_statement_localizations WHERE version_id = ? AND language = ? AND tenant_id = ?
           AND EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.id=consent_statement_localizations.version_id
             AND v.tenant_id=consent_statement_localizations.tenant_id AND v.status='draft')`,
        params: [vid, lang, tenantId],
      }
    );

    if (removed.rowsAffected === 0) {
      const latest = await authCtx.coreAdapter.query<{ status: string }>(
        'SELECT status FROM consent_statement_versions WHERE id=? AND statement_id=? AND tenant_id=?',
        [vid, c.req.param('sid')!, tenantId]
      );
      if (!latest.length || latest[0].status !== 'draft') return immutableLocalizationResponse(c);
    }

    log.info('Deleted localization', {
      action: 'delete_localization',
      versionId: vid,
      language: lang,
    });
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete localization', { action: 'delete_localization' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete localization' },
      500
    );
  }
}

// =============================================================================
// User Consent Records (Admin View)
// =============================================================================

/**
 * The databases a user's statement consents live in: the tenant's definitions in the metadata
 * database, the user's records and history in the user's own account database. Null when the user
 * has no account route, i.e. no consents.
 */
async function resolveUserConsentStores(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  userId: string
): Promise<StatementConsentStores | null> {
  const account = await adminAccountCoreAdapter(c, tenantId, userId);
  return account ? { metadata: createAuthContextFromHono(c, tenantId).coreAdapter, account } : null;
}

/** GET /api/admin/users/:userId/consent-records */
export async function adminUserConsentRecordsListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('userId')!;
    const stores = await resolveUserConsentStores(c, tenantId, userId);
    if (!stores) return c.json({ records: [] });

    const records = await stores.account.query<Record<string, unknown> & { statement_id: string }>(
      `SELECT * FROM user_consent_records
       WHERE tenant_id = ? AND user_id = ?
       ORDER BY updated_at DESC`,
      [tenantId, userId]
    );
    // A record whose statement was removed is still listed: it is the evidence of an agreement.
    const definitions = await lookupStatementDefinitions(
      stores.metadata,
      tenantId,
      { statementIds: records.map((record) => record.statement_id), versionIds: [] },
      'en'
    );
    const rows = records.map((record) => ({
      ...record,
      slug: definitions.statements.get(record.statement_id)?.slug ?? null,
      category: definitions.statements.get(record.statement_id)?.category ?? null,
    }));

    return c.json({ records: rows });
  } catch (error) {
    log.error(
      'Failed to list user consent records',
      { action: 'list_user_records' },
      error as Error
    );
    return c.json({ error: 'server_error', error_description: 'Failed to list records' }, 500);
  }
}

/** GET /api/admin/users/:userId/consent-records/:statementId/history */
export async function adminUserConsentHistoryHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('userId')!;
    const statementId = c.req.param('statementId')!;
    const stores = await resolveUserConsentStores(c, tenantId, userId);
    if (!stores) return c.json({ history: [] });

    const rows = await stores.account.query(
      `SELECT * FROM consent_item_history
       WHERE tenant_id = ? AND user_id = ? AND statement_id = ?
       ORDER BY created_at DESC`,
      [tenantId, userId, statementId]
    );

    return c.json({ history: rows });
  } catch (error) {
    log.error('Failed to get consent history', { action: 'get_history' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get history' }, 500);
  }
}

/** POST /api/admin/users/:userId/consent-records/:statementId/withdraw */
export async function adminUserConsentWithdrawHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT');
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('userId')!;
    const statementId = c.req.param('statementId')!;
    const auth = getAdminAuth(c);
    const actorId = auth?.actorId ?? auth?.userId;
    if (!actorId) return c.json({ error: 'access_denied' }, 403);
    const stores = await resolveUserConsentStores(c, tenantId, userId);
    if (!stores)
      return c.json({ error: 'not_found', error_description: 'Consent record not found' }, 404);
    const result = await withdrawStatementConsent(stores, tenantId, userId, statementId, {
      env: c.env,
      actor: { id: actorId, type: 'admin' },
    });
    if (result === 'missing')
      return c.json({ error: 'not_found', error_description: 'Consent record not found' }, 404);
    if (result === 'not_granted')
      return c.json(
        { error: 'invalid_request', error_description: 'Can only withdraw granted consent (D3)' },
        400
      );
    if (result === 'withdrawal_forbidden')
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'This consent statement does not allow withdrawal',
        },
        400
      );

    log.info('Admin withdrew consent', { action: 'admin_withdraw', userId, statementId });
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'statement_consent_atomic_backend_unsupported')
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'Statement consent writes are unavailable on this database backend',
        },
        503
      );
    log.error('Failed to withdraw consent', { action: 'admin_withdraw' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to withdraw consent' }, 500);
  }
}
