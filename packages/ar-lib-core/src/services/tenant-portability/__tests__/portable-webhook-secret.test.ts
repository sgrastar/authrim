import { describe, expect, it, vi } from 'vitest';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption.js';
import {
  exportPortableWebhookSecretRow,
  portableWebhookSecret,
  restorePortableWebhookSecret,
  verifyPortableWebhookSecret,
} from '../portable-webhook-secret.js';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const manifest = { source: { tenantId: 'tenant-a' } } as never;
const policy = { dataset: { id: 'core.webhook_configs' } } as never;

describe('portable webhook signing secret', () => {
  it('decrypts source ciphertext and re-encrypts it with the target key', async () => {
    const encrypted = await encryptValue('signing-secret', sourceKey, 'AES-256-GCM', 3);
    const source = JSON.stringify({
      id: ['text', 'webhook-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', encrypted.encrypted],
    });
    const portableRow = await exportPortableWebhookSecretRow(source, sourceKey);
    expect(portableWebhookSecret(JSON.parse(portableRow)).plaintext).toBe('signing-secret');

    let stored: string | null = null;
    const target = {
      writeSidecarText: vi.fn(async (_p, _m, _r, _field, value, check) => {
        stored = value;
        expect(await check(value)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (_p, _m, _r, _field, check) => {
        expect(await check(stored)).toBe(true);
      }),
    } as never;
    await restorePortableWebhookSecret({
      target,
      policy,
      manifest,
      rowJson: portableRow,
      targetKey,
      targetKeyVersion: 7,
    });
    expect((await decryptValue(stored!, targetKey)).decrypted).toBe('signing-secret');
    await verifyPortableWebhookSecret({
      target,
      policy,
      manifest,
      rowJson: portableRow,
      targetKey,
      targetKeyVersion: 7,
    });
  });

  it('rejects plaintext source values and wrong source keys', async () => {
    const plaintext = JSON.stringify({
      id: ['text', 'webhook-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', 'must-not-pass'],
    });
    await expect(exportPortableWebhookSecretRow(plaintext, sourceKey)).rejects.toThrow(
      'backup_portable_webhook_secret_invalid'
    );
    const encrypted = await encryptValue('secret', sourceKey, 'AES-256-GCM', 1);
    await expect(
      exportPortableWebhookSecretRow(
        JSON.stringify({
          id: ['text', 'webhook-a'],
          tenant_id: ['text', 'tenant-a'],
          secret_encrypted: ['text', encrypted.encrypted],
        }),
        targetKey
      )
    ).rejects.toThrow('backup_portable_webhook_secret_invalid');
  });
});
