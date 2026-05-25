import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { encryptObjectArtifact } from '../object-artifact-crypto';
import {
  loadChunkedSensitiveDetailJson,
  storeChunkedSensitiveDetailJson,
} from '../sensitive-detail-chunk-store';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function createR2Object(body: Uint8Array): R2ObjectBody {
  return {
    size: body.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  } as R2ObjectBody;
}

describe('loadChunkedSensitiveDetailJson', () => {
  it('loads and decrypts one detail record from a gzip JSONL chunk', async () => {
    const objectKey =
      'sensitive-details/v1/t_safe/sensitive_detail/control/admin_audit/2026/05/19/00/shard-01/chk_1.jsonl.gz';
    const envelope = await encryptObjectArtifact(JSON.stringify({ metadata: { ok: true } }), {
      rootKeyHex: ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'admin_audit_detail',
      },
    });
    const chunk = await gzipText(
      `${JSON.stringify({ ignored: true })}\n${JSON.stringify(envelope)}`
    );
    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-1',
        tenant_id: 'tenant-a',
        object_class: 'admin_audit_detail',
        bucket_binding: 'SENSITIVE_DETAILS',
        object_key: objectKey,
        content_encoding: 'gzip',
        line_number: 1,
        key_version: 1,
        checksum_sha256: null,
        created_at: 1,
        deleted_at: null,
      }),
    } as unknown as DatabaseAdapter;
    const env = {
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      SENSITIVE_DETAILS: {
        get: vi.fn().mockResolvedValue(createR2Object(chunk)),
      } as unknown as R2Bucket,
    };

    const result = await loadChunkedSensitiveDetailJson<{ metadata: { ok: boolean } }>(
      adapter,
      env as never,
      {
        tenantId: 'tenant-a',
        objectCatalogId: 'catalog-1',
        expectedClass: 'admin_audit_detail',
      }
    );

    expect(result).toEqual({ metadata: { ok: true } });
  });

  it('uses byte offset lookup for uncompressed chunks without reading the full object', async () => {
    const objectKey =
      'sensitive-details/v1/t_safe/sensitive_detail/control/admin_audit/2026/05/19/00/shard-01/chk_2.jsonl.gz';
    const envelope = await encryptObjectArtifact(JSON.stringify({ metadata: { ranged: true } }), {
      rootKeyHex: ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey,
        objectClass: 'admin_audit_detail',
      },
    });
    const ignoredLine = JSON.stringify({ ignored: true });
    const targetLine = JSON.stringify(envelope);
    const byteOffset = new TextEncoder().encode(`${ignoredLine}\n`).byteLength;
    const byteLength = new TextEncoder().encode(targetLine).byteLength;
    const adapter = {
      queryOne: vi.fn().mockResolvedValue({
        catalog_id: 'catalog-1',
        tenant_id: 'tenant-a',
        object_class: 'admin_audit_detail',
        bucket_binding: 'SENSITIVE_DETAILS',
        object_key: objectKey,
        content_encoding: 'none',
        line_number: 1,
        byte_offset: byteOffset,
        byte_length: byteLength,
        key_version: 1,
        checksum_sha256: null,
        created_at: 1,
        deleted_at: null,
      }),
    } as unknown as DatabaseAdapter;
    const get = vi.fn().mockImplementation(async (_key: string, options?: unknown) => {
      if (options) {
        return createR2Object(new TextEncoder().encode(targetLine));
      }
      throw new Error('full_object_read_should_not_be_used');
    });
    const env = {
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      SENSITIVE_DETAILS: { get } as unknown as R2Bucket,
    };

    const result = await loadChunkedSensitiveDetailJson<{ metadata: { ranged: boolean } }>(
      adapter,
      env as never,
      {
        tenantId: 'tenant-a',
        objectCatalogId: 'catalog-1',
        expectedClass: 'admin_audit_detail',
      }
    );

    expect(result).toEqual({ metadata: { ranged: true } });
    expect(get).toHaveBeenCalledWith(objectKey, {
      range: {
        offset: byteOffset,
        length: byteLength,
      },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('storeChunkedSensitiveDetailJson', () => {
  it('uses a tenant registry backed key resolver for sensitive detail chunk paths', async () => {
    const adapter = {
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    } as unknown as DatabaseAdapter;
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const queue = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    const result = await storeChunkedSensitiveDetailJson({
      adapter,
      bucket,
      rootKeyHex: ROOT_KEY,
      tenantId: 'tenant-a',
      objectClass: 'admin_audit_detail',
      payload: { metadata: { ok: true } },
      contentType: 'application/json',
      createdAt: 1_779_120_000_000,
      tenantKeyResolver: async () => 't_registry_sensitive',
      queueBindings: {
        LOGGING_DELIVERY_CRITICAL_QUEUE: queue,
      },
    });

    expect(result).toMatchObject({
      objectKey: null,
      queued: true,
    });
    expect(bucket.put).not.toHaveBeenCalled();
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'chunk_write',
        tenant_key: 't_registry_sensitive',
        plane: 'sensitive_detail',
        records: [
          expect.objectContaining({
            catalog_id: result.catalogId,
            tenant_id: 'tenant-a',
            object_class: 'admin_audit_detail',
            pending_object_key: `pending-sensitive-detail:${result.catalogId}`,
          }),
        ],
      })
    );
  });
});
