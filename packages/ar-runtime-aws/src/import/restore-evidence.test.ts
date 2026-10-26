import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import {
  canonicalRestoreJson,
  readPinnedRestoreFile,
  readVerifiedAwsSamlSupplement,
  restoreEvidenceDigest,
} from './restore-evidence';

const paths: string[] = [];
const manifest = {
  source: {
    tenantId: 'tenant-a',
    issuer: 'https://tenant-a.example.test',
    productVersion: '0.4.2',
  },
  bundleId: 'a'.repeat(32),
  snapshotId: 'snapshot-a',
  inventoryDigestSha256: 'b'.repeat(64),
} as TenantBundleManifest;

async function file(raw: string) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-supplement-'));
  paths.push(directory);
  const path = join(directory, 'supplement.json');
  await writeFile(path, raw, { mode: 0o600 });
  return { path, expectedSha256: createHash('sha256').update(raw).digest('hex'), manifest };
}

function envelope(payload: Record<string, unknown> = { consentIpSalt: 'test-only-salt' }) {
  return {
    formatVersion: 1,
    receipt: {
      tenantId: manifest.source.tenantId,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: restoreEvidenceDigest(payload),
    },
    payload,
  };
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('pins the complete file and separate canonical payload to the exact source snapshot', async () => {
  const value = envelope();
  const input = await file(canonicalRestoreJson(value));
  expect(await readVerifiedAwsSamlSupplement(input)).toEqual({
    ...value.payload,
    receipt: value.receipt,
  });
  await expect(
    readVerifiedAwsSamlSupplement({ ...input, expectedSha256: '0'.repeat(64) })
  ).rejects.toThrow('aws_restore_evidence_invalid');
  await expect(
    readVerifiedAwsSamlSupplement({ ...input, manifest: { ...manifest, snapshotId: 'older' } })
  ).rejects.toThrow('aws_restore_evidence_invalid');
  await expect(
    readVerifiedAwsSamlSupplement({
      ...input,
      manifest: { ...manifest, source: { ...manifest.source, tenantId: 'tenant-b' } },
    })
  ).rejects.toThrow('aws_restore_evidence_invalid');
});

it('refuses altered payload, ambiguous JSON, and attempts to override the verified receipt', async () => {
  const value = envelope();
  value.payload.consentIpSalt = 'altered-secret-must-not-appear-in-errors';
  await expect(
    readVerifiedAwsSamlSupplement(await file(canonicalRestoreJson(value)))
  ).rejects.toThrow(/^aws_restore_evidence_invalid$/u);
  const canonical = canonicalRestoreJson(envelope());
  await expect(readVerifiedAwsSamlSupplement(await file(`${canonical}\n`))).rejects.toThrow(
    'aws_restore_evidence_invalid'
  );
  await expect(
    readVerifiedAwsSamlSupplement(
      await file(canonical.replace('"formatVersion":1', '"formatVersion":2,"formatVersion":1'))
    )
  ).rejects.toThrow('aws_restore_evidence_invalid');
  await expect(
    readVerifiedAwsSamlSupplement(
      await file(canonicalRestoreJson(envelope({ receipt: { tenantId: 'other' } })))
    )
  ).rejects.toThrow('aws_restore_evidence_invalid');
});

it('refuses symbolic links and oversized files without exposing the path', async () => {
  const input = await file('private-data');
  const alias = join(paths[0], 'alias');
  await symlink(input.path, alias);
  await expect(readPinnedRestoreFile(alias, input.expectedSha256)).rejects.toThrow(
    /^aws_restore_evidence_invalid$/u
  );
  await expect(readPinnedRestoreFile(input.path, input.expectedSha256, 4)).rejects.toThrow(
    'aws_restore_evidence_invalid'
  );
});
