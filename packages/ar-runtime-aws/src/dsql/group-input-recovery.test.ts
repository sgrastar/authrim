import {
  icebergSnapshotCoreFixture,
  logProducerFixture,
} from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { SavedGroupInputReader } from '@authrim/ar-lib-core/services/dynamic-groups/inputs';
import { withGroupInputWrite } from '@authrim/ar-lib-core/services/dynamic-groups/write-boundary';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('group input recovery audit publication', () => {
  let core: ReturnType<typeof icebergSnapshotCoreFixture>;
  let pii: ReturnType<typeof icebergSnapshotCoreFixture>;
  let logs: Awaited<ReturnType<typeof logProducerFixture>>;
  let reader: SavedGroupInputReader;

  beforeEach(async () => {
    core = icebergSnapshotCoreFixture();
    pii = icebergSnapshotCoreFixture();
    logs = await logProducerFixture('scheduled', { separateAdmin: true });
    reader = new SavedGroupInputReader(
      core.adapter,
      core.adapter,
      pii.adapter,
      'tenant-a',
      'user-a',
      undefined,
      logs.env
    );
    await expect(
      withGroupInputWrite(core.adapter, 'tenant-a', 'user-a', 'profile', async () => {
        await withGroupInputWrite(pii.adapter, 'tenant-a', 'user-a', 'profile', async () => {
          throw new Error('synthetic cross-database failure');
        });
      })
    ).rejects.toThrow('synthetic cross-database failure');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logs?.close();
    core?.db.close();
    pii?.db.close();
  });

  it('publishes the scoped recovery evidence before releasing both database fences', async () => {
    const ids = (await reader.unsettledWrites()).map((row) => row.id);
    expect(ids).toHaveLength(2);
    await expect(reader.version()).rejects.toThrow('group_input_write_unsettled');
    await reader.acceptFailedWrites(ids, 'operator-a');
    const rows = await logs.rows('core.service_group_audit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      event_type: 'input_recovery',
      rule_version: 0,
      generation: 0,
    });
    expect(JSON.parse(String(rows[0].detail_json))).toEqual({
      actorId: 'operator-a',
      acceptedBoundaryIds: ids,
    });
    expect(await logs.rows('core.service_group_audit', 'tenant-b')).toEqual([]);
    expect(await reader.unsettledWrites()).toEqual([]);
    expect(await reader.version()).toMatchObject({ core: 2, pii: 2, metadata: 2 });
    for (const db of [core.db, pii.db])
      expect(db.prepare('SELECT * FROM service_group_audit').all()).toEqual([]);
  });

  it('retains both database fences when durable audit publication fails', async () => {
    const before = await reader.unsettledWrites();
    const writer = logs.env.LOG_ARCHIVE_WRITER;
    if (!writer) throw new Error('test_log_writer_missing');
    vi.spyOn(writer, 'writeRecords').mockRejectedValueOnce(
      new Error('synthetic audit storage failure')
    );
    await expect(
      reader.acceptFailedWrites(
        before.map((row) => row.id),
        'operator-a'
      )
    ).rejects.toThrow('synthetic audit storage failure');
    expect(await reader.unsettledWrites()).toEqual(before);
    await expect(reader.version()).rejects.toThrow('group_input_write_unsettled');
    expect(await logs.rows('core.service_group_audit')).toEqual([]);
  });

  it.each([
    ['tenant-b', 'user-a'],
    ['tenant-a', 'user-b'],
  ])(
    'rejects failed boundaries owned by %s/%s without publishing recovery',
    async (tenant, user) => {
      await expect(
        withGroupInputWrite(core.adapter, tenant, user, 'profile', async () => {
          throw new Error('synthetic other subject failure');
        })
      ).rejects.toThrow('synthetic other subject failure');
      const other = core.db
        .prepare('SELECT id FROM service_group_write_boundaries WHERE tenant_id=? AND user_id=?')
        .get(tenant, user);
      if (typeof other?.id !== 'string') throw new Error('test_failed_boundary_missing');
      const before = await reader.unsettledWrites();
      await expect(reader.acceptFailedWrites([other.id], 'operator-a')).rejects.toThrow(
        'group_recovery_conflict'
      );
      expect(
        core.db
          .prepare('SELECT id FROM service_group_write_boundaries WHERE tenant_id=? AND user_id=?')
          .get(tenant, user)
      ).toEqual(other);
      expect(await reader.unsettledWrites()).toEqual(before);
      await expect(reader.version()).rejects.toThrow('group_input_write_unsettled');
      expect(await logs.rows('core.service_group_audit')).toEqual([]);
    }
  );
});
