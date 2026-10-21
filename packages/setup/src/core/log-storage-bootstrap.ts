import type { AuthrimLock } from './lock.js';
import { getOptionalKVKeyByNamespaceId, putKVKeyByNamespaceId } from './cloudflare.js';

/** Days a new environment keeps log rows in D1 before they move to R2. */
export const INITIAL_LOG_D1_RETENTION_DAYS = 7;
const LOG_STORAGE_SETTINGS_KEY = 'settings:platform:log-storage';

/**
 * New environments keep a week of log rows in D1 and move older rows to R2. The code default
 * (0) keeps every row in D1, so existing environments are unchanged. The value is written where
 * the platform settings document is read from, and only while there is no document yet: a
 * deployment run again never overrides what an administrator chose since.
 */
export async function ensureInitialLogStorageSettings(input: {
  lock: AuthrimLock;
  getKv?: typeof getOptionalKVKeyByNamespaceId;
  putKv?: typeof putKVKeyByNamespaceId;
}): Promise<'written' | 'kept'> {
  const settingsNamespaceId = input.lock.kv.SETTINGS?.id;
  if (!settingsNamespaceId) throw new Error('log_storage_bootstrap_kv_missing');
  const existing = await (input.getKv ?? getOptionalKVKeyByNamespaceId)(
    settingsNamespaceId,
    LOG_STORAGE_SETTINGS_KEY
  );
  if (existing !== null) return 'kept';
  await (input.putKv ?? putKVKeyByNamespaceId)(
    settingsNamespaceId,
    LOG_STORAGE_SETTINGS_KEY,
    JSON.stringify({ 'log-storage.d1_retention_days': INITIAL_LOG_D1_RETENTION_DAYS })
  );
  return 'written';
}
