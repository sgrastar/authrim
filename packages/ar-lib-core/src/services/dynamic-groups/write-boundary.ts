import type { DatabaseAdapter } from '../../db';
import { beginGroupInputBoundary, settleGroupInputBoundary } from '../../db/group-input-mutations';
/** Cross-database writes are not atomic. Keep membership readers fenced until the complete write settles. */
export async function withGroupInputWrite<T>(
  db: DatabaseAdapter,
  tenantId: string,
  userId: string,
  operation: string,
  write: () => Promise<T>
): Promise<T> {
  const id = crypto.randomUUID();
  const scope = { id, tenantId, userId };
  await beginGroupInputBoundary(db, { ...scope, operation, createdAt: Date.now() });
  try {
    const result = await write();
    await settleGroupInputBoundary(db, scope, 'completed');
    return result;
  } catch (error) {
    await settleGroupInputBoundary(db, scope, 'failed');
    throw error;
  }
}
