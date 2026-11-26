import { writeParquet } from 'icebird/src/write/parquet.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import type { LogArchiveRecord } from '../schema.js';
import { inspectLogArchiveTable } from '../physical-schema.js';
import { safeReadResolver } from '../read-buffer.js';
import { MemoryStore, metadata, pipelineMetadata, record } from './fixtures.js';

export type OpenedFile = Awaited<ReturnType<ReturnType<typeof safeReadResolver>['openParquet']>>;

/** A Parquet file of archive records, opened through the bounded resolver. */
export async function openArchive(
  options: {
    rows?: number;
    pipeline?: boolean;
    make?: (index: number) => Partial<LogArchiveRecord>;
  } = {}
): Promise<{ file: OpenedFile; profile: ReturnType<typeof inspectLogArchiveTable> }> {
  const table = options.pipeline ? pipelineMetadata(true) : metadata();
  const rows = options.rows ?? 8;
  const records = Array.from({ length: rows }, (_, index) => ({
    ...record({
      event_id: `event-${index}`,
      tenant_key: index < rows / 2 ? 'tenant-a' : 'tenant-b',
      subject_id: index % 2 === 0 ? 'subject-even' : 'subject-odd',
      ...options.make?.(index),
    }),
    event_at: 1793000000000n + BigInt(index),
    ingested_at: 1793000001000n,
    expires_at: null,
    ...(options.pipeline ? { __ingest_ts: new Date(1793000001000) } : {}),
  }));
  const output = new ByteWriter();
  await writeParquet({ writer: output, schema: table.schemas[0], records, codec: 'SNAPPY' });
  const store = new MemoryStore();
  store.objects.set('events.parquet', {
    bytes: Uint8Array.from(output.getBytes()),
    identity: 'fixture',
  });
  const file = await safeReadResolver({
    store,
    maxFiles: 2,
    maxBytes: 8 * 1024 * 1024,
    maxFileBytes: 4 * 1024 * 1024,
    maxRows: 100_000,
    deadline: Date.now() + 60_000,
    filters: new Map(),
  }).openParquet('events.parquet');
  return { file, profile: inspectLogArchiveTable(table) };
}
