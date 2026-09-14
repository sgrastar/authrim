import { TenantBackupCipherJournal } from './cipher-journal';
import {
  TenantBundleContentEncoder,
  type TenantBundleEncoderCheckpoint,
  type TenantBundleEncoderCommand,
} from './bundle-encoder-state';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from './bundle-manifest';

interface Checkpoint {
  version: 1;
  content: TenantBundleEncoderCheckpoint;
  /** Trusted bounded source position only; no row data, credentials or uploaded executable input. */
  sourceCursor: string | null;
}
function fail(): never {
  throw new Error('backup_bundle_checkpoint_failed');
}
function checkpoint(raw: string | null): Checkpoint | undefined {
  if (raw === null) return undefined;
  let value: Checkpoint;
  try {
    value = JSON.parse(raw) as Checkpoint;
  } catch {
    fail();
  }
  if (
    !value ||
    value.version !== 1 ||
    !value.content ||
    !(value.sourceCursor === null || typeof value.sourceCursor === 'string')
  )
    fail();
  return value;
}

/** Connect one content transition, nonce reservation, ciphertext receipt and source checkpoint. */
export async function writeTenantBackupContentFrame(input: {
  journal: TenantBackupCipherJournal;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
  expectedSequence: number;
  command: TenantBundleEncoderCommand;
  nextSourceCursor: string | null;
}): Promise<void> {
  const saved = await input.journal.progress();
  if (
    saved.finished ||
    saved.next_sequence !== input.expectedSequence ||
    saved.header_hex.slice(2, 34) !== input.expected.bundleId ||
    !(input.nextSourceCursor === null || typeof input.nextSourceCursor === 'string')
  )
    fail();
  const previous = checkpoint(saved.checkpoint_json);
  if ((saved.next_sequence === 0) !== !previous) fail();
  const encoder = await TenantBundleContentEncoder.create(
    input.manifest,
    input.expected,
    previous?.content
  );
  const frame = await encoder.step(input.command);
  const next: Checkpoint = {
    version: 1,
    content: encoder.checkpoint(),
    sourceCursor: input.nextSourceCursor,
  };
  await input.journal.write(input.expectedSequence, frame, JSON.stringify(next));
}

/** Write only the initial manifest, or validate its persisted digest after a lost checkpoint. */
export async function initializeTenantBackupContent(input: {
  journal: TenantBackupCipherJournal;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
}): Promise<void> {
  const saved = await input.journal.progress();
  const previous = checkpoint(saved.checkpoint_json);
  if (
    (saved.next_sequence === 0) !== !previous ||
    saved.header_hex.slice(2, 34) !== input.expected.bundleId
  )
    fail();
  await TenantBundleContentEncoder.create(input.manifest, input.expected, previous?.content);
  if (saved.next_sequence === 0)
    await writeTenantBackupContentFrame({
      ...input,
      expectedSequence: 0,
      command: { kind: 'manifest' },
      nextSourceCursor: null,
    });
}

/** Content must be complete before the authenticated footer and sealed artifact become durable. */
export async function finishTenantBackupContent(input: {
  journal: TenantBackupCipherJournal;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
}): Promise<void> {
  const saved = await input.journal.progress();
  const previous = checkpoint(saved.checkpoint_json);
  if (
    !previous ||
    saved.checkpoint_json === null ||
    saved.header_hex.slice(2, 34) !== input.expected.bundleId
  )
    fail();
  const encoder = await TenantBundleContentEncoder.create(
    input.manifest,
    input.expected,
    previous.content
  );
  if (encoder.checkpoint().phase !== 'done') fail();
  await input.journal.finish(saved.next_sequence - (saved.finished ? 1 : 0), saved.checkpoint_json);
}

/** One bounded source chunk per durable slice; the journal is the authoritative retry cursor. */
export async function writeTenantBackupDatasetSlice(input: {
  journal: TenantBackupCipherJournal;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
  signal: AbortSignal;
  assertBoundary: () => Promise<void>;
  readNext: (
    datasetId: string,
    cursor: string | null,
    signal: AbortSignal
  ) => Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
}): Promise<{ complete: boolean }> {
  input.signal.throwIfAborted();
  await input.assertBoundary();
  const saved = await input.journal.progress();
  const previous = checkpoint(saved.checkpoint_json);
  if (
    (saved.next_sequence === 0) !== !previous ||
    saved.header_hex.slice(2, 34) !== input.expected.bundleId
  )
    fail();
  const encoder = await TenantBundleContentEncoder.create(
    input.manifest,
    input.expected,
    previous?.content
  );
  const state = encoder.checkpoint();
  if (state.phase === 'done') {
    await finishTenantBackupContent(input);
    input.signal.throwIfAborted();
    await input.assertBoundary();
    return { complete: true };
  }
  let command: TenantBundleEncoderCommand;
  let nextSourceCursor: string | null = null;
  if (state.phase === 'manifest') command = { kind: 'manifest' };
  else {
    const descriptor = input.expected.datasets[state.datasetIndex];
    if (!descriptor) fail();
    const chunk =
      descriptor.disposition === 'include'
        ? await input.readNext(descriptor.id, previous?.sourceCursor ?? null, input.signal)
        : null;
    if (chunk) {
      if (
        typeof chunk.nextCursor !== 'string' ||
        chunk.nextCursor === (previous?.sourceCursor ?? null)
      )
        fail();
      command = { kind: 'chunk', datasetId: descriptor.id, bytes: chunk.bytes };
      nextSourceCursor = chunk.nextCursor;
    } else command = { kind: 'end', datasetId: descriptor.id };
  }
  input.signal.throwIfAborted();
  await input.assertBoundary();
  await writeTenantBackupContentFrame({
    ...input,
    expectedSequence: saved.next_sequence,
    command,
    nextSourceCursor,
  });
  input.signal.throwIfAborted();
  await input.assertBoundary();
  return { complete: false };
}
