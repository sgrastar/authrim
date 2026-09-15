import { readTenantBackupArtifactPart } from './artifact-reader';
import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { tenantBundleCipherParameters } from './bundle-cipher';
import {
  TenantBundleContentEncoder,
  type TenantBundleEncoderCheckpoint,
} from './bundle-encoder-state';
import type { TenantBundleManifest, TenantBundleManifestExpectation } from './bundle-manifest';

type ReadInput = Parameters<typeof readTenantBackupArtifactPart>[0];
interface Stream {
  header_hex: string;
  next_sequence: number;
  plain_bytes: number;
  finished: number;
  part_count: number;
  byte_count: number;
}
interface Reservation {
  frame_type: number;
  plain_sha256: string;
  plain_length: number;
  checkpoint_json: string;
}
function fail(): never {
  throw new Error('backup_artifact_verification_failed');
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function state(raw: string): TenantBundleEncoderCheckpoint {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      content?: unknown;
      sourceCursor?: unknown;
    } | null;
    if (
      parsed?.version !== 1 ||
      !parsed.content ||
      !(parsed.sourceCursor === null || typeof parsed.sourceCursor === 'string')
    )
      fail();
    return parsed.content as TenantBundleEncoderCheckpoint;
  } catch {
    fail();
  }
}
/** Independent per-part readback for the resumable v1 exporter, including content-frame replay. */
export async function verifyTenantBackupArtifactPart(
  input: ReadInput & {
    ordinal: number;
    key: TenantBundleKeyEnvelope;
    manifest: TenantBundleManifest;
    expected: TenantBundleManifestExpectation;
  }
): Promise<{ nextPart: number; bytes: number; totalBytes: number; complete: boolean }> {
  async function stream(): Promise<Stream> {
    input.signal.throwIfAborted();
    const now = input.now();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    const row = await input.database.queryOne<Stream>(
      `SELECT s.header_hex,s.next_sequence,s.plain_bytes,s.finished,a.part_count,a.byte_count
      FROM tenant_backup_cipher_streams s JOIN tenant_backup_artifact_attempts a ON a.id=s.attempt_id AND a.tenant_id=s.tenant_id
      JOIN tenant_backup_operations o ON o.id=a.operation_id AND o.tenant_id=a.tenant_id
      WHERE s.attempt_id=? AND o.id=? AND o.tenant_id=? AND a.state='sealed' AND o.state='running'
      AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?`,
      [
        input.attemptId,
        input.lease.operationId,
        input.lease.tenantId,
        input.lease.owner,
        input.lease.fencingToken,
        now,
        now,
      ]
    );
    if (
      !row ||
      row.finished !== 1 ||
      row.part_count !== row.next_sequence + 1 ||
      !/^[a-f0-9]{250}$/.test(row.header_hex)
    )
      fail();
    return row;
  }
  const saved = await stream();
  const part = await readTenantBackupArtifactPart(input, input.ordinal);
  const header = Uint8Array.from(saved.header_hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  if (
    input.key.envelope.length !== 93 ||
    !header.subarray(0, 93).every((b, i) => b === input.key.envelope[i]) ||
    saved.header_hex.slice(2, 34) !== input.expected.bundleId
  )
    fail();
  if (input.ordinal === 0) {
    if (
      part.length !== 137 ||
      new TextDecoder().decode(part.subarray(0, 8)) !== 'AUTHRIM1' ||
      new DataView(part.buffer, part.byteOffset, part.byteLength).getUint32(8) !== 125 ||
      !part.subarray(12).every((b, i) => b === header[i])
    )
      fail();
    await TenantBundleContentEncoder.create(input.manifest, input.expected);
  } else {
    const sequence = input.ordinal - 1;
    const reservation = await input.database.queryOne<Reservation>(
      'SELECT frame_type,plain_sha256,plain_length,checkpoint_json FROM tenant_backup_cipher_frames WHERE attempt_id=? AND sequence=?',
      [input.attemptId, sequence]
    );
    const type = sequence === saved.next_sequence - 1 ? 2 : 1;
    if (
      !reservation ||
      reservation.frame_type !== type ||
      part.length < 21 ||
      part[4] !== type ||
      new DataView(part.buffer, part.byteOffset, part.byteLength).getUint32(0) !== part.length - 4
    )
      fail();
    const key = await deriveTenantBundleStreamKey(input.key.contentKey, header.slice(93));
    const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          tenantBundleCipherParameters(headerHash, sequence, type),
          key,
          new Uint8Array(part.subarray(5))
        )
      );
    } catch {
      fail();
    }
    if (
      plain.length !== reservation.plain_length ||
      hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(plain)))) !==
        reservation.plain_sha256
    )
      fail();
    const before = sequence
      ? await input.database.queryOne<{ checkpoint_json: string }>(
          'SELECT checkpoint_json FROM tenant_backup_cipher_frames WHERE attempt_id=? AND sequence=?',
          [input.attemptId, sequence - 1]
        )
      : null;
    if (sequence && !before) fail();
    const encoder = await TenantBundleContentEncoder.create(
      input.manifest,
      input.expected,
      before ? state(before.checkpoint_json) : undefined
    );
    if (type === 2) {
      if (
        encoder.checkpoint().phase !== 'done' ||
        plain.length !== 16 ||
        !before ||
        before.checkpoint_json !== reservation.checkpoint_json
      )
        fail();
      const footer = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
      if (
        footer.getBigUint64(0) !== BigInt(sequence) ||
        footer.getBigUint64(8) !== BigInt(saved.plain_bytes)
      )
        fail();
    } else {
      let encoded: Uint8Array;
      if (sequence === 0) encoded = await encoder.step({ kind: 'manifest' });
      else {
        if (plain.length < 3) fail();
        const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
        const descriptor = input.expected.datasets[view.getUint16(1)];
        if (!descriptor) fail();
        if (plain[0] === 2 && plain.length > 7)
          encoded = await encoder.step({
            kind: 'chunk',
            datasetId: descriptor.id,
            bytes: plain.subarray(7),
          });
        else if (plain[0] === 3)
          encoded = await encoder.step({ kind: 'end', datasetId: descriptor.id });
        else fail();
      }
      if (
        encoded.length !== plain.length ||
        !encoded.every((b, i) => b === plain[i]) ||
        JSON.stringify(encoder.checkpoint()) !== JSON.stringify(state(reservation.checkpoint_json))
      )
        fail();
    }
  }
  const confirmed = await stream();
  if (JSON.stringify(confirmed) !== JSON.stringify(saved)) fail();
  return {
    nextPart: input.ordinal + 1,
    bytes: part.length,
    totalBytes: saved.byte_count,
    complete: input.ordinal + 1 === saved.part_count,
  };
}
