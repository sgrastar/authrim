import type { DatabaseAdapter } from '../../db/adapter';
import { TENANT_BACKUP_CONTAINER_V2_LIMITS } from './backup-container-v2';
import type { TenantBackupLease } from './operation-store';

/** One data frame of a v2 input: where its ciphertext lies and which plaintext bytes it carries. */
export interface TenantBackupInputFrame {
  sequence: number;
  objectOffset: number;
  frameBytes: number;
  plainOffset: number;
  plainBytes: number;
}

interface Row {
  sequence: number;
  object_offset: number;
  frame_bytes: number;
  plain_offset: number;
  plain_bytes: number;
}

const { headerBytes: HEADER_BYTES, frameOverheadBytes: OVERHEAD } =
  TENANT_BACKUP_CONTAINER_V2_LIMITS;
const WRITE_BATCH = 50;
const READ_PAGE = 1000;

function fail(): never {
  throw new Error('backup_input_frame_index_invalid');
}

/** The index is a pure function of the frame lengths, so every consumer re-derives and checks it. */
export function assertTenantBackupInputFrameChain(
  frames: readonly TenantBackupInputFrame[],
  first?: TenantBackupInputFrame
): void {
  let expected = first ?? {
    sequence: 0,
    objectOffset: HEADER_BYTES,
    frameBytes: 0,
    plainOffset: 0,
    plainBytes: 0,
  };
  for (const frame of frames) {
    if (
      !Number.isSafeInteger(frame.sequence) ||
      !Number.isSafeInteger(frame.objectOffset) ||
      !Number.isSafeInteger(frame.frameBytes) ||
      !Number.isSafeInteger(frame.plainOffset) ||
      !Number.isSafeInteger(frame.plainBytes) ||
      frame.sequence !== expected.sequence ||
      frame.objectOffset !== expected.objectOffset ||
      frame.plainOffset !== expected.plainOffset ||
      frame.frameBytes < OVERHEAD ||
      frame.plainBytes !== frame.frameBytes - OVERHEAD
    )
      fail();
    expected = {
      sequence: frame.sequence + 1,
      objectOffset: frame.objectOffset + frame.frameBytes,
      frameBytes: 0,
      plainOffset: frame.plainOffset + frame.plainBytes,
      plainBytes: 0,
    };
  }
}

/**
 * Durable frame index written by decode_input while it authenticates an input. Rows are written
 * idempotently under the operation lease before the input receipt; readers only trust them once the
 * receipt exists, and they re-check the chain and authenticate every frame they decrypt.
 */
export class TenantBackupInputFrameStore {
  constructor(
    private readonly database: Pick<DatabaseAdapter, 'query' | 'execute'> &
      Partial<Pick<DatabaseAdapter, 'batch'>>,
    private readonly lease: TenantBackupLease,
    private readonly now: () => number
  ) {}

  private guard(timestamp: number) {
    return {
      sql: `EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=? AND o.tenant_id=?
        AND o.kind='import' AND o.state='running' AND o.lease_owner=? AND o.fencing_token=?
        AND o.lease_expires_at>? AND o.updated_at<=?)`,
      params: [
        this.lease.operationId,
        this.lease.tenantId,
        this.lease.owner,
        this.lease.fencingToken,
        timestamp,
        timestamp,
      ],
    };
  }

  private timestamp(): number {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    return timestamp;
  }

  async save(bundleId: string, frames: readonly TenantBackupInputFrame[]): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(bundleId)) fail();
    if (!frames.length) return;
    assertTenantBackupInputFrameChain(frames, frames[0]);
    for (let start = 0; start < frames.length; start += WRITE_BATCH) {
      const page = frames.slice(start, start + WRITE_BATCH);
      const timestamp = this.timestamp();
      const guard = this.guard(timestamp);
      const statements = page.map((frame) => ({
        sql: `INSERT INTO tenant_backup_input_frames
            (operation_id,tenant_id,bundle_id,sequence,object_offset,frame_bytes,plain_offset,plain_bytes)
            SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
            ON CONFLICT(operation_id,bundle_id,sequence) DO NOTHING`,
        params: [
          this.lease.operationId,
          this.lease.tenantId,
          bundleId,
          frame.sequence,
          frame.objectOffset,
          frame.frameBytes,
          frame.plainOffset,
          frame.plainBytes,
          ...guard.params,
        ],
      }));
      if (this.database.batch) await this.database.batch(statements);
      else for (const { sql, params } of statements) await this.database.execute(sql, params);
      // A retried slice must find exactly the rows it would have written; anything else is a fence loss.
      const saved = await this.page(bundleId, page[0].sequence, page.length);
      if (
        saved.length !== page.length ||
        saved.some(
          (frame, index) =>
            frame.sequence !== page[index].sequence ||
            frame.objectOffset !== page[index].objectOffset ||
            frame.frameBytes !== page[index].frameBytes ||
            frame.plainOffset !== page[index].plainOffset ||
            frame.plainBytes !== page[index].plainBytes
        )
      )
        fail();
    }
  }

  /** Frames `from`..`from + count - 1` in order (fewer at the end); callers check the chain. */
  async range(bundleId: string, from: number, count: number): Promise<TenantBackupInputFrame[]> {
    if (
      !/^[a-f0-9]{32}$/.test(bundleId) ||
      !Number.isSafeInteger(from) ||
      from < 0 ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > READ_PAGE
    )
      fail();
    return count ? this.page(bundleId, from, count) : [];
  }

  /** Every frame of one input in sequence order, chain-checked from the container header. */
  async load(bundleId: string): Promise<TenantBackupInputFrame[]> {
    if (!/^[a-f0-9]{32}$/.test(bundleId)) fail();
    const frames: TenantBackupInputFrame[] = [];
    for (;;) {
      const page = await this.page(bundleId, frames.length, READ_PAGE);
      frames.push(...page);
      if (page.length < READ_PAGE) break;
    }
    assertTenantBackupInputFrameChain(frames);
    return frames;
  }

  private async page(
    bundleId: string,
    from: number,
    limit: number
  ): Promise<TenantBackupInputFrame[]> {
    const timestamp = this.timestamp();
    const guard = this.guard(timestamp);
    const rows = await this.database.query<Row>(
      `SELECT sequence,object_offset,frame_bytes,plain_offset,plain_bytes FROM tenant_backup_input_frames
      WHERE operation_id=? AND tenant_id=? AND bundle_id=? AND sequence>=? AND ${guard.sql}
      ORDER BY sequence LIMIT ?`,
      [this.lease.operationId, this.lease.tenantId, bundleId, from, ...guard.params, limit]
    );
    const frames = rows.map((row) => ({
      sequence: Number(row.sequence),
      objectOffset: Number(row.object_offset),
      frameBytes: Number(row.frame_bytes),
      plainOffset: Number(row.plain_offset),
      plainBytes: Number(row.plain_bytes),
    }));
    if (frames.length && frames[0].sequence !== from) fail();
    return frames;
  }
}
