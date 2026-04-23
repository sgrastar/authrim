import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from './adapter';
import { D1Adapter } from './adapters';

export type DatabaseSource = DatabaseAdapter | D1Database;

export function isDatabaseAdapter(value: unknown): value is DatabaseAdapter {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DatabaseAdapter>;
  return (
    typeof candidate.query === 'function' &&
    typeof candidate.queryOne === 'function' &&
    typeof candidate.execute === 'function' &&
    typeof candidate.transaction === 'function' &&
    typeof candidate.batch === 'function' &&
    typeof candidate.isHealthy === 'function' &&
    typeof candidate.getType === 'function' &&
    typeof candidate.close === 'function'
  );
}

export function ensureDatabaseAdapter(
  source: DatabaseSource,
  partition: string = 'core'
): DatabaseAdapter {
  return isDatabaseAdapter(source) ? source : new D1Adapter({ db: source, partition });
}

export function ensureOptionalDatabaseAdapter(
  source: DatabaseSource | null | undefined,
  partition: string = 'core'
): DatabaseAdapter | null {
  if (!source) {
    return null;
  }
  return ensureDatabaseAdapter(source, partition);
}
