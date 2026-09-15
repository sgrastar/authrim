import { describe, expect, it, vi } from 'vitest';
import {
  arrayBufferToBase64,
  decryptPIIValues,
  generateAAD,
  type EncryptedValueForDecrypt,
} from '../../audit/utils.js';
import {
  exportPortablePiiLogValuesRow,
  portablePiiLogValues,
  restorePortablePiiLogValues,
  verifyPortablePiiLogValues,
} from '../portable-pii-log-values.js';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const policy = { dataset: { id: 'pii.pii_log' } } as never;
const manifest = { source: { tenantId: 'tenant-a' } } as never;

async function cryptoKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    Uint8Array.from(hex.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptedValues(
  keyHex: string,
  keyId: string,
  value: Record<string, unknown>
): Promise<EncryptedValueForDecrypt> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: generateAAD('tenant-a', ['email', 'name']) },
    await cryptoKey(keyHex),
    new TextEncoder().encode(JSON.stringify(value))
  );
  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
    keyId,
  };
}

describe('portable PII log values', () => {
  it('re-encrypts inline audit values with the target key and metadata', async () => {
    const sourceValues = await encryptedValues(sourceKey, 'pii-key-v3', {
      old: { email: 'old@example.test' },
      new: { email: 'new@example.test' },
    });
    const source = JSON.stringify({
      id: ['text', 'log-a'],
      tenant_id: ['text', 'tenant-a'],
      affected_fields: ['text', '["email","name"]'],
      values_r2_key: ['null', null],
      values_encrypted: ['text', JSON.stringify(sourceValues)],
      encryption_key_id: ['text', sourceValues.keyId],
      encryption_iv: ['text', sourceValues.iv],
    });
    const rowJson = await exportPortablePiiLogValuesRow(source, sourceKey);
    const portable = portablePiiLogValues(JSON.parse(rowJson));
    expect(portable).toMatchObject({
      mode: 'inline',
      sourceKeyId: 'pii-key-v3',
    });
    expect(rowJson).not.toContain(sourceValues.ciphertext);

    const stored = new Map<string, readonly ['text', string]>();
    const target = {
      writeSidecarText: vi.fn(async (_p, _m, _r, column, value, matches) => {
        stored.set(column, ['text', value]);
        expect(await matches(value)).toBe(true);
      }),
      writeSidecarValue: vi.fn(async (_p, _m, _r, column, value, matches) => {
        stored.set(column, value);
        expect(await matches(value)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (_p, _m, _r, column, matches) => {
        expect(await matches(stored.get(column)?.[1] ?? null)).toBe(true);
      }),
      verifySidecarTypedValue: vi.fn(async (_p, _m, _r, column, matches) => {
        expect(await matches(stored.get(column) ?? ['null', null])).toBe(true);
      }),
    } as never;
    await expect(
      restorePortablePiiLogValues({
        target,
        policy,
        manifest,
        rowJson,
        targetKey,
        targetKeyVersion: 7,
      })
    ).resolves.toBe('inline');
    const firstCiphertext = stored.get('values_encrypted')?.[1];
    const firstIv = stored.get('encryption_iv')?.[1];
    await expect(
      restorePortablePiiLogValues({
        target,
        policy,
        manifest,
        rowJson,
        targetKey,
        targetKeyVersion: 7,
      })
    ).resolves.toBe('inline');
    expect(stored.get('values_encrypted')?.[1]).toBe(firstCiphertext);
    expect(stored.get('encryption_iv')?.[1]).toBe(firstIv);
    await expect(
      verifyPortablePiiLogValues({
        target,
        policy,
        manifest,
        rowJson,
        targetKey,
        targetKeyVersion: 7,
      })
    ).resolves.toBe('inline');

    const encrypted = JSON.parse(
      stored.get('values_encrypted')?.[1] ?? ''
    ) as EncryptedValueForDecrypt;
    expect(encrypted.keyId).toBe('pii-key-v7');
    await expect(
      decryptPIIValues(encrypted, 'tenant-a', ['email', 'name'], () => cryptoKey(targetKey))
    ).resolves.toEqual({
      old: { email: 'old@example.test' },
      new: { email: 'new@example.test' },
    });
  });

  it('materializes an R2 catalog value into the portable row before source access ends', async () => {
    const sourceValues = await encryptedValues(sourceKey, 'pii-key-v3', {
      old: { email: 'old@example.test' },
      new: { email: 'new@example.test' },
    });
    const rowJson = JSON.stringify({
      id: ['text', 'log-r2'],
      tenant_id: ['text', 'tenant-a'],
      affected_fields: ['text', '["email","name"]'],
      values_r2_key: ['text', 'sensitive-detail-catalog:catalog-a'],
      values_encrypted: ['null', null],
      encryption_key_id: ['text', 'pii-key-v3'],
      encryption_iv: ['text', sourceValues.iv],
    });
    const loadExternal = vi.fn(async () => JSON.stringify(sourceValues));
    const portableRow = await exportPortablePiiLogValuesRow(rowJson, sourceKey, loadExternal);
    expect(loadExternal).toHaveBeenCalledWith('sensitive-detail-catalog:catalog-a');
    expect(portablePiiLogValues(JSON.parse(portableRow))).toMatchObject({
      mode: 'inline',
      plaintext: JSON.stringify({
        old: { email: 'old@example.test' },
        new: { email: 'new@example.test' },
      }),
    });
    expect(JSON.parse(portableRow)).toMatchObject({
      values_r2_key: ['null', null],
    });
    await expect(exportPortablePiiLogValuesRow(rowJson, sourceKey)).rejects.toThrow(
      'backup_portable_pii_log_values_invalid'
    );
  });

  it('rejects plaintext or mismatched encryption metadata', async () => {
    await expect(
      exportPortablePiiLogValuesRow(
        JSON.stringify({
          id: ['text', 'log-a'],
          tenant_id: ['text', 'tenant-a'],
          affected_fields: ['text', '["email"]'],
          values_r2_key: ['null', null],
          values_encrypted: ['text', 'plaintext'],
          encryption_key_id: ['text', 'pii-key-v1'],
          encryption_iv: ['text', 'iv'],
        }),
        sourceKey
      )
    ).rejects.toThrow('backup_portable_pii_log_values_invalid');
  });
});
