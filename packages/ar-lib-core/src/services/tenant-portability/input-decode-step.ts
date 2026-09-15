import {
  readTenantBackupInputFrame,
  type TenantBackupInputIdentity,
  type TenantBackupInputCursor,
} from './input-frame-reader';
import {
  TenantBundleCipherDecoder,
  type TenantBundleCipherCheckpoint,
} from './bundle-cipher-decoder';
import { TenantBundleContentDecoder } from './bundle-content-decoder';
import type { TenantBundleEncoderCheckpoint } from './bundle-encoder-state';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleContentEvent } from './bundle-codec';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from './bundle-manifest';

export interface TenantBackupInputDecodeCheckpoint {
  version: 1;
  identity: TenantBackupInputIdentity;
  transport: TenantBackupInputCursor;
  headerHex: string;
  cipher: TenantBundleCipherCheckpoint;
  content: TenantBundleEncoderCheckpoint;
  complete: boolean;
}
function fail(): never {
  throw new Error('backup_input_checkpoint_invalid');
}

/**
 * One authenticated input frame per slice. Persist the returned checkpoint only together with
 * the event's staging/inspector receipt. This function has no side effects and can replay from
 * the previous checkpoint after an uncertain commit. Checkpoints must be operation-owned.
 */
export async function decodeTenantBackupInputStep(
  input: Omit<Parameters<typeof readTenantBackupInputFrame>[0], 'cursor'> & {
    session: TenantBundleKeyEnvelope;
    manifest: TenantBundleManifest;
    expected: TenantBundleManifestExpectation;
    checkpoint: TenantBackupInputDecodeCheckpoint | null;
  }
): Promise<{
  event: TenantBundleContentEvent | { kind: 'header' | 'footer' };
  checkpoint: TenantBackupInputDecodeCheckpoint;
}> {
  const identity = { ...input.identity };
  const previous = input.checkpoint ? structuredClone(input.checkpoint) : null;
  if (
    previous &&
    (previous.version !== 1 ||
      previous.complete !== false ||
      Object.keys(previous).sort().join(',') !==
        'cipher,complete,content,headerHex,identity,transport,version' ||
      previous.identity.key !== identity.key ||
      previous.identity.version !== identity.version ||
      previous.identity.etag !== identity.etag ||
      previous.identity.size !== identity.size ||
      !/^[a-f0-9]{250}$/.test(previous.headerHex) ||
      previous.transport.frames !== 1 + previous.cipher.chunks + Number(previous.cipher.complete) ||
      previous.transport.offset !==
        137 +
          previous.cipher.bytes +
          21 * previous.cipher.chunks +
          (previous.cipher.complete ? 37 : 0))
  )
    fail();
  if (
    [...input.session.envelope.subarray(1, 17)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('') !== input.expected.bundleId
  )
    fail();
  const content = await TenantBundleContentDecoder.create(
    input.manifest,
    input.expected,
    previous?.content
  );
  let header = previous
    ? new Uint8Array((previous.headerHex.match(/../g) ?? []).map((value) => parseInt(value, 16)))
    : null;
  let cipher = header
    ? await TenantBundleCipherDecoder.create(header, input.session, input.limits, previous?.cipher)
    : null;
  const next = await readTenantBackupInputFrame({
    ...input,
    identity,
    cursor: previous?.transport ?? { offset: 0, frames: 0 },
  });
  let event: TenantBundleContentEvent | { kind: 'header' | 'footer' };
  if (!next) {
    if (!previous || !cipher?.checkpoint().complete) fail();
    event = content.finish();
    return { event, checkpoint: { ...previous, complete: true } };
  }
  if (!cipher) {
    header = new Uint8Array(next.payload);
    cipher = await TenantBundleCipherDecoder.create(header, input.session, input.limits);
    event = { kind: 'header' };
  } else {
    const decrypted = await cipher.step(next.payload);
    if (decrypted.kind === 'footer') {
      if (content.checkpoint().phase !== 'done') fail();
      event = { kind: 'footer' };
    } else event = await content.step(decrypted.bytes);
  }
  if (!header) fail();
  await input.assertAuthorized();
  input.signal.throwIfAborted();
  return {
    event,
    checkpoint: {
      version: 1,
      identity,
      transport: next.cursor,
      headerHex: [...header].map((b) => b.toString(16).padStart(2, '0')).join(''),
      cipher: cipher.checkpoint(),
      content: content.checkpoint(),
      complete: false,
    },
  };
}
