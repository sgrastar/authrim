import { ScheduledIcebergWriter } from '../writer.js';
import {
  readSnapshotPage,
  readSnapshotRecords,
  type SnapshotPageOptions,
  type SnapshotReadOptions,
} from '../reader.js';
import {
  LOCATION,
  MemoryCatalog,
  MemoryJournal,
  MemoryStore,
  pipelineMetadata,
} from './fixtures.js';

export const NOW_MS = 1793000005000;

/** A table, a store and a writer, with helpers to append batches and read with chosen scopes. */
export function readerFixture(options: { pipeline?: boolean } = {}) {
  const catalog = new MemoryCatalog();
  if (options.pipeline) catalog.metadata = pipelineMetadata(true);
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: LOCATION,
  });
  const append = (batchId: string, records: Parameters<typeof writer.appendBatch>[0]['records']) =>
    writer.appendBatch({ batchId, fence: journal.activeFence, records });
  const scope = async (extra: Partial<SnapshotPageOptions> = {}): Promise<SnapshotPageOptions> => ({
    table: await catalog.loadTable(),
    store,
    tenantKey: 'tenant-test',
    sourceDatasets: ['core.event_log'],
    nowMs: NOW_MS,
    ...extra,
  });
  return {
    catalog,
    store,
    journal,
    writer,
    append,
    scope,
    read: async (extra: Partial<SnapshotReadOptions> = {}) =>
      readSnapshotRecords(await scope(extra)),
    page: async (extra: Partial<SnapshotPageOptions> = {}) => readSnapshotPage(await scope(extra)),
  };
}
