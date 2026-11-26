import { stringifyIcebergJson } from 'icebird/src/json.js';
import {
  createSnapshotDeleteIntent,
  prepareSnapshotRowDelete,
  type SnapshotDeleteIntent,
  type SnapshotDeleteMutation,
} from '../position-delete.js';
import { planSnapshotRowDeletePage, type SnapshotRowDeletePage } from '../reader.js';
import { NOW_MS, readerFixture } from './reader-mutation-harness.js';
import { record } from './fixtures.js';
import { sha256Hex } from './digest-helpers.js';

export const OPERATION_ID = 'a'.repeat(64);

export const sha256 = sha256Hex;

/** A table holding two expired rows and one live row, and the plan that deletes the expired ones. */
export async function deleteFixture(options: { pipeline?: boolean } = {}) {
  const f = readerFixture({ pipeline: options.pipeline });
  await f.append('rows', [
    record({ event_id: 'gone-1', expires_at: 0 }),
    record({ event_id: 'keep', expires_at: null }),
    record({ event_id: 'gone-2', expires_at: NOW_MS - 1 }),
  ]);
  const plan = async (): Promise<SnapshotRowDeletePage> =>
    planSnapshotRowDeletePage(await f.scope(), 'expired');
  const intent = async (
    change: (plan: SnapshotRowDeletePage) => SnapshotRowDeletePage = (page) => page,
    operationId = OPERATION_ID,
    now?: number
  ): Promise<SnapshotDeleteIntent> =>
    createSnapshotDeleteIntent(change(structuredClone(await plan())), operationId, now);
  const prepare = async (intentValue: SnapshotDeleteIntent): Promise<SnapshotDeleteMutation> =>
    prepareSnapshotRowDelete({
      table: await f.catalog.loadTable(),
      store: f.store,
      intent: intentValue,
    });
  return { ...f, plan, intent, prepare };
}

/** The plan digest, as an independent computation. */
export async function planDigest(plan: SnapshotRowDeletePage): Promise<string> {
  return sha256(
    stringifyIcebergJson({
      tableUuid: plan.tableUuid,
      snapshotId: plan.snapshotId,
      sequenceNumber: plan.sequenceNumber,
      physicalFingerprint: plan.physicalFingerprint,
      deletes: plan.deletes,
    })
  );
}
