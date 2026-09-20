import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import { TenantBackupArtifactWriter } from './artifact-writer';
import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { tenantBundleCipherParameters } from './bundle-cipher';

type Database = Pick<DatabaseAdapter, 'queryOne'>;
interface Stream {
  header_hex: string;
  next_sequence: number;
  plain_bytes: number;
  finished: number;
  checkpoint_json: string | null;
}
const LIVE = `EXISTS (SELECT 1 FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
  ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE a.id=s.attempt_id AND a.tenant_id=s.tenant_id
  AND a.state IN ('writing','sealed') AND o.id=? AND o.tenant_id=? AND o.state='running'
  AND a.fencing_token=o.fencing_token AND o.fencing_token=? AND o.lease_owner=?
  AND o.lease_expires_at>? AND o.updated_at<=?)`;
function fail(): never {
  throw new Error('backup_cipher_journal_failed');
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
}
function framed(payload: Uint8Array, magic = false): Uint8Array<ArrayBuffer> {
  const offset = magic ? 8 : 0;
  const out = new Uint8Array(offset + 4 + payload.length);
  if (magic) out.set(new TextEncoder().encode('AUTHRIM1'));
  new DataView(out.buffer).setUint32(offset, payload.length);
  out.set(payload, offset + 4);
  return out;
}

/** Resumable v1 encryption, one bounded ciphertext frame per immutable artifact part. */
export class TenantBackupCipherJournal {
  private constructor(
    private readonly database: Database,
    private readonly writer: TenantBackupArtifactWriter,
    private readonly lease: TenantBackupLease,
    private readonly now: () => number,
    private readonly header: Uint8Array<ArrayBuffer>,
    private readonly key: CryptoKey,
    private readonly headerHash: Uint8Array<ArrayBuffer>
  ) {}
  static async open(
    database: Database,
    writer: TenantBackupArtifactWriter,
    lease: TenantBackupLease,
    now: () => number,
    session: TenantBundleKeyEnvelope
  ): Promise<TenantBackupCipherJournal> {
    if (session.envelope.length !== 93 || session.envelope[0] !== 1) fail();
    const header = new Uint8Array(125);
    header.set(session.envelope);
    header.set(crypto.getRandomValues(new Uint8Array(32)), 93);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    await database.queryOne(
      `INSERT INTO tenant_backup_cipher_streams(attempt_id,tenant_id,header_hex)
      SELECT a.id,a.tenant_id,? FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
      ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE a.id=? AND a.state='writing'
      AND o.id=? AND o.tenant_id=? AND o.state='running' AND o.lease_owner=?
      AND a.fencing_token=o.fencing_token AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`,
      [
        hex(header),
        writer.attemptId,
        lease.operationId,
        lease.tenantId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    const state = await database.queryOne<Stream>(
      `SELECT s.* FROM tenant_backup_cipher_streams s WHERE s.attempt_id=? AND ${LIVE}`,
      [
        writer.attemptId,
        lease.operationId,
        lease.tenantId,
        lease.fencingToken,
        lease.owner,
        timestamp,
        timestamp,
      ]
    );
    if (!state || !/^[a-f0-9]{250}$/.test(state.header_hex)) fail();
    const pinned = unhex(state.header_hex);
    if (!pinned.subarray(0, 93).every((byte, i) => byte === session.envelope[i])) fail();
    return new TenantBackupCipherJournal(
      database,
      writer,
      { ...lease },
      now,
      pinned,
      await deriveTenantBundleStreamKey(session.contentKey, pinned.slice(93)),
      new Uint8Array(await crypto.subtle.digest('SHA-256', pinned))
    );
  }
  private params(): unknown[] {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    return [
      this.lease.operationId,
      this.lease.tenantId,
      this.lease.fencingToken,
      this.lease.owner,
      timestamp,
      timestamp,
    ];
  }
  async progress(): Promise<Stream> {
    const state = await this.database.queryOne<Stream>(
      `SELECT s.* FROM tenant_backup_cipher_streams s WHERE s.attempt_id=? AND ${LIVE}`,
      [this.writer.attemptId, ...this.params()]
    );
    if (!state || state.header_hex !== hex(this.header)) fail();
    return state;
  }
  /** Sequence and checkpoint come from the persisted source/content plan, never an uploaded file. */
  async write(
    sequence: number,
    source: Uint8Array,
    checkpointJson: string,
    final = false
  ): Promise<void> {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence >= 1000000 ||
      !(source instanceof Uint8Array) ||
      !source.length ||
      source.length > 1048576 ||
      typeof checkpointJson !== 'string' ||
      new TextEncoder().encode(checkpointJson).length > 16384
    )
      fail();
    try {
      JSON.parse(checkpointJson);
    } catch {
      fail();
    }
    const plain = new Uint8Array(source);
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', plain)));
    const state = await this.progress();
    const type = final ? 2 : 1;
    if (sequence > state.next_sequence) fail();
    if (final && sequence === state.next_sequence) {
      if (plain.length !== 16) fail();
      const view = new DataView(plain.buffer);
      if (
        view.getBigUint64(0) !== BigInt(sequence) ||
        view.getBigUint64(8) !== BigInt(state.plain_bytes)
      )
        fail();
    }
    await this.database.queryOne(
      `INSERT INTO tenant_backup_cipher_frames(attempt_id,sequence,frame_type,plain_sha256,plain_length,checkpoint_json)
      SELECT s.attempt_id,?,?,?,?,? FROM tenant_backup_cipher_streams s
      WHERE s.attempt_id=? AND s.finished=0 AND s.next_sequence=? AND ${LIVE}
      ON CONFLICT(attempt_id,sequence) DO NOTHING RETURNING sequence`,
      [
        sequence,
        type,
        digest,
        plain.length,
        checkpointJson,
        this.writer.attemptId,
        sequence,
        ...this.params(),
      ]
    );
    const reservation = await this.database.queryOne<{
      frame_type: number;
      plain_sha256: string;
      plain_length: number;
      checkpoint_json: string;
    }>(
      `SELECT f.* FROM tenant_backup_cipher_frames f JOIN tenant_backup_cipher_streams s ON s.attempt_id=f.attempt_id
      WHERE f.attempt_id=? AND f.sequence=? AND ${LIVE}`,
      [this.writer.attemptId, sequence, ...this.params()]
    );
    if (
      !reservation ||
      reservation.frame_type !== type ||
      reservation.plain_sha256 !== digest ||
      reservation.plain_length !== plain.length ||
      reservation.checkpoint_json !== checkpointJson
    )
      fail();
    if (sequence < state.next_sequence) return;
    if (state.finished) fail();
    // Reservation fixes plaintext and AAD type before any encryption under this nonce.
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        tenantBundleCipherParameters(this.headerHash, sequence, type),
        this.key,
        plain
      )
    );
    const payload = new Uint8Array(encrypted.length + 1);
    payload[0] = type;
    payload.set(encrypted, 1);
    const part = framed(payload);
    await this.writer.writePart(0, framed(this.header, true));
    await this.writer.writePart(sequence + 1, part);
    const cipherDigest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', part)));
    await this.database.queryOne(
      `UPDATE tenant_backup_cipher_streams AS s SET next_sequence=next_sequence+1,
      plain_bytes=plain_bytes+?,finished=?,checkpoint_json=?
      WHERE s.attempt_id=? AND s.next_sequence=? AND s.finished=0 AND ${LIVE}
      AND EXISTS (SELECT 1 FROM tenant_backup_artifact_parts p WHERE p.attempt_id=s.attempt_id
      AND p.ordinal=? AND p.uploaded=1 AND p.sha256=? AND p.byte_count=?) RETURNING attempt_id`,
      [
        final ? 0 : plain.length,
        final ? 1 : 0,
        checkpointJson,
        this.writer.attemptId,
        sequence,
        ...this.params(),
        sequence + 1,
        cipherDigest,
        part.length,
      ]
    );
    if ((await this.progress()).next_sequence <= sequence) fail();
  }
  async finish(sequence: number, checkpointJson: string): Promise<void> {
    const state = await this.progress();
    const footer = new Uint8Array(16);
    new DataView(footer.buffer).setBigUint64(0, BigInt(sequence));
    new DataView(footer.buffer).setBigUint64(8, BigInt(state.plain_bytes));
    await this.write(sequence, footer, checkpointJson, true);
    const saved = await this.progress();
    if (!saved.finished) fail();
    const parts = await this.writer.progress();
    if (
      parts.reservedParts !== saved.next_sequence + 1 ||
      parts.uploadedParts !== parts.reservedParts
    )
      fail();
    await this.writer.seal(parts.reservedParts, parts.uploadedBytes);
  }
}
