/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';

/** Pass-through fs wrapper that can cap read sizes and tamper with exactly one stat result. */
const ctl = vi.hoisted(() => ({
  readCap: Number.POSITIVE_INFINITY,
  watched: [] as string[],
  tamperAt: 0,
  counter: 0,
}));

function observe<T extends object>(stat: T): T {
  ctl.counter += 1;
  if (ctl.counter !== ctl.tamperAt) return stat;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat) as {
    ctimeNs: bigint;
  };
  copy.ctimeNs += 1n;
  return copy as unknown as T;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string, options: never) => {
      const stat = await actual.lstat(path, options);
      return ctl.watched.includes(path) ? observe(stat) : stat;
    },
    open: async (path: string, flags: number) => {
      const handle = await actual.open(path, flags);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'stat') {
            return async (options: never) => {
              const stat = await target.stat(options);
              return ctl.watched.includes(path) ? observe(stat) : stat;
            };
          }
          if (key === 'read') {
            return (buffer: Uint8Array, offset: number, length: number, position: number) =>
              target.read(buffer, offset, Math.min(length, ctl.readCap), position);
          }
          const value = (target as never as Record<PropertyKey, unknown>)[key];
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    },
  };
});

import { openVerifiedTenantBackupV2, type OpenVerifiedTenantBackupV2Input } from './backup-reader';

const INVALID = 'aws_backup_reader_invalid';
const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const PASSPHRASE = 'synthetic-test-passphrase-only';
const DATASET: TenantPortableDataset = {
  id: 'core.identity_accounts',
  module: 'users',
  kind: 'users',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
};
const SELECTION = {
  settings: false,
  users: true,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 7 as const },
};
const SOURCE = {
  tenantId: TENANT,
  issuer: 'https://tenant-a.example.test',
  productVersion: '0.4.2',
};
const rowLine = (id: string, pad = '') =>
  `${JSON.stringify({ tenant_id: ['text', TENANT], id: ['text', id], pad: ['text', pad] })}\n`;

interface Built {
  artifact: Uint8Array;
  manifest: TenantBundleManifest;
}
const directories: string[] = [];

async function build(lines: string[], boundaryUnixMs = NOW - 60_000): Promise<Built> {
  const session = await createTenantBundleKeyEnvelope(PASSPHRASE);
  const bundleId = Array.from(session.envelope.subarray(1, 17), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId,
    source: SOURCE,
    snapshotId: 'snapshot-a',
    boundaryUnixMs,
    inventoryDigestSha256: 'a'.repeat(64),
    selection: SELECTION,
    datasets: [DATASET],
  };
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    session,
    datasets: (async function* () {
      yield {
        datasetId: DATASET.id,
        chunks: (async function* () {
          for (const line of lines) yield new TextEncoder().encode(line);
        })(),
      };
    })(),
  });
  const artifact = new Uint8Array(encoded.parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of encoded.parts) {
    artifact.set(part, at);
    at += part.length;
  }
  return { artifact, manifest };
}

async function files(
  built: Built,
  cuts: number[] = []
): Promise<OpenVerifiedTenantBackupV2Input & { dir: string }> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'authrim-mut-backup-'));
  directories.push(dir);
  const bounds = [0, ...cuts, built.artifact.length];
  const parts = bounds.slice(1).map((end, i) => built.artifact.subarray(bounds[i], end));
  const partPaths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const path = join(dir, `part-${i}.bin`);
    await writeFile(path, parts[i]);
    partPaths.push(path);
  }
  return {
    dir,
    partPaths,
    receipt: {
      source: SOURCE,
      bundleId: built.manifest.bundleId,
      snapshotId: built.manifest.snapshotId,
      inventoryDigestSha256: built.manifest.inventoryDigestSha256,
      parts: parts.map((p) => ({
        size: p.length,
        sha256: createHash('sha256').update(p).digest('hex'),
      })),
    },
    passphrase: PASSPHRASE,
    selection: SELECTION,
    datasets: [DATASET],
    maxSnapshotAgeMs: 3_600_000,
    nowMs: NOW,
  };
}

let small: Built;
beforeAll(async () => {
  small = await build([rowLine('a'), rowLine('b')]);
});
beforeEach(() => {
  ctl.readCap = Number.POSITIVE_INFINITY;
  ctl.tamperAt = 0;
  ctl.counter = 0;
  ctl.watched = [];
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function readAll(input: OpenVerifiedTenantBackupV2Input): Promise<string[]> {
  const verified = await openVerifiedTenantBackupV2(input);
  const dataset = verified.dataset(DATASET.id);
  const out: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const next = await dataset.readNextRow(cursor);
    if (!next) break;
    out.push((JSON.parse(next.rowJson) as { id: string[] }).id[1]);
    cursor = next.nextCursor;
  }
  await verified.close();
  return out;
}

describe('input validation', () => {
  const mutate: [string, (i: OpenVerifiedTenantBackupV2Input) => void][] = [
    ['relative part path', (i) => ((i.partPaths as string[])[0] = 'relative.bin')],
    ['root path', (i) => ((i.partPaths as string[])[0] = '/')],
    ['directory path', (i) => ((i.partPaths as string[])[0] = i.partPaths[0] + '/..')],
    ['missing file', (i) => ((i.partPaths as string[])[0] = i.partPaths[0] + '.missing')],
    ['file used as directory', (i) => ((i.partPaths as string[])[0] = i.partPaths[0] + '/x')],
    ['null receipt', (i) => ((i as { receipt: unknown }).receipt = null)],
    ['no tenant id', (i) => (i.receipt.source = { ...SOURCE, tenantId: '' })],
    ['no issuer', (i) => (i.receipt.source = { ...SOURCE, issuer: '' })],
    ['no product version', (i) => (i.receipt.source = { ...SOURCE, productVersion: '' })],
    ['bad bundle id', (i) => (i.receipt.bundleId = 'A'.repeat(32))],
    ['short bundle id', (i) => (i.receipt.bundleId = 'a'.repeat(31))],
    ['empty snapshot id', (i) => (i.receipt.snapshotId = '')],
    ['bad digest', (i) => (i.receipt.inventoryDigestSha256 = 'z'.repeat(64))],
    ['parts not array', (i) => ((i.receipt as { parts: unknown }).parts = 'x')],
    ['no parts', (i) => ((i.receipt as unknown as { parts: unknown[] }).parts = [])],
    ['paths count mismatch', (i) => ((i as unknown as { partPaths: string[] }).partPaths = [])],
    ['paths not array', (i) => ((i as { partPaths: unknown }).partPaths = 'x')],
    ['datasets not array', (i) => ((i as { datasets: unknown }).datasets = 'x')],
    ['no datasets', (i) => ((i as unknown as { datasets: unknown[] }).datasets = [])],
    ['negative now', (i) => (i.nowMs = -1)],
    ['fractional now', (i) => (i.nowMs = 1.5)],
    ['zero max age', (i) => (i.maxSnapshotAgeMs = 0)],
    ['fractional max age', (i) => (i.maxSnapshotAgeMs = 1.5)],
    ['non-string passphrase', (i) => ((i as { passphrase: unknown }).passphrase = 5)],
    ['bad receipt size', (i) => (i.receipt.parts[0].size = 0)],
    ['wrong receipt size', (i) => (i.receipt.parts[0].size += 1)],
    ['bad receipt sha', (i) => (i.receipt.parts[0].sha256 = 'g'.repeat(64))],
    ['wrong receipt sha', (i) => (i.receipt.parts[0].sha256 = 'f'.repeat(64))],
    ['wrong snapshot id', (i) => (i.receipt.snapshotId = 'other')],
    ['wrong inventory digest', (i) => (i.receipt.inventoryDigestSha256 = 'b'.repeat(64))],
  ];
  it.each(mutate)('rejects %s', async (_name, fn) => {
    const input = await files(small);
    fn(input);
    await expect(openVerifiedTenantBackupV2(input)).rejects.toThrow(new Error(INVALID));
  });

  it('rejects an artifact with a bad magic', async () => {
    const bad = { ...small, artifact: small.artifact.slice() };
    bad.artifact[0] ^= 1;
    await expect(openVerifiedTenantBackupV2(await files(bad))).rejects.toThrow(INVALID);
  });

  it('rejects an artifact smaller than header plus footer', async () => {
    const tiny = { ...small, artifact: small.artifact.slice(0, 130) };
    await expect(openVerifiedTenantBackupV2(await files(tiny))).rejects.toThrow(INVALID);
  });

  it('rejects an already-aborted signal', async () => {
    const input = await files(small);
    const controller = new AbortController();
    controller.abort();
    await expect(
      openVerifiedTenantBackupV2({ ...input, signal: controller.signal })
    ).rejects.toThrow(INVALID);
  });

  it('rejects reads after the signal aborts', async () => {
    const input = await files(small);
    const controller = new AbortController();
    const verified = await openVerifiedTenantBackupV2({ ...input, signal: controller.signal });
    controller.abort();
    await expect(verified.dataset(DATASET.id).readNextRow(null)).rejects.toThrow(INVALID);
  });
});

describe('snapshot freshness boundaries', () => {
  it('accepts nowMs 0 with a boundary inside the future skew window', async () => {
    const built = await build([rowLine('a')], 1000);
    const input = { ...(await files(built)), nowMs: 0 };
    await expect(readAll(input)).resolves.toEqual(['a']);
  });
  it('accepts a boundary exactly 5 minutes in the future and rejects 1 ms more', async () => {
    const ok = await build([rowLine('a')], NOW + 300_000);
    await expect(readAll(await files(ok))).resolves.toEqual(['a']);
    const bad = await build([rowLine('a')], NOW + 300_001);
    await expect(readAll(await files(bad))).rejects.toThrow(INVALID);
  });
  it('accepts age exactly at the maximum and rejects 1 ms older', async () => {
    const ok = await build([rowLine('a')], NOW - 3_600_000);
    await expect(readAll(await files(ok))).resolves.toEqual(['a']);
    const bad = await build([rowLine('a')], NOW - 3_600_001);
    await expect(readAll(await files(bad))).rejects.toThrow(INVALID);
  });
  it('uses the wall clock when nowMs is omitted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW);
      const input = await files(small);
      delete input.nowMs;
      await expect(readAll(input)).resolves.toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('partial reads', () => {
  it.each([1, 7])('reassembles the artifact from reads capped at %i byte(s)', async (cap) => {
    ctl.readCap = cap;
    const input = await files(small, [50, 140]);
    await expect(readAll(input)).resolves.toEqual(['a', 'b']);
  });
  it('fails when a read returns no data', async () => {
    ctl.readCap = 0;
    await expect(openVerifiedTenantBackupV2(await files(small))).rejects.toThrow(INVALID);
  });
});

describe('pinned file tampering', () => {
  async function scenario(): Promise<'ok' | 'rejected'> {
    const input = await files(small, [60, 150]);
    ctl.watched = [...input.partPaths];
    ctl.counter = 0;
    try {
      const verified = await openVerifiedTenantBackupV2(input);
      const dataset = verified.dataset(DATASET.id);
      const first = await dataset.readNextRow(null);
      const second = await dataset.readNextRow(first!.nextCursor);
      expect(await dataset.readNextRow(second!.nextCursor)).toBeNull();
      await verified.close();
      return 'ok';
    } catch (error) {
      expect((error as Error).message).toBe(INVALID);
      return 'rejected';
    }
  }

  it('rejects when any single stat observation of a part changes', async () => {
    ctl.tamperAt = 0;
    expect(await scenario()).toBe('ok');
    const total = ctl.counter;
    expect(total).toBeGreaterThan(20);
    for (let k = 1; k <= total; k++) {
      ctl.tamperAt = k;
      expect(await scenario(), `tampered observation ${k}/${total}`).toBe('rejected');
    }
    ctl.tamperAt = total + 1;
    expect(await scenario()).toBe('ok');
  }, 60_000);
});

describe('multi-frame artifacts', () => {
  it('locates rows across several data frames', async () => {
    const pad = 'x'.repeat(1024 * 1024 - 120);
    const lines = Array.from({ length: 28 }, (_v, i) => rowLine(`r${i}`, pad));
    const built = await build(lines);
    const input = await files(built, [10_000_000, 20_000_000]);
    const ids = await readAll(input);
    expect(ids).toEqual(lines.map((_l, i) => `r${i}`));
  }, 60_000);
});
