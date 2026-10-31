import { describe, expect, it, vi } from 'vitest';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption.js';
import {
  exportPortableOperationalLogDetailRow,
  portableOperationalLogDetail,
  restorePortableOperationalLogDetail,
  verifyPortableOperationalLogDetail,
} from '../portable-operational-log-detail.js';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const policy = { dataset: { id: 'core.operational_logs' } } as never;
const manifest = { source: { tenantId: 'tenant-a' } } as never;

describe('portable operational log detail', () => {
  it('re-encrypts inline details and changes the target key version', async () => {
    const encrypted = await encryptValue('support reason', sourceKey, 'AES-256-GCM', 3);
    const source = JSON.stringify({
      id: ['text', 'log-a'],
      tenant_id: ['text', 'tenant-a'],
      reason_detail_encrypted: ['text', encrypted.encrypted],
      encryption_key_version: ['integer', '3'],
      detail_object_catalog_id: ['null', null],
    });
    const rowJson = await exportPortableOperationalLogDetailRow(source, sourceKey);
    expect(portableOperationalLogDetail(JSON.parse(rowJson))).toMatchObject({
      mode: 'inline',
      plaintext: 'support reason',
      sourceKeyVersion: 3,
    });

    let storedDetail = '';
    let storedVersion = '0';
    const target = {
      writeSidecarText: vi.fn(async (_p, _m, _r, _column, value, matches) => {
        storedDetail = value;
        expect(await matches(value)).toBe(true);
      }),
      writeSidecarValue: vi.fn(async (_p, _m, _r, _column, value, matches) => {
        storedVersion = value[1];
        expect(await matches(value)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (_p, _m, _r, _column, matches) => {
        expect(await matches(storedDetail)).toBe(true);
      }),
      verifySidecarTypedValue: vi.fn(async (_p, _m, _r, _column, matches) => {
        expect(await matches(['integer', storedVersion])).toBe(true);
      }),
    } as never;
    await restorePortableOperationalLogDetail({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
      targetKeyVersion: 7,
    });
    expect((await decryptValue(storedDetail, targetKey)).decrypted).toBe('support reason');
    expect(storedVersion).toBe('7');
    await verifyPortableOperationalLogDetail({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
      targetKeyVersion: 7,
    });
  });

  it('preserves the version-zero contract for an R2-backed detail', async () => {
    const rowJson = JSON.stringify({
      id: ['text', 'log-r2'],
      tenant_id: ['text', 'tenant-a'],
      reason_detail_encrypted: ['null', null],
      encryption_key_version: ['integer', '0'],
      detail_object_catalog_id: ['text', 'catalog-a'],
    });
    await expect(exportPortableOperationalLogDetailRow(rowJson, undefined)).resolves.toBe(rowJson);
    const verifySidecarValue = vi.fn(async (_p, _m, _r, _column, matches) => {
      expect(await matches(null)).toBe(true);
    });
    const verifySidecarTypedValue = vi.fn(async (_p, _m, _r, _column, matches) => {
      expect(await matches(['integer', '0'])).toBe(true);
    });
    await restorePortableOperationalLogDetail({
      target: { verifySidecarValue, verifySidecarTypedValue } as never,
      policy,
      manifest,
      rowJson,
      targetKey: undefined,
      targetKeyVersion: 1,
    });
    expect(verifySidecarValue).toHaveBeenCalledOnce();
    expect(verifySidecarTypedValue).toHaveBeenCalledOnce();
  });

  it('rejects plaintext and inconsistent inline/external metadata', async () => {
    await expect(
      exportPortableOperationalLogDetailRow(
        JSON.stringify({
          id: ['text', 'log-a'],
          tenant_id: ['text', 'tenant-a'],
          reason_detail_encrypted: ['text', 'plaintext'],
          encryption_key_version: ['integer', '1'],
          detail_object_catalog_id: ['null', null],
        }),
        sourceKey
      )
    ).rejects.toThrow('backup_portable_operational_log_detail_invalid');
    await expect(
      exportPortableOperationalLogDetailRow(
        JSON.stringify({
          id: ['text', 'log-a'],
          tenant_id: ['text', 'tenant-a'],
          reason_detail_encrypted: ['null', null],
          encryption_key_version: ['integer', '0'],
          detail_object_catalog_id: ['null', null],
        }),
        undefined
      )
    ).rejects.toThrow('backup_portable_operational_log_detail_invalid');
  });
});
