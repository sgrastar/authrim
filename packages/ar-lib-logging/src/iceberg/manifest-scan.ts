import { manifestMightMatch } from 'icebird/src/prune.js';
import type { fetchManifestEntries } from 'icebird/src/manifest.js';
import type { IcebergTableMetadata } from './types.js';
import { IcebergBudgetError } from './types.js';
import type { ArchiveParquetFilter, safeReadResolver } from './read-buffer.js';

type Manifest = Parameters<typeof fetchManifestEntries>[0];
export type ArchiveManifestEntry = Awaited<ReturnType<typeof fetchManifestEntries>>[number];
export interface ManifestScanPosition {
  manifest: number;
  entry: number;
  row: number;
}

/** Manifest-list rows and manifest entries are decoded in 32-record batches.
 * Only one candidate data file and applicable delete-file descriptors survive
 * each batch. DAY summaries are tested before opening a manifest. */
export async function findSnapshotFile(options: {
  metadata: IcebergTableMetadata;
  snapshotId: string;
  resolver: ReturnType<typeof safeReadResolver>;
  position: ManifestScanPosition;
  filter?: ArchiveParquetFilter;
  mayMatch: (entry: ArchiveManifestEntry) => boolean;
}): Promise<{
  data?: { entry: ArchiveManifestEntry; position: ManifestScanPosition };
  deletes: ArchiveManifestEntry[];
  continuation?: ManifestScanPosition;
}> {
  const snapshot = options.metadata.snapshots?.find(
    (item) => String(item['snapshot-id']) === options.snapshotId
  );
  if (!snapshot?.['manifest-list']) throw new Error('Archive snapshot requires a v2 manifest list');
  const schema = options.metadata.schemas.find(
    (item) => item['schema-id'] === (snapshot['schema-id'] ?? options.metadata['current-schema-id'])
  );
  if (!schema) throw new Error('Archive snapshot schema unavailable');
  let manifestIndex = -1;
  let result: { entry: ArchiveManifestEntry; position: ManifestScanPosition } | undefined;
  const deletes: ArchiveManifestEntry[] = [];
  let examined = 0;
  let continuation: ManifestScanPosition | undefined;
  for await (const listBatch of options.resolver.avroBatches(snapshot['manifest-list'])) {
    for (const raw of listBatch.records) {
      options.resolver.check();
      manifestIndex++;
      const manifest = raw as Manifest;
      if (
        !manifest ||
        typeof manifest.manifest_path !== 'string' ||
        ![0, 1].includes(manifest.content)
      )
        throw new Error('Invalid archive manifest list record');
      if (options.filter && !manifestMightMatch(options.filter, manifest, schema, options.metadata))
        continue;
      if (
        manifest.content === 0 &&
        (result || continuation || manifestIndex < options.position.manifest)
      )
        continue;
      if (manifest.content === 0 && ++examined > 24) {
        continuation = { manifest: manifestIndex, entry: 0, row: 0 };
        continue;
      }
      let entryIndex = -1;
      for await (const batch of options.resolver.avroBatches(manifest.manifest_path)) {
        let retained = false;
        for (const value of batch.records) {
          entryIndex++;
          const entry = value as ArchiveManifestEntry;
          if (!entry || ![0, 1, 2].includes(entry.status) || !entry.data_file)
            throw new Error('Invalid archive manifest entry');
          entry.partition_spec_id = manifest.partition_spec_id ?? 0;
          if (entry.snapshot_id == null) entry.snapshot_id = manifest.added_snapshot_id;
          if (entry.status === 1) {
            entry.sequence_number ??= manifest.sequence_number ?? 0n;
            entry.file_sequence_number ??= manifest.sequence_number ?? 0n;
          } else if (
            entry.sequence_number === undefined ||
            entry.file_sequence_number === undefined
          )
            throw new Error('Archive manifest entry missing sequence numbers');
          if (entry.status === 2) continue;
          if (entry.data_file.file_format.toLowerCase() !== 'parquet')
            throw new Error('Unsupported archive data format');
          if (manifest.content === 1) {
            if (![1, 2].includes(entry.data_file.content))
              throw new Error('Unsupported archive delete format');
            if (deletes.length === 128)
              throw new IcebergBudgetError('Archive delete-file budget exceeded');
            deletes.push(entry);
            retained = true;
          } else {
            if (entry.data_file.content !== 0) throw new Error('Invalid data manifest content');
            if (
              result ||
              (manifestIndex === options.position.manifest &&
                entryIndex < options.position.entry) ||
              !options.mayMatch(entry)
            )
              continue;
            result = {
              entry,
              position: {
                manifest: manifestIndex,
                entry: entryIndex,
                row:
                  manifestIndex === options.position.manifest &&
                  entryIndex === options.position.entry
                    ? options.position.row
                    : 0,
              },
            };
            retained = true;
          }
        }
        // A retained descriptor can reference any value of its batch. Charge
        // the entire batch rather than an average record-size estimate.
        if (retained) options.resolver.reserveMetadata(batch.metrics.estimatedDecodedBytes);
      }
    }
  }
  return { data: result, deletes, continuation };
}
