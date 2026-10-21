import type { AuthrimLock } from './lock.js';
import { putKVKeyByNamespaceId } from './cloudflare.js';

/** Days a new environment keeps log rows in D1 before they move to R2. */
export const INITIAL_LOG_D1_RETENTION_DAYS = 7;

/**
 * New environments keep a week of log rows in D1 and move older rows to R2. The code default
 * (0) keeps every row in D1, so existing environments are unchanged; this runs on the first
 * deployment only. The value is written where the platform settings document is read from, and
 * the Admin API's log-storage settings change it later.
 */
export async function ensureInitialLogStorageSettings(input: {
  lock: AuthrimLock;
  putKv?: typeof putKVKeyByNamespaceId;
}): Promise<void> {
  const settingsNamespaceId = input.lock.kv.SETTINGS?.id;
  if (!settingsNamespaceId) throw new Error('log_storage_bootstrap_kv_missing');
  await (input.putKv ?? putKVKeyByNamespaceId)(
    settingsNamespaceId,
    'settings:platform:log-storage',
    JSON.stringify({ 'log-storage.d1_retention_days': INITIAL_LOG_D1_RETENTION_DAYS })
  );
}
