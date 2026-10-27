import { createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  readFile,
  lstat,
  mkdir,
  writeFile,
  symlink,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantBackupExportPublicationReceiptV1 } from '@authrim/ar-lib-core/services/tenant-portability/trusted-export-receipt';
import { downloadReplicationExport, assertReplicationExportPublication } from './export-client';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import { openVerifiedTenantBackupV2 } from '../import/backup-reader';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-export-client-')));
  roots.push(root);
  const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const source = {
    tenantId: 'tenant-a',
    issuer: 'https://idp.example.test',
    productVersion: '0.4.2',
  };
  const publication: TenantBackupExportPublicationReceiptV1 = {
    formatVersion: 1,
    operationId: 'operation-a',
    expiresAt: 1000,
    byteCount: 5,
    boundaryUnixMs: 100,
    receipt: {
      source: { ...source },
      bundleId: 'a'.repeat(32),
      snapshotId: 'snapshot-a',
      inventoryDigestSha256: 'b'.repeat(64),
      parts: parts.map((part) => ({ size: part.length, sha256: hash(part) })),
    },
    selection: {
      settings: true,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    datasets: [
      {
        id: 'core.users',
        module: 'users',
        kind: 'users',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  let receiptReads = 0;
  const download = vi.fn(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.enqueue(new Uint8Array([2, 3, 4]));
            controller.enqueue(new Uint8Array([5]));
            controller.close();
          },
        }),
        { headers: { 'Content-Length': '5' } }
      )
  );
  const receipt = vi.fn(() => Response.json(publication));
  const transport: typeof fetch = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(init?.redirect).toBe('error');
      expect(init?.cache).toBe('no-store');
      expect(new Headers(init?.headers).get('X-Tenant-Id')).toBe('tenant-a');
      if (typeof url !== 'string') throw new Error('expected URL string');
      expect(url).toMatch(
        /^https:\/\/source\.example\.test\/api\/replication-backups\/grant-a\/exports\/operation-a\/(export-receipt|download)$/
      );
      if (url.endsWith('/export-receipt')) {
        receiptReads++;
        return receipt();
      }
      return download();
    }
  );
  const input = {
    managementOrigin: 'https://source.example.test',
    operationId: 'operation-a',
    grantId: 'grant-a',
    authorization: `Bearer ${'c'.repeat(64)}`,
    expectedSource: source,
    outputDirectory: join(root, 'download'),
    maxSnapshotAgeMs: 500,
    minimumBoundaryUnixMs: 99,
    fetch: transport,
    now: () => 200,
  };
  return {
    root,
    parts,
    publication,
    input,
    download,
    receipt,
    transport,
    receiptReads: () => receiptReads,
  };
}
describe('verified export download transport', () => {
  it('splits exact encrypted boundaries across arbitrary chunks, verifies hashes and rechecks independent receipt', async () => {
    const f = await fixture();
    const downloaded = await downloadReplicationExport(f.input);
    expect(f.receiptReads()).toBe(2);
    expect(downloaded.publication).toEqual(f.publication);
    for (let i = 0; i < 2; i++) {
      expect(new Uint8Array(await readFile(downloaded.partPaths[i]))).toEqual(f.parts[i]);
      expect((await lstat(downloaded.partPaths[i])).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(f.input.outputDirectory)).mode & 0o777).toBe(0o700);
    expect(hash(await readFile(downloaded.publicationPath))).toBe(downloaded.publicationSha256);
  });
  it('downloads a real shared encrypted container and opens it with the existing independent-receipt reader', async () => {
    const f = await fixture();
    const passphrase = 'synthetic shared container passphrase';
    const session = await createTenantBundleKeyEnvelope(passphrase);
    const manifest = {
      formatVersion: 1 as const,
      bundleId: [...session.envelope.subarray(1, 17)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      source: f.input.expectedSource,
      snapshotId: 'snapshot-a',
      boundaryUnixMs: 100,
      inventoryDigestSha256: 'b'.repeat(64),
      selection: f.publication.selection,
      datasets: [...f.publication.datasets],
    };
    const row = { tenant_id: ['text', 'tenant-a'], id: ['text', 'user-a'] };
    const encoded = await encodeTenantBackupContainerV2({
      manifest,
      session,
      datasets: (async function* () {
        yield {
          datasetId: 'core.users',
          chunks: (async function* () {
            yield new TextEncoder().encode(JSON.stringify(row) + '\n');
          })(),
        };
      })(),
    });
    f.publication.receipt.bundleId = manifest.bundleId;
    f.publication.receipt.parts = encoded.parts.map((part) => ({
      size: part.byteLength,
      sha256: hash(part),
    }));
    f.publication.byteCount = encoded.parts.reduce((sum, part) => sum + part.byteLength, 0);
    f.download.mockImplementation(
      () =>
        new Response(new Blob(encoded.parts.map((part) => new Uint8Array(part))), {
          headers: { 'Content-Length': String(f.publication.byteCount) },
        })
    );
    const downloaded = await downloadReplicationExport(f.input);
    const backup = await openVerifiedTenantBackupV2({
      partPaths: downloaded.partPaths,
      receipt: downloaded.publication.receipt,
      passphrase,
      selection: manifest.selection,
      datasets: manifest.datasets,
      maxSnapshotAgeMs: 500,
      nowMs: 200,
    });
    try {
      const item = await backup.dataset('core.users').readNextRow(null);
      if (!item) throw new Error('missing expected user');
      expect(JSON.parse(item.rowJson)).toEqual(row);
    } finally {
      await backup.close();
    }
  });

  it.each([
    'truncated',
    'extra',
    'digest',
    'bad-length',
    'revoked',
    'changed-receipt',
    'expired',
  ] as const)('rejects %s and deletes only its incomplete owned output', async (kind) => {
    const f = await fixture();
    if (kind === 'truncated')
      f.download.mockImplementation(
        () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Length': '5' } })
      );
    if (kind === 'extra')
      f.download.mockImplementation(
        () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { headers: { 'Content-Length': '5' } })
      );
    if (kind === 'digest')
      f.download.mockImplementation(
        () => new Response(new Uint8Array([1, 9, 3, 4, 5]), { headers: { 'Content-Length': '5' } })
      );
    if (kind === 'bad-length')
      f.download.mockImplementation(
        () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { 'Content-Length': '6' } })
      );
    if (kind === 'revoked')
      f.receipt
        .mockImplementationOnce(() => Response.json(f.publication))
        .mockImplementation(() => Response.json({ error: 'revoked' }, { status: 403 }));
    if (kind === 'changed-receipt')
      f.receipt
        .mockImplementationOnce(() => Response.json(f.publication))
        .mockImplementation(() =>
          Response.json({
            ...f.publication,
            receipt: { ...f.publication.receipt, snapshotId: 'different' },
          })
        );
    if (kind === 'expired') {
      let reads = 0;
      f.input.now = () => (++reads === 1 ? 200 : 1000);
    }
    await expect(downloadReplicationExport(f.input)).rejects.toThrow(
      'replication_export_unavailable'
    );
    await expect(access(f.input.outputDirectory)).rejects.toThrow();
  });
  it.each(['tenant', 'issuer', 'operation', 'age', 'boundary', 'nan-boundary'] as const)(
    'rejects independently received %s mismatch before filesystem writes',
    async (kind) => {
      const f = await fixture();
      if (kind === 'tenant') f.publication.receipt.source.tenantId = 'tenant-b';
      if (kind === 'issuer') f.publication.receipt.source.issuer = 'https://other.example.test';
      if (kind === 'operation') f.publication.operationId = 'other';
      if (kind === 'age') f.input.maxSnapshotAgeMs = 99;
      if (kind === 'boundary') f.input.minimumBoundaryUnixMs = 101;
      if (kind === 'nan-boundary') f.input.minimumBoundaryUnixMs = NaN;
      await expect(downloadReplicationExport(f.input)).rejects.toThrow();
      expect(f.download).not.toHaveBeenCalled();
      await expect(access(f.input.outputDirectory)).rejects.toThrow();
    }
  );
  it.each(['directory', 'symlink'] as const)(
    'preserves an existing %s and all of its contents',
    async (kind) => {
      const f = await fixture();
      const kept = join(f.root, 'kept');
      await mkdir(kept);
      await writeFile(join(kept, 'sentinel'), 'user-owned');
      if (kind === 'directory') f.input.outputDirectory = kept;
      else await symlink(kept, f.input.outputDirectory);
      await expect(downloadReplicationExport(f.input)).rejects.toThrow();
      expect(await readFile(join(kept, 'sentinel'), 'utf8')).toBe('user-owned');
      expect(f.download).not.toHaveBeenCalled();
    }
  );
  it('rejects oversized receipt and redirects without forwarding credentials or creating output', async () => {
    const f = await fixture();
    f.receipt.mockImplementation(() => new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(downloadReplicationExport(f.input)).rejects.toThrow();
    expect(f.download).not.toHaveBeenCalled();
    f.receipt.mockImplementation(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://other.example.test/secret' },
        })
    );
    await expect(downloadReplicationExport(f.input)).rejects.toThrow();
    expect(f.receiptReads()).toBe(2);
    await expect(access(f.input.outputDirectory)).rejects.toThrow();
  });
  it('rejects malformed minimum boundary through the exported validation boundary', async () => {
    const f = await fixture();
    for (const minimumBoundaryUnixMs of [NaN, Infinity, -1, 0.5, 201])
      expect(() =>
        assertReplicationExportPublication(
          f.publication,
          { ...f.input, minimumBoundaryUnixMs },
          200
        )
      ).toThrow();
  });
});
