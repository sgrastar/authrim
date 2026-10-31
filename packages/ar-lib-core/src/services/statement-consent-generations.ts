import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import {
  ensureStatementConsentTenantGuard,
  statementConsentAtomicCapability,
} from './statement-consent-writes';

/** Enqueued in the metadata mutation's own transaction, so a lost response cannot lose work. */
export function enqueueStatementConsentProjection(
  tenantId: string,
  statementId: string,
  now: number,
  activation?: { versionId: string; token: string }
): PreparedStatement {
  return {
    sql: `INSERT INTO statement_consent_projection_jobs(tenant_id,statement_id,definition_generation,closed_generation,mode,targets_json,cursor_binding_ref,updated_at)
      SELECT tenant_id,id,definition_generation,closed_generation,CASE WHEN is_active=0 OR retired_at IS NOT NULL THEN 'closed' ELSE 'enforced' END,NULL,NULL,?
      FROM consent_statements WHERE tenant_id=? AND id=?
      ${activation ? 'AND EXISTS (SELECT 1 FROM consent_statement_versions v WHERE v.tenant_id=consent_statements.tenant_id AND v.statement_id=consent_statements.id AND v.id=? AND v.current_statement_guard=?)' : ''}
      ON CONFLICT(tenant_id,statement_id) DO UPDATE SET definition_generation=excluded.definition_generation,
      closed_generation=excluded.closed_generation,mode=excluded.mode,targets_json=NULL,cursor_binding_ref=NULL,updated_at=excluded.updated_at`,
    params: [
      now,
      tenantId,
      statementId,
      ...(activation ? [activation.versionId, activation.token] : []),
    ],
  };
}

export interface StatementConsentProjection {
  statement_id: string;
  definition_generation: number;
  closed_generation: number;
  mode: 'enforced' | 'closed';
}

/** Monotone across retries and out-of-order workers; never repairs a restored physical identity. */
export async function projectStatementConsentGeneration(
  account: DatabaseAdapter,
  tenantId: string,
  projection: StatementConsentProjection
): Promise<void> {
  statementConsentAtomicCapability(account);
  for (const generation of [projection.definition_generation, projection.closed_generation]) {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error('statement_consent_projection_invalid');
  }
  const now = Date.now();
  const tenant = await ensureStatementConsentTenantGuard(account, tenantId, now);
  const existing = await account.queryOne<{
    account_id: string;
    physical_id: string;
    restore_epoch: string;
  }>(
    "SELECT account_id,physical_id,restore_epoch FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='statement' AND scope_key=?",
    [tenantId, projection.statement_id],
    { consistencyClass: 'primary_required' }
  );
  if (
    existing &&
    (existing.account_id !== tenant.account_id ||
      existing.physical_id !== tenant.physical_id ||
      existing.restore_epoch !== tenant.restore_epoch)
  )
    throw new Error('statement_consent_restore_rebind_required');
  const identity = [tenant.account_id, tenant.physical_id, tenant.restore_epoch];
  const statements: PreparedStatement[] = [
    {
      sql: `UPDATE statement_consent_guards SET mode=?,definition_generation=?,closed_generation=?,
        updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END
        WHERE tenant_id=? AND scope_kind='statement' AND scope_key=?
          AND account_id=? AND physical_id=? AND restore_epoch=?
          AND definition_generation<=? AND closed_generation<=?
          AND (mode<>'closed' OR ?='closed' OR definition_generation<?)`,
      params: [
        projection.mode,
        projection.definition_generation,
        projection.closed_generation,
        now,
        now,
        tenantId,
        projection.statement_id,
        ...identity,
        projection.definition_generation,
        projection.closed_generation,
        projection.mode,
        projection.definition_generation,
      ],
    },
    {
      sql: `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,definition_generation,closed_generation,physical_id,restore_epoch,created_at,updated_at)
        SELECT ?,'statement',?,?,?,?,?,?,?,?,? WHERE NOT EXISTS
        (SELECT 1 FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='statement' AND scope_key=?)`,
      params: [
        tenantId,
        projection.statement_id,
        projection.mode,
        tenant.account_id,
        projection.definition_generation,
        projection.closed_generation,
        tenant.physical_id,
        tenant.restore_epoch,
        now,
        now,
        tenantId,
        projection.statement_id,
      ],
    },
  ];
  try {
    const results = await account.batch(statements);
    if (results.length !== 2 || results.some((r) => !r.success))
      throw new Error('statement_consent_projection_result_unknown');
    if (results.reduce((n, r) => n + Number(r.rowsAffected), 0) !== 1)
      throw new Error('statement_consent_projection_stale');
  } catch (error) {
    // A lost response is recoverable only from the exact projected primary state. A
    // concurrent creation of a different generation remains a retryable failure.
    const row = await account.queryOne<{
      account_id: string;
      physical_id: string;
      restore_epoch: string;
      definition_generation: number | string;
      closed_generation: number | string;
      mode: string;
    }>(
      "SELECT * FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='statement' AND scope_key=?",
      [tenantId, projection.statement_id],
      { consistencyClass: 'primary_required' }
    );
    if (
      row &&
      row.account_id === tenant.account_id &&
      row.physical_id === tenant.physical_id &&
      row.restore_epoch === tenant.restore_epoch &&
      Number(row.definition_generation) === projection.definition_generation &&
      Number(row.closed_generation) === projection.closed_generation &&
      row.mode === projection.mode
    )
      return;
    throw error;
  }
}
