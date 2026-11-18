import type { PreparedStatement } from '../../db/adapter';

/**
 * Installed seed rows a restored row takes the place of, though their ids differ.
 *
 * A fresh destination's baseline tenant gets core migration 013's terms of service and privacy
 * policy (`default-consent-statements.ts`, ids starting `cst_default_`). A backup of that tenant
 * made before them may hold its own statement under the same key (`UNIQUE (tenant_id, slug)`):
 * restoring it removes the installed one first, with its versions, texts and projection job, in
 * the same write. Only a statement the destination installed (its id prefix) and of the restored
 * tenant is removed; one the backup holds itself (the same id) is replaced as any seed row is.
 *
 * A backup that holds the installed statement itself, with a later version published, also has
 * a current version other than the installed one (`UNIQUE (tenant_id, current_statement_guard)`):
 * restoring that version removes the installed current version first, with its texts. The backup
 * restores its own copy of the installed version, if it holds one, afterwards.
 */
const DEFAULT_STATEMENT_PREFIX = 'cst_default_';
const DEFAULT_VERSION_PREFIX = 'csv_default_';

function text(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return Array.isArray(value) && value[0] === 'text' && typeof value[1] === 'string'
    ? value[1]
    : null;
}

export function installedSeedRowsSupersededBy(
  table: string,
  tenantId: string,
  storedRowJson: string,
  guard: { sql: string; params: readonly unknown[] }
): PreparedStatement[] {
  if (table === 'consent_statement_versions')
    return versionsSupersededBy(tenantId, storedRowJson, guard);
  if (table !== 'consent_statements') return [];
  const row = JSON.parse(storedRowJson) as Record<string, unknown>;
  const id = text(row, 'id');
  const slug = text(row, 'slug');
  if (!id || !slug) return [];
  const installed = `SELECT s.id FROM consent_statements s
    WHERE s.tenant_id = ? AND s.slug = ? AND s.id <> ?
      AND substr(s.id, 1, ${DEFAULT_STATEMENT_PREFIX.length}) = ?`;
  const installedParams = [tenantId, slug, id, DEFAULT_STATEMENT_PREFIX];
  const where = (sql: string, params: unknown[]) => ({
    sql: `${sql} AND ${guard.sql}`,
    params: [...params, ...guard.params],
  });
  return [
    where(
      `DELETE FROM statement_consent_projection_jobs WHERE tenant_id = ? AND statement_id IN (${installed})`,
      [tenantId, ...installedParams]
    ),
    where(
      `DELETE FROM consent_statement_localizations WHERE tenant_id = ? AND version_id IN (
        SELECT v.id FROM consent_statement_versions v
         WHERE v.tenant_id = ? AND v.statement_id IN (${installed}))`,
      [tenantId, tenantId, ...installedParams]
    ),
    where(
      `DELETE FROM consent_statement_versions WHERE tenant_id = ? AND statement_id IN (${installed})`,
      [tenantId, ...installedParams]
    ),
    where(`DELETE FROM consent_statements WHERE tenant_id = ? AND id IN (${installed})`, [
      tenantId,
      ...installedParams,
    ]),
  ];
}

function versionsSupersededBy(
  tenantId: string,
  storedRowJson: string,
  guard: { sql: string; params: readonly unknown[] }
): PreparedStatement[] {
  const row = JSON.parse(storedRowJson) as Record<string, unknown>;
  const id = text(row, 'id');
  const statementId = text(row, 'statement_id');
  // Only a current version can meet the installed current one.
  if (!id || !statementId || !text(row, 'current_statement_guard')) return [];
  const installed = `SELECT v.id FROM consent_statement_versions v
    WHERE v.tenant_id = ? AND v.statement_id = ? AND v.id <> ?
      AND v.current_statement_guard IS NOT NULL
      AND substr(v.id, 1, ${DEFAULT_VERSION_PREFIX.length}) = ?`;
  const installedParams = [tenantId, statementId, id, DEFAULT_VERSION_PREFIX];
  return [
    {
      sql: `DELETE FROM consent_statement_localizations WHERE tenant_id = ? AND version_id IN (${installed}) AND ${guard.sql}`,
      params: [tenantId, ...installedParams, ...guard.params],
    },
    {
      sql: `DELETE FROM consent_statement_versions WHERE tenant_id = ? AND id IN (${installed}) AND ${guard.sql}`,
      params: [tenantId, ...installedParams, ...guard.params],
    },
  ];
}
