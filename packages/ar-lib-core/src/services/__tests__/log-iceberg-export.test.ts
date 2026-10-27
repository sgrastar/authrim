import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IcebergCommitUnknownError, readSnapshotRecords } from '@authrim/ar-lib-logging/iceberg';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { icebergFixture } from './log-iceberg-test-fixture';

describe('scheduled source deletion after verified Iceberg commit (real SQL/Parquet)', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  beforeEach(async () => {
    f = await icebergFixture();
  });
  afterEach(() => f.db.close());
  const remaining = () =>
    Number(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n);
  const retry = () => f.db.exec('UPDATE log_iceberg_export_batches SET next_attempt_at=0');
  it('archives only the selected tenant/dataset and preserves recent source rows', async () => {
    const a = await f.record();
    await f.staging.put('tenant-a', a);
    await f.staging.put('tenant-a', await f.record('recent', { ingestedAt: f.now }));
    await f.staging.put(
      'tenant-b',
      await f.record('other', { tenantId: 'tenant-b', tenantKey: 'key-b' })
    );
    const result = await exportLogIcebergBatch(f.config, f.ports);
    expect(result.moved).toBe(1);
    expect(remaining()).toBe(2);
    const read = await readSnapshotRecords({
      table: await f.catalog.loadTable(),
      store: f.store,
      tenantKey: 'key-a',
      sourceDatasets: ['core.audit_log'],
      nowMs: f.now,
    });
    expect(read.records).toEqual([a]);
    const watermark = f.db.prepare('SELECT * FROM log_iceberg_read_watermarks').get();
    expect(watermark?.snapshot_id).toBe(read.snapshotId);
    expect(watermark?.minimum_sequence_number).toBe(read.sequenceNumber);
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) AS n FROM log_iceberg_record_parts WHERE record_id NOT IN(SELECT id FROM log_iceberg_records)'
        )
        .get()?.n
    ).toBe(0);
    expect(
      Object.keys(f.catalog.metadata.refs ?? {}).filter((key) => key.startsWith('authrim-pending-'))
    ).toEqual([]);
  });
  it('never executes any database selection or R2 operation for pipeline mode', async () => {
    await expect(
      exportLogIcebergBatch(
        { ...f.config, mode: 'pipeline', dbRetentionDays: null, exportIntervalMinutes: null },
        f.ports
      )
    ).rejects.toThrow('log_iceberg_scheduled_mode_required');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM scheduled_task_leases').get()?.n).toBe(0);
    expect(f.store.objects.size).toBe(0);
  });
  it('retains the source and immutable checkpoint after an object write fails, then resumes the same batch', async () => {
    await f.staging.put('tenant-a', await f.record());
    f.store.failManifestOnce = true;
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow();
    expect(remaining()).toBe(1);
    const before = f.db.prepare('SELECT id,checkpoint_json FROM log_iceberg_export_batches').get();
    expect(before?.checkpoint_json).not.toBeNull();
    retry();
    expect(await exportLogIcebergBatch(f.config, f.ports)).toMatchObject({
      moved: 1,
      batchId: before?.id,
    });
    const after = f.db.prepare('SELECT checkpoint_json FROM log_iceberg_export_batches').get();
    const beforeCheckpoint: unknown = JSON.parse(String(before?.checkpoint_json));
    const afterCheckpoint: unknown = JSON.parse(String(after?.checkpoint_json));
    if (
      !beforeCheckpoint ||
      typeof beforeCheckpoint !== 'object' ||
      !('snapshotId' in beforeCheckpoint) ||
      !afterCheckpoint ||
      typeof afterCheckpoint !== 'object' ||
      !('snapshotId' in afterCheckpoint)
    )
      throw new Error('Invalid checkpoint fixture');
    expect(afterCheckpoint.snapshotId).toBe(beforeCheckpoint.snapshotId);
    expect(remaining()).toBe(0);
  });
  it('reconciles a lost Catalog acknowledgement before deleting any source', async () => {
    await f.staging.put('tenant-a', await f.record());
    let first = true;
    f.catalog.afterCommit = async () => {
      if (first) {
        first = false;
        throw new IcebergCommitUnknownError('lost reply');
      }
    };
    expect((await exportLogIcebergBatch(f.config, f.ports)).moved).toBe(1);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
    expect(remaining()).toBe(0);
  });
  it('rolls back the watermark and source deletion together when DELETE fails, then reuses the existing snapshot', async () => {
    await f.staging.put('tenant-a', await f.record());
    f.db.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON log_iceberg_records BEGIN SELECT RAISE(ABORT,'delete failed'); END"
    );
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow('delete failed');
    expect(remaining()).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_read_watermarks').get()?.n).toBe(0);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_delete');
    retry();
    expect((await exportLogIcebergBatch(f.config, f.ports)).moved).toBe(1);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
    expect(remaining()).toBe(0);
  });
  it('does not delete a source whose content digest changes after selection', async () => {
    await f.staging.put('tenant-a', await f.record());
    let changed = false;
    f.catalog.afterCommit = async () => {
      if (!changed) {
        changed = true;
        f.db.prepare('UPDATE log_iceberg_records SET payload_hmac=?').run('f'.repeat(64));
      }
    };
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow();
    expect(remaining()).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_read_watermarks').get()?.n).toBe(0);
  });
  it('rejects a stale worker even if its in-flight Catalog commit succeeds', async () => {
    await f.staging.put('tenant-a', await f.record());
    let changed = false;
    f.catalog.beforeCommit = async () => {
      if (!changed) {
        changed = true;
        f.db.exec("UPDATE scheduled_task_leases SET lease_token='new-owner'");
      }
    };
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow(
      'log_iceberg_stale_fence'
    );
    expect(remaining()).toBe(1);
    expect(f.db.prepare('SELECT lease_token FROM scheduled_task_leases').get()?.lease_token).toBe(
      'new-owner'
    );
    f.db.exec('UPDATE scheduled_task_leases SET lease_until=0');
    retry();
    expect((await exportLogIcebergBatch(f.config, f.ports)).moved).toBe(1);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
  });
  function rollBackMain(snapshotId: string | number) {
    f.catalog.metadata['current-snapshot-id'] = snapshotId;
    if (!f.catalog.metadata.refs?.main) throw new Error('Missing fixture main');
    f.catalog.metadata.refs.main['snapshot-id'] = snapshotId;
  }
  for (const state of ['committed', 'verified', 'done'] as const) {
    it(`retains recoverable evidence if main rolls back after the batch is ${state}`, async () => {
      await f.staging.put('tenant-a', await f.record('first'));
      await exportLogIcebergBatch(f.config, f.ports);
      const previous = f.db.prepare('SELECT * FROM log_iceberg_read_watermarks').get();
      const oldSnapshot = f.catalog.metadata['current-snapshot-id'];
      if (oldSnapshot === undefined) throw new Error('Missing fixture snapshot');
      const load = f.catalog.loadTable.bind(f.catalog);
      let rolledBack = false;
      f.catalog.loadTable = async () => {
        const ready =
          state === 'done'
            ? Number(
                f.db
                  .prepare("SELECT COUNT(*) n FROM log_iceberg_export_batches WHERE state='done'")
                  .get()?.n
              ) >= 2
            : Boolean(
                f.db.prepare('SELECT 1 FROM log_iceberg_export_batches WHERE state=?').get(state)
              );
        if (!rolledBack && ready) {
          rolledBack = true;
          rollBackMain(oldSnapshot);
        }
        return load();
      };
      await f.staging.put('tenant-a', await f.record('second'));
      await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow(
        'outside current history'
      );
      expect(rolledBack).toBe(true);
      expect(remaining()).toBe(state === 'done' ? 0 : 1);
      const watermark = f.db.prepare('SELECT * FROM log_iceberg_read_watermarks').get();
      if (state === 'done') {
        expect(watermark?.snapshot_id).not.toBe(previous?.snapshot_id);
        expect(Number(watermark?.minimum_sequence_number)).toBeGreaterThan(
          Number(previous?.minimum_sequence_number)
        );
      } else expect(watermark).toEqual(previous);
      expect(
        Object.keys(f.catalog.metadata.refs ?? {}).some((key) => key.startsWith('authrim-pending-'))
      ).toBe(true);
    });
  }
  it('preserves the recovery pin when main rolls back between pin-release load and commit', async () => {
    await f.staging.put('tenant-a', await f.record('first'));
    await exportLogIcebergBatch(f.config, f.ports);
    const oldSnapshot = f.catalog.metadata['current-snapshot-id'];
    if (oldSnapshot === undefined) throw new Error('Missing fixture snapshot');
    let rolledBack = false;
    f.catalog.beforeCommit = async () => {
      if (
        !rolledBack &&
        Number(
          f.db.prepare("SELECT COUNT(*) n FROM log_iceberg_export_batches WHERE state='done'").get()
            ?.n
        ) === 2
      ) {
        rolledBack = true;
        rollBackMain(oldSnapshot);
      }
    };
    await f.staging.put('tenant-a', await f.record('second'));
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow('CAS conflict');
    expect(rolledBack).toBe(true);
    expect(remaining()).toBe(0);
    expect(
      Object.keys(f.catalog.metadata.refs ?? {}).some((key) => key.startsWith('authrim-pending-'))
    ).toBe(true);
    expect(
      f.db.prepare('SELECT snapshot_id FROM log_iceberg_read_watermarks').get()?.snapshot_id
    ).not.toBe(String(oldSnapshot));
  });
  it('rejects a new append on a fork that would forget the previous durable watermark', async () => {
    await f.staging.put('tenant-a', await f.record('first'));
    await exportLogIcebergBatch(f.config, f.ports);
    const oldSnapshot = f.catalog.metadata['current-snapshot-id'];
    if (oldSnapshot === undefined) throw new Error('Missing fixture snapshot');
    await f.staging.put('tenant-a', await f.record('second'));
    await exportLogIcebergBatch(f.config, f.ports);
    const previous = f.db.prepare('SELECT * FROM log_iceberg_read_watermarks').get();
    const commitCount = f.catalog.commitCount;
    rollBackMain(oldSnapshot);
    await f.staging.put('tenant-a', await f.record('third'));
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow(
      'outside current history'
    );
    expect(remaining()).toBe(1);
    expect(f.catalog.commitCount).toBe(commitCount);
    expect(f.db.prepare('SELECT * FROM log_iceberg_read_watermarks').get()).toEqual(previous);
  });
  it('lets only one simultaneous exporter claim a table', async () => {
    await f.staging.put('tenant-a', await f.record());
    let signal: () => void = () => {},
      release: () => void = () => {};
    const entered = new Promise<void>((resolve) => (signal = resolve)),
      held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    f.catalog.beforeCommit = async () => {
      if (first) {
        first = false;
        signal();
        await held;
      }
    };
    const active = exportLogIcebergBatch(f.config, f.ports);
    await entered;
    expect(await exportLogIcebergBatch(f.config, f.ports)).toEqual({ leased: false, moved: 0 });
    release();
    expect((await active).moved).toBe(1);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
  });
});
