import { createHash } from 'node:crypto';
import {
  assertLegalHoldMutation,
  createLegalHoldPlan,
  releaseLegalHoldPlan,
  legalHoldGuardStatement,
  type AccountGovernanceMutationCapability,
  type CreateLegalHoldInput,
  type ReleaseLegalHoldInput,
  type TransactionContext,
  type PreparedStatement,
  type ExecuteResult,
  accountDeletionPlan,
  type AccountDeletionInput,
  supportContextStatement,
} from '@authrim/ar-lib-core/db/adapter';
import {
  assertDsqlProtectedIdentitySchema,
  type ProtectedIdentityDatabase,
} from './protected-identity-mutations';

/** Shared existing governance handlers dispatch here; no new public management API is introduced. */
export function createDsqlGovernanceMutations(
  db: ProtectedIdentityDatabase,
  coreSchema: string,
  eventSchema: string
): AccountGovernanceMutationCapability {
  assertDsqlProtectedIdentitySchema(coreSchema);
  assertDsqlProtectedIdentitySchema(eventSchema);
  if (coreSchema === eventSchema) throw new Error('dsql_governance_event_schema_must_be_separate');
  const core = (table: string) => `"${coreSchema}"."${table}"`;
  const receipts = core('authrim_governance_mutation_receipts');
  const qualify = (statement: PreparedStatement): PreparedStatement => ({
    ...statement,
    sql: statement.sql.replace(
      /\b(legal_holds|legal_hold_events|legal_hold_projection_outbox|account_legal_hold_states|account_support_contexts|identity_accounts)\b/gu,
      (name) => `"${name === 'legal_hold_events' ? eventSchema : coreSchema}"."${name}"`
    ),
  });
  const none = (): ExecuteResult[] =>
    Array.from({ length: 3 }, () => ({ success: true, rowsAffected: 0 }));
  async function mutate(
    kind: 'create' | 'release',
    input: CreateLegalHoldInput | ReleaseLegalHoldInput
  ): Promise<ExecuteResult[]> {
    assertLegalHoldMutation(input);
    // An HTTP retry obtains a new clock reading. The action payload, actor, scope and identifiers
    // remain pinned; its first committed event supplies effective/created time forever.
    const source = JSON.stringify([
      'account-governance-v1',
      kind,
      input.tenantId,
      input.accountId,
      input.holdId,
      input.eventId,
      input.operationId,
      input.actor,
      input.reasonCode,
      'expectedVersion' in input ? input.expectedVersion : null,
      'caseReference' in input ? input.caseReference : null,
      'expiresAt' in input ? input.expiresAt : null,
    ]);
    const sha = createHash('sha256').update(source).digest('hex');
    type Receipt = { input_sha256: string; source_json: string; applied: boolean };
    const read = (reader: TransactionContext) =>
      reader.queryOne<Receipt>(
        `SELECT input_sha256,source_json,applied FROM ${receipts} WHERE tenant_id=$1 AND operation_id=$2`,
        [input.tenantId, input.operationId]
      );
    const replay = (row: Receipt) => {
      if (row.input_sha256 !== sha || row.source_json !== source || row.applied !== true)
        throw new Error('account_governance_operation_conflict');
      return none();
    };
    const prior = await read(db);
    if (prior) return replay(prior);
    try {
      return await db.retryableTransaction(async (tx) => {
        const prior = await read(tx);
        if (prior) return replay(prior);
        const plan = (
          kind === 'create'
            ? createLegalHoldPlan(input as CreateLegalHoldInput)
            : releaseLegalHoldPlan(input as ReleaseLegalHoldInput)
        ).map(qualify);
        const guard =
          kind === 'create'
            ? qualify(legalHoldGuardStatement(input.tenantId, input.accountId, input.now))
            : {
                sql: `UPDATE ${core('account_legal_hold_states')} SET updated_at=CASE WHEN updated_at >= $1 THEN updated_at+1 ELSE $1 END
            WHERE tenant_id=$2 AND account_id=$3 AND active_hold_id=$4 AND projection_state='active'`,
                params: [input.now, input.tenantId, input.accountId, input.holdId],
              };
        const guarded = await tx.execute(guard.sql, guard.params);
        if (!guarded.success) throw new Error('dsql_governance_guard_failed');
        if (guarded.rowsAffected !== 1) return none();
        const mutation = await tx.execute(plan[0].sql, plan[0].params);
        if (!mutation.success) throw new Error('dsql_governance_write_failed');
        if (mutation.rowsAffected !== 1) return none();
        const projection = await tx.execute(
          `UPDATE ${core('account_legal_hold_states')} SET active_hold_id=$1,projection_state=$2,
             projection_generation=projection_generation+1,updated_at=$3
           WHERE tenant_id=$4 AND account_id=$5 AND projection_state=$6
             AND ${kind === 'create' ? 'active_hold_id IS NULL' : 'active_hold_id=$7'}`,
          [
            kind === 'create' ? input.holdId : null,
            kind === 'create' ? 'active' : 'inactive',
            input.now,
            input.tenantId,
            input.accountId,
            kind === 'create' ? 'inactive' : 'active',
            ...(kind === 'create' ? [] : [input.holdId]),
          ]
        );
        if (!projection.success || projection.rowsAffected !== 1)
          throw new Error('dsql_governance_projection_failed');
        const effects = [];
        for (const statement of plan.slice(1)) {
          const result = await tx.execute(statement.sql, statement.params);
          if (!result.success || result.rowsAffected !== 1)
            throw new Error('dsql_governance_evidence_failed');
          effects.push(result);
        }
        const receipt = await tx.execute(
          `INSERT INTO ${receipts} (tenant_id,operation_id,input_sha256,source_json,applied,created_at)
          VALUES ($1,$2,$3,$4,TRUE,$5)`,
          [input.tenantId, input.operationId, sha, source, input.now]
        );
        if (!receipt.success || receipt.rowsAffected !== 1)
          throw new Error('dsql_governance_receipt_failed');
        return [mutation, ...effects];
      });
    } catch (error) {
      const committed = await read(db);
      if (committed) return replay(committed);
      throw error;
    }
  }
  return {
    createLegalHold: (input) => mutate('create', input),
    releaseLegalHold: (input) => mutate('release', input),
    putSupportContext: async (input) => {
      const statement = qualify(supportContextStatement(input));
      return db.execute(statement.sql, statement.params);
    },
    async transitionAccountDeletion(input: AccountDeletionInput): Promise<boolean> {
      const statements = accountDeletionPlan(input).map(qualify);
      return db.retryableTransaction(async (tx) => {
        const guard = await tx.execute(statements[0].sql, statements[0].params);
        if (!guard.success) throw new Error('dsql_governance_guard_failed');
        if (guard.rowsAffected !== 1) return false;
        const account = await tx.queryOne<{
          legacy_user_id: string | null;
          account_type: string;
          registration_state: string;
          lifecycle_state: string;
        }>(
          `SELECT legacy_user_id,account_type,registration_state,lifecycle_state FROM ${core('identity_accounts')} WHERE tenant_id=$1 AND id=$2`,
          [input.tenantId, input.accountId]
        );
        if (!account) return false;
        if (account.lifecycle_state === input.state) return true;
        if (input.state === 'deleting' && account.lifecycle_state === 'deleted') return false;
        const changed = await tx.execute(statements[1].sql, statements[1].params);
        if (!changed.success || changed.rowsAffected !== 1)
          throw new Error('dsql_governance_write_failed');
        if (account.legacy_user_id !== null) {
          const revision = await tx.execute(
            `INSERT INTO ${core('service_group_inputs')} (tenant_id,user_id,revision) VALUES ($1,$2,1)
            ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=${core('service_group_inputs')}.revision+1`,
            [input.tenantId, account.legacy_user_id]
          );
          if (!revision.success || revision.rowsAffected !== 1)
            throw new Error('dsql_governance_write_failed');
          if (account.account_type === 'user' && input.state === 'deleted') {
            const eventId = `evt_${createHash('sha256')
              .update(JSON.stringify(['account-deleted-v1', input.tenantId, input.accountId]))
              .digest('hex')}`;
            const outbox = await tx.execute(
              `INSERT INTO ${core('account_webhook_outbox')}
              (id,tenant_id,user_id,event_type,registration_state,previous_registration_state,changed_field,occurred_at)
              VALUES ($1,$2,$3,'account.deleted',$4,NULL,NULL,$5)`,
              [
                eventId,
                input.tenantId,
                account.legacy_user_id,
                account.registration_state,
                input.now,
              ]
            );
            if (!outbox.success || outbox.rowsAffected !== 1)
              throw new Error('dsql_governance_write_failed');
          }
        }
        return true;
      });
    },
  };
}
