import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecurityMatrixEnv } from './env';
import { CallLedger } from './call-ledger';
import { installFrozenNow, restoreRealClock } from './deterministic-clock';
import { canonicalAuditPersistCount, installSecurityMatrixLogStorage } from './log-iceberg';
import { emitLogIcebergRow } from '../../../packages/ar-lib-core/src/services/log-iceberg-emitter';

beforeEach(() => {
  installFrozenNow(1700000000);
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreRealClock();
});
const input = () => ({
  tenantId: 'default',
  sourceDataset: 'core.event_log',
  logType: 'audit',
  eventAt: Date.now(),
  expiresAt: null,
  row: { id: 'matrix-durable-audit', tenant_id: 'default', event_type: 'security.test' },
});

describe('security audit persistence witness', () => {
  it('does not count a rejected real database commit as a successful audit', async () => {
    const ledger = new CallLedger(),
      kit = await createSecurityMatrixEnv(ledger);
    const fixture = await installSecurityMatrixLogStorage(kit, ledger);
    fixture.db.exec(
      "CREATE TRIGGER matrix_reject_log BEFORE INSERT ON log_iceberg_records BEGIN SELECT RAISE(ABORT,'matrix_log_commit_rejected'); END"
    );
    await expect(emitLogIcebergRow(kit.env, input())).rejects.toThrow('matrix_log_commit_rejected');
    expect(canonicalAuditPersistCount(ledger)).toBe(0);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
  });
  it('rejects corrupted committed ciphertext instead of manufacturing a ledger witness', async () => {
    const ledger = new CallLedger(),
      kit = await createSecurityMatrixEnv(ledger);
    const fixture = await installSecurityMatrixLogStorage(kit, ledger);
    const batch = fixture.adapter.batch.bind(fixture.adapter);
    vi.spyOn(fixture.adapter, 'batch').mockImplementation(async (statements) => {
      const result = await batch(statements);
      fixture.db.exec("UPDATE log_iceberg_record_parts SET body='x'||substr(body,2)");
      return result;
    });
    await expect(emitLogIcebergRow(kit.env, input())).rejects.toThrow();
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
    expect(canonicalAuditPersistCount(ledger)).toBe(0);
  });
});
