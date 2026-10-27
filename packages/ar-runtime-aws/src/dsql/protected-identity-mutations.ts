import { createHash } from 'node:crypto';
import {
  assertRecordLastLoginInput,
  recordLastLoginStatement,
  type ProtectedIdentityMutationCapability,
  type RecordLastLoginInput,
  type TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';

export interface ProtectedIdentityDatabase extends TransactionContext {
  retryableTransaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export function assertDsqlProtectedIdentitySchema(schema: string): void {
  if (!/^authrim_[a-z0-9_]{1,55}$/u.test(schema)) {
    throw new Error('dsql_protected_identity_schema_invalid');
  }
}

/** Native DSQL replacements for the trigger effects of an identity write. */
export function createDsqlProtectedIdentityMutations(
  db: ProtectedIdentityDatabase,
  schema: string
): ProtectedIdentityMutationCapability {
  assertDsqlProtectedIdentitySchema(schema);
  const table = (name: string) => `"${schema}"."${name}"`;
  const receipts = table('authrim_identity_mutation_receipts');
  return {
    version: 'protected-identity-v1',
    async recordLastLogin(input: RecordLastLoginInput): Promise<boolean> {
      assertRecordLastLoginInput(input);
      const source = JSON.stringify([
        'last-login-v1',
        input.tenantId,
        input.accountId,
        input.userId,
        input.operationId,
        input.observedAtMs,
      ]);
      const digest = createHash('sha256').update(source).digest('hex');
      const eventId = `evt_${digest}`;
      type Receipt = { input_sha256: string; source_json: string; applied: boolean };
      const read = (reader: TransactionContext) =>
        reader.queryOne<Receipt>(
          `SELECT input_sha256,source_json,applied FROM ${receipts} WHERE tenant_id=$1 AND operation_id=$2`,
          [input.tenantId, input.operationId]
        );
      const outcome = (receipt: Receipt) => {
        if (
          receipt.input_sha256 !== digest ||
          receipt.source_json !== source ||
          typeof receipt.applied !== 'boolean'
        ) {
          throw new Error('dsql_protected_identity_operation_conflict');
        }
        return receipt.applied;
      };
      const previous = await read(db);
      if (previous) return outcome(previous);
      try {
        return await db.retryableTransaction(async (tx) => {
          const replay = await read(tx);
          if (replay) return outcome(replay);
          const statement = recordLastLoginStatement('postgres', input, table('identity_accounts'));
          const changed = await tx.execute(statement.sql, statement.params);
          if (!changed.success || changed.rowsAffected < 0 || changed.rowsAffected > 1) {
            throw new Error('dsql_protected_identity_write_invalid');
          }
          const applied = changed.rowsAffected === 1;
          if (applied) {
            // Matches account_webhook_updated's identity predicate. Only metadata changed;
            // lifecycle, display label, and registration state were not rewritten.
            const outbox = await tx.execute(
              `INSERT INTO ${table('account_webhook_outbox')}
                (id,tenant_id,user_id,event_type,registration_state,previous_registration_state,changed_field,occurred_at)
               SELECT $1,tenant_id,legacy_user_id,'account.updated',registration_state,NULL,'account',$2
               FROM ${table('identity_accounts')} WHERE tenant_id=$3 AND id=$4 AND legacy_user_id=$5
                 AND account_type='user' AND lifecycle_state NOT IN ('deleted','deleting') AND directory_publication_state='active'`,
              [eventId, input.observedAtMs, input.tenantId, input.accountId, input.userId]
            );
            if (!outbox.success || outbox.rowsAffected < 0 || outbox.rowsAffected > 1)
              throw new Error('dsql_protected_identity_write_invalid');
            const revision = await tx.execute(
              `INSERT INTO ${table('service_group_inputs')} (tenant_id,user_id,revision) VALUES ($1,$2,1)
               ON CONFLICT (tenant_id,user_id) DO UPDATE SET revision=${table('service_group_inputs')}.revision+1`,
              [input.tenantId, input.userId]
            );
            if (!revision.success || revision.rowsAffected !== 1)
              throw new Error('dsql_protected_identity_write_invalid');
          }
          const receipt = await tx.execute(
            `INSERT INTO ${receipts} (tenant_id,operation_id,input_sha256,source_json,applied,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
            [input.tenantId, input.operationId, digest, source, applied, input.observedAtMs]
          );
          if (!receipt.success || receipt.rowsAffected !== 1)
            throw new Error('dsql_protected_identity_write_invalid');
          return applied;
        });
      } catch (error) {
        // Never blindly replay an uncertain COMMIT. Only its exact durable receipt proves success.
        const committed = await read(db);
        if (committed) return outcome(committed);
        throw error;
      }
    },
  };
}

/**
 * Additive DSQL protection tables. The owning native Core plan must also supply identity_accounts.
 * These are not executed automatically and do not replace/rewrite PostgreSQL migrations.
 */
export function createDsqlIdentityProtectionSchemaPlan(schema: string) {
  assertDsqlProtectedIdentitySchema(schema);
  const definitions = {
    account_webhook_outbox: `id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      event_type TEXT NOT NULL, registration_state TEXT NOT NULL CHECK (registration_state IN ('guest','registered')),
      previous_registration_state TEXT, changed_field TEXT, occurred_at BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0, delivered_at BIGINT`,
    service_group_inputs: `tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id,user_id)`,
    authrim_identity_mutation_receipts: `tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      input_sha256 TEXT NOT NULL, source_json TEXT NOT NULL, applied BOOLEAN NOT NULL,
      created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id,operation_id)`,
  };
  return {
    scope: 'protected-identity-last-login' as const,
    fullRuntimeReady: false as const,
    schema,
    tables: Object.entries(definitions).map(([name, definition]) => ({
      name,
      sql: `CREATE TABLE "${schema}"."${name}" (${definition})`,
    })),
    indexes: [
      {
        name: 'idx_account_webhook_outbox_due',
        table: 'account_webhook_outbox',
        unique: false,
        sql: `CREATE INDEX ASYNC "idx_account_webhook_outbox_due" ON "${schema}"."account_webhook_outbox" (tenant_id,delivered_at,next_attempt_at,lease_until)`,
      },
    ],
  };
}
