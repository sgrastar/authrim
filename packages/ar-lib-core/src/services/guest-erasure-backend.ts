import type { DatabaseAdapter } from '../db/adapter';
import { PostgresAdapter } from '../db/adapters/postgres-adapter';

/** Native PG batch owns an exclusive ordered transaction; an arbitrary getType tag is insufficient. */
export function assertGuestErasureBackend(adapter: DatabaseAdapter): 'd1' | 'postgres' {
  const kind = adapter.getType();
  if (kind === 'd1') return kind;
  if (kind === 'postgres' && adapter instanceof PostgresAdapter) return kind;
  throw new Error('guest_deletion_backend_unsupported');
}
