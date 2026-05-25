import type { Context } from 'hono';
import {
  resolveOptionalCoreAdapterFromHono,
  createReBACService,
  type Env as SharedEnv,
  type DatabaseAdapter,
  type IStorageAdapter,
  type ReBACConfig,
  type ReBACService,
} from '@authrim/ar-lib-core';

export function getPolicyCoreAdapter<TBindings extends SharedEnv>(
  c: Context<{ Bindings: TBindings }>
): DatabaseAdapter {
  const adapter = resolveOptionalCoreAdapterFromHono(
    c as unknown as Context<{ Bindings: SharedEnv }>,
    'policy'
  );
  if (!adapter) {
    throw new Error('Core database is required for policy storage');
  }
  return adapter;
}

export function createReBACStorageAdapter(adapter: DatabaseAdapter): IStorageAdapter {
  return {
    async get(_key: string): Promise<string | null> {
      return null;
    },
    async set(_key: string, _value: string, _ttl?: number): Promise<void> {},
    async delete(_key: string): Promise<void> {},
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
      return adapter.query<T>(sql, params);
    },
    async execute(sql: string, params?: unknown[]) {
      const result = await adapter.execute(sql, params);
      return {
        success: result.success,
        meta: {
          changes: result.rowsAffected,
          last_row_id: Number(result.lastInsertRowid ?? 0),
        },
      };
    },
  };
}

export function createPolicyReBACService(adapter: DatabaseAdapter, cache?: unknown): ReBACService {
  const config: ReBACConfig = {
    cache_namespace: cache as unknown as ReBACConfig['cache_namespace'],
    cache_ttl: 60,
    max_depth: 5,
  };

  return createReBACService(createReBACStorageAdapter(adapter), config);
}
