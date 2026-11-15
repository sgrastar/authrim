import type { AuthrimLock } from './lock.js';
import type {
  ReleaseMigrationManifest,
  ReleaseMigrationPhysicalTarget,
} from './release-migrations.js';
import { isControlGeneratedDatabaseBinding } from './tenant-database.js';

/**
 * Control creates tenant and lookup shards at runtime and applies their migration stream itself.
 * Setup learns their bindings later, when it refreshes the lock from Control, after the release
 * schema plan has already recorded `schemaTargets`. Such a database therefore has a lock binding
 * but no schema evidence (no entry, or an entry with an empty file list), and every later
 * same-version draft append is refused. Its own migration history is the evidence: adopt it only
 * when that history is exactly a leading run of the stream, file by file and checksum by checksum.
 */
export interface MigrationHistoryRow {
  filename: string;
  checksum: string | null;
}

export type ControlGeneratedAdoptionSkip =
  | 'not_control_generated'
  | 'stream_unknown'
  | 'history_unreadable'
  | 'history_empty'
  | 'history_not_stream_prefix'
  | 'reference_checksum_unavailable';

export interface ControlGeneratedSchemaAdoption {
  lock: AuthrimLock;
  adopted: Array<{ targetId: string; binding: string; fileCount: number }>;
  skipped: Array<{ targetId: string; reason: ControlGeneratedAdoptionSkip }>;
}

type Target = Pick<
  ReleaseMigrationPhysicalTarget,
  'id' | 'streamId' | 'driver' | 'binding' | 'databaseName'
>;

/** Pure decision for one database: the adopted file list, or why it cannot be adopted. */
export function controlGeneratedHistoryPrefix(
  streamFiles: ReadonlyArray<{ path: string; checksum: string }>,
  history: ReadonlyArray<MigrationHistoryRow>
): Array<{ path: string; checksum: string }> | 'history_empty' | 'history_not_stream_prefix' {
  if (history.length === 0) return 'history_empty';
  const byFilename = new Map<string, string | null>();
  for (const row of history) {
    if (byFilename.has(row.filename)) return 'history_not_stream_prefix';
    byFilename.set(row.filename, row.checksum);
  }
  if (history.length > streamFiles.length) return 'history_not_stream_prefix';
  const prefix = streamFiles.slice(0, history.length);
  for (const file of prefix) {
    if (byFilename.get(file.path) !== file.checksum) return 'history_not_stream_prefix';
  }
  return prefix.map((file) => ({ path: file.path, checksum: file.checksum }));
}

function isStreamPrefixEvidence(
  state: NonNullable<AuthrimLock['schemaTargets']>[string],
  streamId: string | null,
  manifest: ReleaseMigrationManifest
): boolean {
  const files = state.files ?? [];
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  if (files.length === 0 || !stream || files.length > stream.files.length) return false;
  return files.every(
    (file, index) =>
      file.path === stream.files[index]!.path && file.checksum === stream.files[index]!.checksum
  );
}

/** Checksums that valid evidence of the same stream and version was recorded against. */
function referenceManifestChecksums(
  lock: AuthrimLock,
  streamId: string,
  productVersion: string,
  manifest: ReleaseMigrationManifest
): string[] {
  const candidates = Object.values(lock.schemaTargets ?? {})
    .filter(
      (state) =>
        state.streamId === streamId &&
        state.productVersion === productVersion &&
        isStreamPrefixEvidence(state, streamId, manifest)
    )
    .map((state) => state.manifestChecksum)
    .sort();
  return [...new Set(candidates)];
}

export async function adoptControlGeneratedSchemaTargets(input: {
  lock: AuthrimLock;
  targets: readonly Target[];
  manifest: ReleaseMigrationManifest;
  /** Checksum of `manifest`. Only a history covering the whole stream may be recorded against it. */
  manifestChecksum: string;
  readHistory: (databaseName: string) => Promise<MigrationHistoryRow[]>;
  now?: () => Date;
}): Promise<ControlGeneratedSchemaAdoption> {
  const productVersion = input.lock.productVersion;
  const adopted: ControlGeneratedSchemaAdoption['adopted'] = [];
  const skipped: ControlGeneratedSchemaAdoption['skipped'] = [];
  const schemaTargets = { ...(input.lock.schemaTargets ?? {}) };
  if (!productVersion || productVersion !== input.manifest.productVersion) {
    return { lock: input.lock, adopted, skipped };
  }
  for (const target of input.targets) {
    const existing = schemaTargets[target.id];
    // Evidence counts only when it is a non-empty leading run of the stream. An empty list, or the
    // pending-only list a same-version append records for a database it had no evidence for,
    // proves nothing about the database, the same as no entry.
    if (existing && isStreamPrefixEvidence(existing, target.streamId, input.manifest)) continue;
    if (
      target.driver !== 'd1' ||
      !target.binding ||
      !target.databaseName ||
      !isControlGeneratedDatabaseBinding(target.binding)
    ) {
      skipped.push({ targetId: target.id, reason: 'not_control_generated' });
      continue;
    }
    const stream = target.streamId
      ? input.manifest.streams.find((candidate) => candidate.id === target.streamId)
      : undefined;
    if (!stream || !target.streamId) {
      skipped.push({ targetId: target.id, reason: 'stream_unknown' });
      continue;
    }
    let history: MigrationHistoryRow[];
    try {
      history = await input.readHistory(target.databaseName);
    } catch {
      skipped.push({ targetId: target.id, reason: 'history_unreadable' });
      continue;
    }
    const files = controlGeneratedHistoryPrefix(stream.files, history);
    if (typeof files === 'string') {
      skipped.push({ targetId: target.id, reason: files });
      continue;
    }
    // The current checksum claims the whole stream. A shorter run is recorded against an earlier
    // checksum so the append sees it as behind; without one, the database is left unrecorded.
    const manifestChecksum =
      files.length === stream.files.length
        ? input.manifestChecksum
        : [
            ...(existing?.productVersion === productVersion && existing.streamId === target.streamId
              ? [existing.manifestChecksum]
              : []),
            ...referenceManifestChecksums(
              input.lock,
              target.streamId,
              productVersion,
              input.manifest
            ),
          ].find((checksum) => checksum !== input.manifestChecksum);
    if (!manifestChecksum) {
      skipped.push({ targetId: target.id, reason: 'reference_checksum_unavailable' });
      continue;
    }
    schemaTargets[target.id] = {
      productVersion,
      manifestChecksum,
      streamId: target.streamId,
      files,
      appliedBy: 'automatic',
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    adopted.push({ targetId: target.id, binding: target.binding, fileCount: files.length });
  }
  if (adopted.length === 0) return { lock: input.lock, adopted, skipped };
  return { lock: { ...input.lock, schemaTargets }, adopted, skipped };
}
