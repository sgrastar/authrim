import {
  beginGroupBoundaryStatement,
  settleGroupBoundaryStatement,
  type GroupInputMutationCapability,
  type BeginGroupInputBoundary,
  type TransactionContext,
  type PreparedStatement,
} from '@authrim/ar-lib-core/db/adapter';
import {
  assertDsqlProtectedIdentitySchema,
  type ProtectedIdentityDatabase,
} from './protected-identity-mutations';

export function createDsqlGroupInputMutations(
  db: ProtectedIdentityDatabase,
  schema: string
): GroupInputMutationCapability {
  assertDsqlProtectedIdentitySchema(schema);
  const table = (name: string) => `"${schema}"."${name}"`;
  const qualify = (s: PreparedStatement) => ({
    ...s,
    sql: s.sql.replaceAll(
      'service_group_write_boundaries',
      table('service_group_write_boundaries')
    ),
  });
  async function revision(tx: TransactionContext, tenantId: string, userId: string) {
    const result = await tx.execute(
      `INSERT INTO ${table('service_group_inputs')}(tenant_id,user_id,revision) VALUES ($1,$2,1)
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=${table('service_group_inputs')}.revision+1`,
      [tenantId, userId]
    );
    if (!result.success || result.rowsAffected !== 1) throw new Error('dsql_group_revision_failed');
  }
  type Boundary = {
    tenant_id: string;
    user_id: string;
    operation: string;
    created_at: number | string;
    status: string;
  };
  const read = (tx: TransactionContext, id: string) =>
    tx.queryOne<Boundary>(
      `SELECT tenant_id,user_id,operation,created_at,status FROM ${table('service_group_write_boundaries')} WHERE id=$1`,
      [id]
    );
  const exact = (row: Boundary, input: BeginGroupInputBoundary) => {
    if (
      row.tenant_id !== input.tenantId ||
      row.user_id !== input.userId ||
      row.operation !== input.operation ||
      Number(row.created_at) !== input.createdAt ||
      row.status !== 'writing'
    )
      throw new Error('group_boundary_operation_conflict');
  };
  return {
    async begin(input) {
      const statement = qualify(beginGroupBoundaryStatement(input));
      try {
        await db.retryableTransaction(async (tx) => {
          const previous = await read(tx, input.id);
          if (previous) {
            exact(previous, input);
            return;
          }
          const result = await tx.execute(statement.sql, statement.params);
          if (!result.success || result.rowsAffected !== 1)
            throw new Error('dsql_group_boundary_failed');
          await revision(tx, input.tenantId, input.userId);
        });
      } catch (error) {
        const committed = await read(db, input.id);
        if (committed) {
          exact(committed, input);
          return;
        }
        throw error;
      }
    },
    async settle(input, outcome) {
      const statement = qualify(settleGroupBoundaryStatement(input, outcome));
      await db.retryableTransaction(async (tx) => {
        const result = await tx.execute(statement.sql, statement.params);
        if (!result.success || result.rowsAffected < 0 || result.rowsAffected > 1)
          throw new Error('dsql_group_boundary_failed');
        if (result.rowsAffected === 1 && outcome !== 'failed')
          await revision(tx, input.tenantId, input.userId);
      });
    },
  };
}

export function createDsqlGroupBoundarySchemaPlan(schema: string) {
  assertDsqlProtectedIdentitySchema(schema);
  return {
    scope: 'protected-group-boundaries' as const,
    fullRuntimeReady: false as const,
    tables: [
      {
        name: 'service_group_write_boundaries',
        sql: `CREATE TABLE "${schema}"."service_group_write_boundaries" (
      id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,operation TEXT NOT NULL,
      status TEXT NOT NULL,created_at BIGINT NOT NULL)`,
      },
    ],
    indexes: [
      {
        name: 'idx_service_group_write_boundaries_subject',
        sql: `CREATE INDEX ASYNC "idx_service_group_write_boundaries_subject"
      ON "${schema}"."service_group_write_boundaries" (tenant_id,user_id)`,
      },
    ],
  };
}
