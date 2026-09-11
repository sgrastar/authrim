import type { DatabaseAdapter } from '../../db';
/** Cross-database writes are not atomic. Keep membership readers fenced until the complete write settles. */
export async function withGroupInputWrite<T>(
  db: DatabaseAdapter,
  tenantId: string,
  userId: string,
  operation: string,
  write: () => Promise<T>
): Promise<T> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO service_group_write_boundaries(id, tenant_id, user_id, operation, status, created_at) VALUES (?, ?, ?, ?, 'writing', ?)`,
    [id, tenantId, userId, operation, Date.now()]
  );
  try {
    const result = await write();
    await db.execute(
      `DELETE FROM service_group_write_boundaries WHERE tenant_id = ? AND user_id = ? AND id = ?`,
      [tenantId, userId, id]
    );
    return result;
  } catch (error) {
    await db.execute(
      `UPDATE service_group_write_boundaries SET status = 'failed' WHERE tenant_id = ? AND user_id = ? AND id = ?`,
      [tenantId, userId, id]
    );
    throw error;
  }
}
