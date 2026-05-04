import { describe, expect, it } from 'vitest';
import { decryptObjectArtifact, encryptObjectArtifact } from '../object-artifact-crypto';

const ROOT_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('object-artifact-crypto', () => {
  it('encrypts and decrypts export artifacts with AAD-bound context', async () => {
    const envelope = await encryptObjectArtifact('{"ok":true}', {
      rootKeyHex: ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: 'exports/tenant-a/data-export/export-1/result.json',
        objectClass: 'user_export',
      },
    });

    expect(envelope.plane).toBe('EXPORT_ARTIFACTS');
    expect(envelope.objectClass).toBe('user_export');
    expect(envelope.contentType).toBe('application/json');

    const decrypted = await decryptObjectArtifact(envelope, {
      rootKeyHex: ROOT_KEY,
      context: {
        tenantId: 'tenant-a',
        objectKey: 'exports/tenant-a/data-export/export-1/result.json',
        objectClass: 'user_export',
      },
    });

    expect(decrypted).toBe('{"ok":true}');
  });

  it('fails decryption when bound context does not match', async () => {
    const envelope = await encryptObjectArtifact('secret', {
      rootKeyHex: ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId: 'tenant-a',
        objectKey: 'sensitive/tenant-a/detail-1.json',
        objectClass: 'admin_audit_detail',
      },
    });

    await expect(
      decryptObjectArtifact(envelope, {
        rootKeyHex: ROOT_KEY,
        context: {
          tenantId: 'tenant-b',
          objectKey: 'sensitive/tenant-a/detail-1.json',
          objectClass: 'admin_audit_detail',
        },
      })
    ).rejects.toThrow();
  });
});
