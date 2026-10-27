import { describe, expect, it, vi } from 'vitest';
import type { AwsRestoreActivationEvidence } from '../import/restore-coordinator';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import { readCommittedMaintenanceActivation } from './inspect-restore';
import type { MaintenanceSqlClient } from './database';
import { parseMaintenanceAction } from './db-bootstrap-handler';

const digest = 'a'.repeat(64);
const receipt: AwsRestoreActivationEvidence = {
  formatVersion: 1,
  restoreId: '11111111-1111-4111-8111-111111111111',
  coreTargetId: '22222222-2222-4222-8222-222222222222',
  piiTargetId: '33333333-3333-4333-8333-333333333333',
  tenantId: 'tenant-a',
  issuer: 'https://id.example.test',
  bundleId: 'a'.repeat(32),
  snapshotId: 'snapshot-1',
  inventoryDigestSha256: digest,
  backupReceiptSha256: digest,
  supplementFileSha256: digest,
  coreReceiptSha256: digest,
  piiReceiptSha256: digest,
  stateReceiptSha256: digest,
  configurationSha256: digest,
  boundaryUnixMs: 1_000,
  activatedAtMs: 2_000,
  maxSnapshotAgeMs: 3_600_000,
};
const expected = {
  restoreId: receipt.restoreId,
  tenantId: receipt.tenantId,
  issuer: receipt.issuer,
  backupReceiptSha256: receipt.backupReceiptSha256,
  supplementFileSha256: receipt.supplementFileSha256,
  coreTargetId: receipt.coreTargetId,
  piiTargetId: receipt.piiTargetId,
  maxSnapshotAgeMs: receipt.maxSnapshotAgeMs,
};
function client(row: object | undefined, ssl = true) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('pg_stat_ssl') ? [{ ssl }] : row ? [row] : [],
    rowCount: row ? 1 : 0,
  }));
  const end = vi.fn(async () => {});
  return { sql: { connect: async () => {}, query, end } as MaintenanceSqlClient, query, end };
}
const active = () => ({
  status: 'active',
  evidence_json: canonicalRestoreJson(receipt),
  evidence_sha256: restoreEvidenceDigest(receipt),
});

describe('maintenance restore inspection', () => {
  it('accepts only an action, never caller-supplied destinations or receipts', () => {
    expect(parseMaintenanceAction({ action: 'inspect-restore' })).toEqual({
      action: 'inspect-restore',
    });
    expect(() =>
      parseMaintenanceAction({ action: 'inspect-restore', evidence: receipt })
    ).toThrow();
    expect(() =>
      parseMaintenanceAction({ action: 'inspect-restore', restoreId: receipt.restoreId })
    ).toThrow();
  });
  it('reads the exact configured active marker without importing or writing rows', async () => {
    const db = client(active());
    expect(
      await readCommittedMaintenanceActivation({
        connectionString: 'private',
        expected,
        clientFactory: () => db.sql,
      })
    ).toEqual(receipt);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(db.query.mock.calls[1]).toEqual([
      expect.stringContaining('WHERE tenant_id = $1 AND restore_id = $2'),
      [receipt.tenantId, receipt.restoreId],
    ]);
    expect(db.end).toHaveBeenCalledOnce();
  });
  it.each([
    ['missing', undefined],
    ['staging', { ...active(), status: 'staging' }],
    ['failed', { ...active(), status: 'failed' }],
    ['digest changed', { ...active(), evidence_sha256: 'b'.repeat(64) }],
    ['noncanonical', { ...active(), evidence_json: `${canonicalRestoreJson(receipt)}\n` }],
    ['malformed', { ...active(), evidence_json: '{secret=never-log}' }],
  ])('blocks %s without replaying the restore', async (_name, row) => {
    const db = client(row);
    await expect(
      readCommittedMaintenanceActivation({
        connectionString: 'postgresql://private-password',
        expected,
        clientFactory: () => db.sql,
      })
    ).rejects.toThrow(/^aws_maintenance_restore_not_verifiable$/);
    expect(db.query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(db.end).toHaveBeenCalledOnce();
  });
  it.each(Object.keys(expected) as (keyof typeof expected)[])(
    'rejects a different configured %s even with a self-consistent stored digest',
    async (key) => {
      const changed = {
        ...receipt,
        [key]: typeof receipt[key] === 'number' ? 42 : `${receipt[key]}-other`,
      };
      const db = client({
        status: 'active',
        evidence_json: canonicalRestoreJson(changed),
        evidence_sha256: restoreEvidenceDigest(changed),
      });
      await expect(
        readCommittedMaintenanceActivation({
          connectionString: 'private',
          expected,
          clientFactory: () => db.sql,
        })
      ).rejects.toThrow('aws_maintenance_restore_not_verifiable');
    }
  );
  it('requires verified TLS before reading the activation', async () => {
    const db = client(active(), false);
    await expect(
      readCommittedMaintenanceActivation({
        connectionString: 'private',
        expected,
        clientFactory: () => db.sql,
      })
    ).rejects.toThrow('aws_maintenance_restore_not_verifiable');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
