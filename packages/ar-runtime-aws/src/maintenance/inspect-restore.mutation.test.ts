import { describe, expect, it, vi } from 'vitest';
import type { AwsRestoreActivationEvidence } from '../import/restore-coordinator';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { readCommittedMaintenanceActivation } from './inspect-restore';
import type { MaintenanceSqlClient } from './database';

const hex = 'a'.repeat(64);
const base: AwsRestoreActivationEvidence = {
  formatVersion: 1,
  restoreId: '11111111-1111-4111-8111-111111111111',
  coreTargetId: '22222222-2222-4222-8222-222222222222',
  piiTargetId: '33333333-3333-4333-8333-333333333333',
  tenantId: 'tenant-a',
  issuer: 'https://id.example.test',
  bundleId: 'a'.repeat(32),
  snapshotId: 'snapshot-1',
  inventoryDigestSha256: hex,
  backupReceiptSha256: hex,
  supplementFileSha256: hex,
  coreReceiptSha256: hex,
  piiReceiptSha256: hex,
  stateReceiptSha256: hex,
  configurationSha256: hex,
  boundaryUnixMs: 1_000,
  activatedAtMs: 2_000,
  maxSnapshotAgeMs: 3_600_000,
};
const expectedOf = (e: Record<string, unknown>) => ({
  restoreId: e.restoreId,
  tenantId: e.tenantId,
  issuer: e.issuer,
  backupReceiptSha256: e.backupReceiptSha256,
  supplementFileSha256: e.supplementFileSha256,
  coreTargetId: e.coreTargetId,
  piiTargetId: e.piiTargetId,
  maxSnapshotAgeMs: e.maxSnapshotAgeMs,
});
const rowOf = (e: unknown) => ({
  status: 'active',
  evidence_json: canonicalRestoreJson(e),
  evidence_sha256: restoreEvidenceDigest(e),
});

async function run(rows: object[], evidence: Record<string, unknown> = base as never) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('pg_stat_ssl') ? [{ ssl: true }] : rows,
    rowCount: rows.length,
  }));
  const end = vi.fn(async () => {});
  const sql = { connect: async () => {}, query, end } as MaintenanceSqlClient;
  const result = await readCommittedMaintenanceActivation({
    connectionString: 'private',
    expected: expectedOf(evidence) as never,
    clientFactory: () => sql,
  });
  return result;
}
const reject = (rows: object[], evidence: Record<string, unknown> = base as never) =>
  expect(run(rows, evidence)).rejects.toThrow(/^aws_maintenance_restore_not_verifiable$/);

describe('readCommittedMaintenanceActivation row validation', () => {
  it('rejects more than one row even when the first one is valid', async () => {
    await reject([rowOf(base), rowOf(base)]);
  });
  it('rejects a missing evidence json or digest', async () => {
    await reject([{ ...rowOf(base), evidence_json: null }]);
    await reject([{ ...rowOf(base), evidence_json: '' }]);
    await reject([{ ...rowOf(base), evidence_sha256: null }]);
    await reject([{ ...rowOf(base), evidence_sha256: '' }]);
  });
  it('rejects an oversized evidence json', async () => {
    await reject([
      { ...rowOf(base), evidence_json: ' '.repeat(16_385) + canonicalRestoreJson(base) },
    ]);
  });
  it('rejects a missing or extra evidence key even when canonical and digest-consistent', async () => {
    const { snapshotId: _omitted, ...missing } = base;
    await reject([rowOf(missing)], missing);
    const extra = { ...base, extraKey: 'x' };
    await reject([rowOf(extra)], extra);
  });
  it('rejects an unsupported format version', async () => {
    const changed = { ...base, formatVersion: 2 };
    await reject([rowOf(changed)], changed);
  });
  it('rejects a json that is canonical-equal in content but differently ordered', async () => {
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(base).reverse()));
    await reject([{ ...rowOf(base), evidence_json: reordered }]);
  });
  it('rejects a stored digest that does not match', async () => {
    await reject([{ ...rowOf(base), evidence_sha256: 'b'.repeat(64) }]);
  });
  it('rejects a null json document', async () => {
    await reject([{ ...rowOf(base), evidence_json: 'null' }]);
  });
  it('returns the evidence when every key is valid at its boundary', async () => {
    const edge = {
      ...base,
      snapshotId: 's'.repeat(2048),
      activatedAtMs: 1,
      boundaryUnixMs: Number.MAX_SAFE_INTEGER,
    };
    expect(await run([rowOf(edge)], edge)).toEqual(edge);
  });
});

describe('readCommittedMaintenanceActivation value validation', () => {
  const nonSha = ['bundleId', 'snapshotId', 'restoreId', 'issuer', 'tenantId'] as const;
  it.each(nonSha)('rejects an empty or overlong %s', async (key) => {
    const empty = { ...base, [key]: '' };
    await reject([rowOf(empty)], empty);
    const long = { ...base, [key]: 'x'.repeat(2049) };
    await reject([rowOf(long)], long);
  });
  it.each(['bundleId', 'snapshotId'] as const)('rejects a non-scalar %s', async (key) => {
    for (const bad of [true, null, { a: 1 }, ['x']]) {
      const changed = { ...base, [key]: bad };
      await reject([rowOf(changed)], changed);
    }
  });
  it.each(['activatedAtMs', 'boundaryUnixMs', 'maxSnapshotAgeMs'] as const)(
    'rejects an out-of-range %s',
    async (key) => {
      for (const bad of [0, -1, 1.5, 2 ** 60]) {
        const changed = { ...base, [key]: bad };
        await reject([rowOf(changed)], changed);
      }
    }
  );
  it.each([
    'inventoryDigestSha256',
    'backupReceiptSha256',
    'supplementFileSha256',
    'coreReceiptSha256',
    'piiReceiptSha256',
    'stateReceiptSha256',
    'configurationSha256',
  ] as const)('requires %s to be an anchored lowercase sha256', async (key) => {
    for (const bad of [
      'z'.repeat(64),
      `g${hex}`,
      `${hex}g`,
      `${hex}a`,
      'A'.repeat(64),
      'a'.repeat(63),
    ]) {
      const changed = { ...base, [key]: bad };
      await reject([rowOf(changed)], changed);
    }
  });
});
