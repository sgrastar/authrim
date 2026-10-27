import type { DatabaseAdapter, PreparedStatement } from './adapter';

export interface GroupInputBoundaryScope {
  tenantId: string;
  userId: string;
  id: string;
}
export interface BeginGroupInputBoundary extends GroupInputBoundaryScope {
  operation: string;
  createdAt: number;
}
export type GroupBoundaryOutcome = 'completed' | 'failed' | 'accepted';
export interface GroupInputMutationCapability {
  begin(input: BeginGroupInputBoundary): Promise<void>;
  settle(input: GroupInputBoundaryScope, outcome: GroupBoundaryOutcome): Promise<void>;
}
export function assertGroupBoundary(input: GroupInputBoundaryScope): void {
  if (
    [input.tenantId, input.userId, input.id].some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value.length > 512 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  )
    throw new Error('group_boundary_input_invalid');
}
export function beginGroupBoundaryStatement(input: BeginGroupInputBoundary): PreparedStatement {
  assertGroupBoundary(input);
  if (
    typeof input.operation !== 'string' ||
    !input.operation ||
    input.operation.length > 256 ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 1
  )
    throw new Error('group_boundary_input_invalid');
  return {
    sql: `INSERT INTO service_group_write_boundaries(id,tenant_id,user_id,operation,status,created_at) VALUES (?,?,?,?,'writing',?)`,
    params: [input.id, input.tenantId, input.userId, input.operation, input.createdAt],
  };
}
export function settleGroupBoundaryStatement(
  input: GroupInputBoundaryScope,
  outcome: GroupBoundaryOutcome
): PreparedStatement {
  assertGroupBoundary(input);
  if (!['completed', 'failed', 'accepted'].includes(outcome))
    throw new Error('group_boundary_input_invalid');
  return {
    sql:
      outcome === 'failed'
        ? `UPDATE service_group_write_boundaries SET status='failed' WHERE tenant_id=? AND user_id=? AND id=?`
        : `DELETE FROM service_group_write_boundaries WHERE tenant_id=? AND user_id=? AND id=?${outcome === 'accepted' ? " AND status='failed'" : " AND status='writing'"}`,
    params: [input.tenantId, input.userId, input.id],
  };
}
export async function beginGroupInputBoundary(
  db: DatabaseAdapter,
  input: BeginGroupInputBoundary
): Promise<void> {
  const statement = beginGroupBoundaryStatement(input);
  if (db.groupInputMutations) return db.groupInputMutations.begin(input);
  if (db.getType() === 'aurora-dsql') throw new Error('group_boundary_capability_required');
  const result = await db.execute(statement.sql, statement.params);
  // D1 reports sqlite total_changes deltas, including the group revision trigger.
  // This INSERT targets one primary key: a positive aggregate proves insertion; zero does not.
  const inserted = db.getType() === 'd1' ? result.rowsAffected > 0 : result.rowsAffected === 1;
  if (!result.success || !Number.isSafeInteger(result.rowsAffected) || !inserted)
    throw new Error('group_boundary_write_failed');
}
export async function settleGroupInputBoundary(
  db: DatabaseAdapter,
  input: GroupInputBoundaryScope,
  outcome: GroupBoundaryOutcome
): Promise<void> {
  const statement = settleGroupBoundaryStatement(input, outcome);
  if (db.groupInputMutations) return db.groupInputMutations.settle(input, outcome);
  if (db.getType() === 'aurora-dsql') throw new Error('group_boundary_capability_required');
  const result = await db.execute(statement.sql, statement.params);
  if (!result.success) throw new Error('group_boundary_write_failed');
}
