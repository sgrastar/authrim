import { describe, expect, it, vi } from 'vitest';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption.js';
import {
  exportPortableTotpSecretRow,
  portableTotpSecret,
  restorePortableTotpSecret,
  verifyPortableTotpSecret,
} from '../portable-totp-secret.js';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const policy = { dataset: { id: 'core.totp_credentials' } } as never;
const manifest = { source: { tenantId: 'tenant-a' } } as never;

describe('portable TOTP secret', () => {
  it('binds the source key version and restores target ciphertext plus its version', async () => {
    const encrypted = await encryptValue('JBSWY3DPEHPK3PXP', sourceKey, 'AES-256-GCM', 3);
    const source = JSON.stringify({
      id: ['text', 'totp-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', encrypted.encrypted],
      secret_key_version: ['integer', '3'],
    });
    const rowJson = await exportPortableTotpSecretRow(source, sourceKey);
    expect(portableTotpSecret(JSON.parse(rowJson))).toMatchObject({
      credentialId: 'totp-a',
      plaintext: 'JBSWY3DPEHPK3PXP',
      sourceKeyVersion: 3,
    });

    let storedSecret = '';
    let storedVersion = '1';
    const target = {
      writeSidecarText: vi.fn(async (_p, _m, _r, _column, value, matches) => {
        storedSecret = value;
        expect(await matches(value)).toBe(true);
      }),
      writeSidecarValue: vi.fn(async (_p, _m, _r, _column, value, matches) => {
        storedVersion = value[1];
        expect(await matches(value)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (_p, _m, _r, _column, matches) => {
        expect(await matches(storedSecret)).toBe(true);
      }),
      verifySidecarTypedValue: vi.fn(async (_p, _m, _r, _column, matches) => {
        expect(await matches(['integer', storedVersion])).toBe(true);
      }),
    } as never;
    await restorePortableTotpSecret({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
      targetKeyVersion: 7,
    });
    expect((await decryptValue(storedSecret, targetKey)).decrypted).toBe('JBSWY3DPEHPK3PXP');
    expect(storedVersion).toBe('7');
    await verifyPortableTotpSecret({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
      targetKeyVersion: 7,
    });
  });

  it('rejects plaintext, wrong keys and mismatched source key versions', async () => {
    const plaintext = JSON.stringify({
      id: ['text', 'totp-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', 'JBSWY3DPEHPK3PXP'],
      secret_key_version: ['integer', '1'],
    });
    await expect(exportPortableTotpSecretRow(plaintext, sourceKey)).rejects.toThrow(
      'backup_portable_totp_secret_invalid'
    );
    const encrypted = await encryptValue('secret', sourceKey, 'AES-256-GCM', 3);
    const source = JSON.stringify({
      id: ['text', 'totp-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', encrypted.encrypted],
      secret_key_version: ['integer', '2'],
    });
    await expect(exportPortableTotpSecretRow(source, sourceKey)).rejects.toThrow(
      'backup_portable_totp_secret_invalid'
    );
    await expect(exportPortableTotpSecretRow(source, targetKey)).rejects.toThrow(
      'backup_portable_totp_secret_invalid'
    );
  });
});
