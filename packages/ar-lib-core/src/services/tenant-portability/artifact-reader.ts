import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';

interface SealedArtifact {
  part_count: number;
  byte_count: number;
}
interface Part {
  object_key: string;
  byte_count: number;
  sha256: string;
  uploaded: number;
}
interface Bucket {
  get(key: string): Promise<{
    size: number;
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    };
  } | null>;
}
function fail(): never {
  throw new Error('backup_artifact_read_failed');
}

/**
 * Internal operation-owned artifact readback, not a public download authorization mechanism.
 * Verify each bounded part before exposing bytes. Content/authenticated-footer validation remains
 * the caller's responsibility; this transport alone cannot approve a restore or publication.
 */
interface ArtifactReadInput {
  database: Pick<DatabaseAdapter, 'queryOne'>;
  bucket: Bucket;
  lease: Readonly<TenantBackupLease>;
  attemptId: string;
  signal: AbortSignal;
  now: () => number;
}

async function* readArtifactParts(
  input: ArtifactReadInput,
  first = 0,
  one = false
): AsyncGenerator<Uint8Array> {
  const lease = { ...input.lease };
  async function head(): Promise<SealedArtifact> {
    input.signal.throwIfAborted();
    const timestamp = input.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail();
    const row = await input.database.queryOne<SealedArtifact>(
      `SELECT a.part_count,a.byte_count FROM tenant_backup_artifact_attempts a
      JOIN tenant_backup_operations o ON o.id=a.operation_id AND o.tenant_id=a.tenant_id
      WHERE a.id=? AND a.tenant_id=? AND a.operation_id=? AND a.state='sealed'
      AND o.state='running' AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=?`,
      [
        input.attemptId,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    if (
      !row ||
      !Number.isSafeInteger(row.part_count) ||
      row.part_count < 1 ||
      row.part_count > 1000001 ||
      !Number.isSafeInteger(row.byte_count) ||
      row.byte_count < 1
    )
      fail();
    return row;
  }
  const artifact = await head();
  if (!Number.isSafeInteger(first) || first < 0 || first >= artifact.part_count) fail();
  let total = 0;
  for (let ordinal = first; ordinal < (one ? first + 1 : artifact.part_count); ordinal++) {
    const current = await head();
    if (current.part_count !== artifact.part_count || current.byte_count !== artifact.byte_count)
      fail();
    const part = await input.database.queryOne<Part>(
      `SELECT object_key,byte_count,sha256,uploaded FROM tenant_backup_artifact_parts
      WHERE attempt_id=? AND tenant_id=? AND ordinal=?`,
      [input.attemptId, lease.tenantId, ordinal]
    );
    if (
      !part ||
      part.uploaded !== 1 ||
      !Number.isSafeInteger(part.byte_count) ||
      part.byte_count < 1 ||
      part.byte_count > 4194304 ||
      !/^[a-f0-9]{64}$/.test(part.sha256) ||
      !part.object_key.startsWith(`tenant-backup-staging/${input.attemptId}/${ordinal}/`) ||
      part.byte_count > artifact.byte_count - total
    )
      fail();
    input.signal.throwIfAborted();
    const object = await input.bucket.get(part.object_key);
    if (!object) fail();
    const reader = object.body.getReader();
    const bytes = new Uint8Array(part.byte_count);
    let offset = 0,
      ended = false;
    try {
      if (object.size !== part.byte_count) fail();
      while (true) {
        input.signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) {
          ended = true;
          break;
        }
        if (!(item.value instanceof Uint8Array) || item.value.length > bytes.length - offset)
          fail();
        bytes.set(item.value, offset);
        offset += item.value.length;
      }
    } finally {
      if (!ended) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (offset !== part.byte_count) fail();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    if (digest !== part.sha256) fail();
    const confirmed = await head();
    if (
      confirmed.part_count !== artifact.part_count ||
      confirmed.byte_count !== artifact.byte_count
    )
      fail();
    total += bytes.length;
    yield bytes;
  }
  if (one) {
    await head();
    return;
  }
  const final = await head();
  const extra = await input.database.queryOne(
    'SELECT ordinal FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal>=? LIMIT 1',
    [input.attemptId, lease.tenantId, artifact.part_count]
  );
  if (
    extra ||
    total !== artifact.byte_count ||
    final.part_count !== artifact.part_count ||
    final.byte_count !== total
  )
    fail();
}

export async function* readTenantBackupArtifact(
  input: ArtifactReadInput
): AsyncGenerator<Uint8Array> {
  yield* readArtifactParts(input);
}

/** Bounded internal readback; it proves this part only, not complete artifact integrity. */
export async function readTenantBackupArtifactPart(
  input: ArtifactReadInput,
  ordinal: number
): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  for await (const part of readArtifactParts(input, ordinal, true)) bytes = part;
  if (!bytes) fail();
  return bytes;
}
