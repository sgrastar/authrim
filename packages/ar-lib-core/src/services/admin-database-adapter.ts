import type { DatabaseAdapter } from '../db/adapter';
import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import type { Env } from '../types/env';

type AdminDatabaseBindings = Partial<Pick<Env, 'DB_ADMIN'>>;

export function resolveAdminDatabaseSource(env: AdminDatabaseBindings): DatabaseSource | null {
  return env.DB_ADMIN ?? null;
}

export function ensureAdminDatabaseAdapter(
  env: AdminDatabaseBindings,
  partition: string = 'admin'
): DatabaseAdapter | null {
  const source = resolveAdminDatabaseSource(env);
  return source ? ensureDatabaseAdapter(source, partition) : null;
}

export function requireAdminDatabaseAdapter(
  env: AdminDatabaseBindings,
  partition: string = 'admin'
): DatabaseAdapter {
  const adapter = ensureAdminDatabaseAdapter(env, partition);
  if (!adapter) {
    throw new Error('Admin database is not configured');
  }
  return adapter;
}

export function requireDedicatedAdminDatabaseAdapter(
  env: Partial<Pick<Env, 'DB_ADMIN'>>,
  partition: string = 'admin'
): DatabaseAdapter {
  if (!env.DB_ADMIN) {
    throw new Error('DB_ADMIN is not configured');
  }
  return ensureDatabaseAdapter(env.DB_ADMIN, partition);
}
