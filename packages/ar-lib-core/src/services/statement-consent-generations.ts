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
  await account.execute(
    `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,definition_generation,closed_generation,physical_id,restore_epoch,created_at,updated_at)
     VALUES(?,'statement',?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,scope_kind,scope_key) DO UPDATE SET mode=excluded.mode,
     definition_generation=excluded.definition_generation,closed_generation=excluded.closed_generation,updated_at=excluded.updated_at
     WHERE statement_consent_guards.definition_generation<=excluded.definition_generation
       AND statement_consent_guards.closed_generation<=excluded.closed_generation
       AND statement_consent_guards.account_id=excluded.account_id
       AND statement_consent_guards.physical_id=excluded.physical_id AND statement_consent_guards.restore_epoch=excluded.restore_epoch`,
    [
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
    ]
  );
}
