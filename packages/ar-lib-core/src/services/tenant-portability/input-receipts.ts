import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import type { TenantBackupInputDecodeCheckpoint } from './input-decode-step';
import { decodeTenantBackupInputStep } from './input-decode-step';

type Result = Awaited<ReturnType<typeof decodeTenantBackupInputStep>>;
interface Receipt {
  sequence: number;
  checkpoint_json: string;
  event_sha256: string;
}
const LIVE = `EXISTS (SELECT 1 FROM tenant_backup_operations o WHERE o.id=r.operation_id
  AND o.tenant_id=r.tenant_id AND o.kind='import' AND o.state='running'
  AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?)`;
function fail(): never {
  throw new Error('backup_input_receipt_failed');
}
async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function eventHash(value: Result['event']): Promise<string> {
  const event =
    value.kind === 'chunk'
      ? {
          kind: value.kind,
          datasetId: value.datasetId,
          ordinal: value.ordinal,
          bytes: value.bytes.length,
          sha256: await digest(value.bytes),
        }
      : value;
  return digest(new TextEncoder().encode(JSON.stringify(event)));
}

/**
 * Atomic checkpoint plus receipt for an immutable encrypted input range. The original R2 object
 * must remain pinned until restore/cleanup finishes. No plaintext is staged here; consumers replay
 * ranges through the authenticated decoder. Module validation has its own completion boundary.
 */
export class TenantBackupInputReceipts {
  private readonly lease: TenantBackupLease;
  constructor(
    private readonly database: Pick<DatabaseAdapter, 'queryOne'>,
    lease: TenantBackupLease,
    private readonly now: () => number
  ) {
    this.lease = { ...lease };
  }
  private params(bundleId: string): unknown[] {
    const timestamp = this.now();
    if (!/^[a-f0-9]{32}$/.test(bundleId) || !Number.isSafeInteger(timestamp) || timestamp < 0)
      fail();
    return [
      this.lease.operationId,
      this.lease.tenantId,
      bundleId,
      this.lease.owner,
      this.lease.fencingToken,
      timestamp,
      timestamp,
    ];
  }
  async latest(
    bundleId: string
  ): Promise<{ sequence: number; checkpoint: TenantBackupInputDecodeCheckpoint } | null> {
    const params = this.params(bundleId);
    const live = await this.database.queryOne(
      `SELECT id FROM tenant_backup_operations WHERE id=? AND tenant_id=? AND kind='import' AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=?`,
      [params[0], params[1], ...params.slice(3)]
    );
    if (!live) fail();
    const receipt = await this.database.queryOne<Receipt>(
      `SELECT r.* FROM tenant_backup_input_receipts r WHERE operation_id=? AND tenant_id=? AND bundle_id=? AND ${LIVE} ORDER BY sequence DESC LIMIT 1`,
      params
    );
    return receipt
      ? {
          sequence: receipt.sequence,
          checkpoint: JSON.parse(receipt.checkpoint_json) as TenantBackupInputDecodeCheckpoint,
        }
      : null;
  }
  /** Resolve and authenticate a dataset boundary from a completed input, including empty datasets. */
  async datasetStart(
    bundleId: string,
    datasetId: string,
    input: Omit<Parameters<typeof decodeTenantBackupInputStep>[0], 'checkpoint'>
  ): Promise<number> {
    const datasetIndex = input.manifest.datasets.findIndex((dataset) => dataset.id === datasetId);
    if (datasetIndex < 0 || input.expected.bundleId !== bundleId) fail();
    const latest = await this.latest(bundleId);
    if (!latest?.checkpoint.complete) fail();
    const boundary = await this.database.queryOne<{ sequence: number }>(
      `SELECT r.sequence FROM tenant_backup_input_receipts r WHERE operation_id=? AND tenant_id=? AND bundle_id=? AND ${LIVE}
      AND json_extract(checkpoint_json,'$.content.phase')='datasets'
      AND json_extract(checkpoint_json,'$.content.chunks')=0
      AND json_extract(checkpoint_json,'$.content.datasetIndex')=? ORDER BY sequence LIMIT 1`,
      [...this.params(bundleId), datasetIndex]
    );
    if (!boundary || boundary.sequence >= latest.sequence) fail();
    const event = await this.replay(bundleId, boundary.sequence, input);
    if (
      datasetIndex === 0
        ? event.kind !== 'manifest'
        : event.kind !== 'dataset_end' ||
          event.datasetId !== input.manifest.datasets[datasetIndex - 1].id
    )
      fail();
    return boundary.sequence + 1;
  }

  /**
   * Read-only replay of one committed event after transport/content validation has completed.
   * This does not prove module/reference validation or authorize target writes. Keep the source
   * object's retention reservation alive; a missing or replaced object must stop the restore.
   */
  async replay(
    bundleId: string,
    sequence: number,
    input: Omit<Parameters<typeof decodeTenantBackupInputStep>[0], 'checkpoint'>
  ): Promise<Result['event']> {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > 1000001 ||
      input.expected.bundleId !== bundleId
    )
      fail();
    const latest = await this.latest(bundleId);
    if (!latest?.checkpoint.complete || sequence > latest.sequence) fail();
    const read = async (ordinal: number): Promise<Receipt> => {
      const receipt = await this.database.queryOne<Receipt>(
        `SELECT r.* FROM tenant_backup_input_receipts r WHERE operation_id=? AND tenant_id=? AND bundle_id=? AND ${LIVE} AND sequence=?`,
        [...this.params(bundleId), ordinal]
      );
      if (!receipt) fail();
      return receipt;
    };
    const receipt = await read(sequence);
    const previous =
      sequence === 0
        ? null
        : (JSON.parse(
            (await read(sequence - 1)).checkpoint_json
          ) as TenantBackupInputDecodeCheckpoint);
    const result = await decodeTenantBackupInputStep({ ...input, checkpoint: previous });
    if (
      JSON.stringify(result.checkpoint) !== receipt.checkpoint_json ||
      (await eventHash(result.event)) !== receipt.event_sha256
    )
      fail();
    const confirmed = await read(sequence);
    if (
      confirmed.checkpoint_json !== receipt.checkpoint_json ||
      confirmed.event_sha256 !== receipt.event_sha256
    )
      fail();
    return result.event;
  }

  /** Commit exactly the next decoded event. Unknown write outcomes are retried with the same result. */
  async append(
    bundleId: string,
    sequence: number,
    previous: TenantBackupInputDecodeCheckpoint | null,
    result: Result
  ): Promise<void> {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > 1000001 ||
      (sequence === 0) !== (previous === null)
    )
      fail();
    const pinned = structuredClone(result);
    if (
      pinned.checkpoint.transport.frames !== sequence + 1 - Number(pinned.checkpoint.complete) ||
      pinned.checkpoint.complete !== (pinned.event.kind === 'complete') ||
      (sequence === 0) !== (pinned.event.kind === 'header') ||
      previous?.complete ||
      (previous && JSON.stringify(previous.identity) !== JSON.stringify(pinned.checkpoint.identity))
    )
      fail();
    const checkpoint = JSON.stringify(pinned.checkpoint);
    const previousJson = previous ? JSON.stringify(previous) : null;
    if (new TextEncoder().encode(checkpoint).length > 16384 || pinned.checkpoint.version !== 1)
      fail();
    const eventDigest = await eventHash(pinned.event);
    const params = this.params(bundleId);
    await this.database.queryOne(
      `INSERT INTO tenant_backup_input_receipts(operation_id,tenant_id,bundle_id,sequence,checkpoint_json,event_sha256)
      SELECT o.id,o.tenant_id,?,?,?,? FROM tenant_backup_operations o WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state='running'
      AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      AND (?=0 OR EXISTS (SELECT 1 FROM tenant_backup_input_receipts p WHERE p.operation_id=o.id AND p.tenant_id=o.tenant_id AND p.bundle_id=? AND p.sequence=? AND p.checkpoint_json=?))
      AND NOT EXISTS (SELECT 1 FROM tenant_backup_input_receipts p WHERE p.operation_id=o.id AND p.bundle_id=? AND p.sequence>=?)
      ON CONFLICT(operation_id,bundle_id,sequence) DO NOTHING RETURNING sequence`,
      [
        bundleId,
        sequence,
        checkpoint,
        eventDigest,
        params[0],
        params[1],
        ...params.slice(3),
        sequence,
        bundleId,
        sequence - 1,
        previousJson,
        bundleId,
        sequence,
      ]
    );
    const receipt = await this.database.queryOne<Receipt>(
      `SELECT r.* FROM tenant_backup_input_receipts r WHERE operation_id=? AND tenant_id=? AND bundle_id=? AND ${LIVE} AND sequence=?`,
      [...params, sequence]
    );
    if (!receipt || receipt.checkpoint_json !== checkpoint || receipt.event_sha256 !== eventDigest)
      fail();
  }
}
