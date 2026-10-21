import { describe, expect, it, vi } from 'vitest';
import type { AuthrimLock } from '../core/lock';
import { ensureInitialLogStorageSettings } from '../core/log-storage-bootstrap';

describe('ensureInitialLogStorageSettings', () => {
  it('writes a week of D1 log retention to the platform settings of a new environment', async () => {
    const putKv = vi.fn().mockResolvedValue(undefined);
    await ensureInitialLogStorageSettings({
      lock: { kv: { SETTINGS: { id: 'settings-namespace' } } } as unknown as AuthrimLock,
      putKv,
    });
    expect(putKv).toHaveBeenCalledWith(
      'settings-namespace',
      'settings:platform:log-storage',
      JSON.stringify({ 'log-storage.d1_retention_days': 7 })
    );
  });

  it('refuses a lock without the settings namespace', async () => {
    await expect(
      ensureInitialLogStorageSettings({
        lock: { kv: {} } as unknown as AuthrimLock,
        putKv: vi.fn(),
      })
    ).rejects.toThrow('log_storage_bootstrap_kv_missing');
  });
});
