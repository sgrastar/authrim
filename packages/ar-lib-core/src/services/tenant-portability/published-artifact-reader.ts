import type { DatabaseAdapter } from '../../db/adapter';
import type { readTenantBackupArtifact } from './artifact-reader';

type Bucket = Parameters<typeof readTenantBackupArtifact>[0]['bucket'];
interface Publication {
  attempt_id: string;
  part_count: number;
  byte_count: number;
  expires_at: number;
}
function fail(): never {
  throw new Error('backup_download_unavailable');
}

/** Caller must authorize export/sensitive permissions and audit before consuming ciphertext. */
export async function openTenantBackupDownload(input: {
  database: Pick<DatabaseAdapter, 'queryOne'>;
  bucket: Bucket;
  tenantId: string;
  operationId: string;
  now: () => number;
  signal: AbortSignal;
}): Promise<{ byteCount: number; expiresAt: number; chunks: AsyncIterable<Uint8Array> }> {
  async function head(): Promise<Publication> {
    input.signal.throwIfAborted();
    const now = input.now();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    const row = await input.database.queryOne<Publication>(
      `SELECT v.attempt_id,v.expires_at,a.part_count,a.byte_count FROM tenant_backup_publications v
      JOIN tenant_backup_operations o ON o.id=v.operation_id AND o.tenant_id=v.tenant_id
      JOIN tenant_backup_artifact_attempts a ON a.id=v.attempt_id AND a.tenant_id=v.tenant_id
      WHERE v.operation_id=? AND v.tenant_id=? AND o.kind='export' AND o.state='ready' AND o.phase='export_complete'
      AND a.state='sealed' AND v.published_at<=? AND v.expires_at>?`,
      [input.operationId, input.tenantId, now, now]
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
  const pinned = await head();
  async function check(): Promise<void> {
    const current = await head();
    if (
      current.attempt_id !== pinned.attempt_id ||
      current.part_count !== pinned.part_count ||
      current.byte_count !== pinned.byte_count ||
      current.expires_at !== pinned.expires_at
    )
      fail();
  }
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let total = 0;
    for (let ordinal = 0; ordinal < pinned.part_count; ordinal++) {
      await check();
      const part = await input.database.queryOne<{
        object_key: string;
        byte_count: number;
        sha256: string;
        uploaded: number;
      }>(
        'SELECT object_key,byte_count,sha256,uploaded FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal=?',
        [pinned.attempt_id, input.tenantId, ordinal]
      );
      if (
        !part ||
        part.uploaded !== 1 ||
        !Number.isSafeInteger(part.byte_count) ||
        part.byte_count < 1 ||
        part.byte_count > 4194304 ||
        part.byte_count > pinned.byte_count - total ||
        !/^[a-f0-9]{64}$/.test(part.sha256) ||
        !part.object_key.startsWith(`tenant-backup-staging/${pinned.attempt_id}/${ordinal}/`)
      )
        fail();
      const object = await input.bucket.get(part.object_key);
      if (!object) fail();
      const reader = object.body.getReader();
      const bytes = new Uint8Array(part.byte_count);
      let offset = 0,
        ended = false;
      try {
        if (object.size !== bytes.length) fail();
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
      if (offset !== bytes.length) fail();
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (sha !== part.sha256) fail();
      await check();
      total += bytes.length;
      yield bytes;
    }
    await check();
    if (
      total !== pinned.byte_count ||
      (await input.database.queryOne(
        'SELECT ordinal FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal>=? LIMIT 1',
        [pinned.attempt_id, input.tenantId, pinned.part_count]
      ))
    )
      fail();
  }
  return { byteCount: pinned.byte_count, expiresAt: pinned.expires_at, chunks: chunks() };
}
