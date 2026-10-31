import { describe, expect, it, vi } from 'vitest';
import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  unwrapLoggingKeyMaterial,
  wrapLoggingKeyMaterial,
  type EncryptedCredentialSecretEnvelope,
  type WrappedLoggingKeyMaterialEnvelope,
} from '@authrim/ar-lib-logging/keys';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { createTenantBackupAdminEnvelopePorts } from '../tenant-backup-admin-envelope-port';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const text = (value: string) => ['text', value] as const;
const integer = (value: number) => ['integer', String(value)] as const;

function source(target: Record<string, unknown>) {
  return {
    policy: { dataset: { id: 'fixture' } },
    manifest: {},
    target,
  } as never;
}

function parsed<T>(value: string): T {
  return JSON.parse(value) as unknown as T;
}

describe('tenant backup Admin envelope portability', () => {
  it('decrypts a credential body only inside the bundle and re-encrypts it for the target', async () => {
    const identity = {
      credentialRef: 'd1secret://admin/credential_secrets/destination-a/v3?version=3',
      destinationId: 'destination-a',
      version: 3,
    };
    const encrypted = await encryptCredentialSecret('destination-secret', {
      rootKeyHex: sourceKey,
      backend: 'd1_encrypted_table',
      keyVersion: 4,
      contentType: 'application/json',
      ...identity,
    });
    const sourceRow = JSON.stringify({
      credential_ref: text(identity.credentialRef),
      destination_id: text(identity.destinationId),
      version: integer(identity.version),
      envelope_json: text(JSON.stringify(encrypted)),
      created_at: integer(1),
      updated_at: integer(1),
    });
    const sourcePorts = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: sourceKey,
      OBJECT_ENCRYPTION_KEY_VERSION: '4',
    });
    const portableRow = await sourcePorts.transformAdminEnvelope(
      'admin.credential_secret_bodies',
      sourceRow
    );
    expect(portableRow).not.toContain(encrypted.ciphertext);
    expect(portableRow).not.toContain('destination-secret');
    await expect(
      sourcePorts.validateAdminEnvelope(
        'admin.credential_secret_bodies',
        parsed<PortableSqliteRow>(portableRow)
      )
    ).resolves.toBeUndefined();

    let targetEnvelope = '';
    const target = {
      writeSidecarText: vi.fn(async (...args: unknown[]) => {
        targetEnvelope = args[4] as string;
        expect(await (args[5] as (value: string) => Promise<boolean>)(targetEnvelope)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (...args: unknown[]) => {
        expect(await (args[4] as (value: string) => Promise<boolean>)(targetEnvelope)).toBe(true);
      }),
    };
    const targetPorts = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: targetKey,
      OBJECT_ENCRYPTION_KEY_VERSION: '9',
    });
    await targetPorts.restoreAdminEnvelope(
      {},
      'admin.credential_secret_bodies',
      source(target),
      portableRow
    );
    await expect(
      targetPorts.verifyAdminEnvelope(
        {},
        'admin.credential_secret_bodies',
        source(target),
        portableRow
      )
    ).resolves.toBe(true);
    const restored = parsed<EncryptedCredentialSecretEnvelope>(targetEnvelope);
    expect(restored.keyVersion).toBe(9);
    await expect(
      decryptCredentialSecret(restored, { rootKeyHex: targetKey, ...identity })
    ).resolves.toBe('destination-secret');
    await expect(
      decryptCredentialSecret(restored, { rootKeyHex: sourceKey, ...identity })
    ).rejects.toThrow();
  });

  it('rewraps logging key material and rejects a source key mismatch', async () => {
    const identity = {
      backendRef: 'd1key://admin/scope-a/v5/key-a',
      scopeId: 'scope-a',
      version: 5,
    };
    const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const encrypted = await wrapLoggingKeyMaterial(
      { algorithm: 'AES-GCM', keyBytes },
      {
        rootKeyHex: sourceKey,
        backend: 'd1_wrapped_key',
        keyVersion: 2,
        ...identity,
      }
    );
    const sourceRow = JSON.stringify({
      backend_ref: text(identity.backendRef),
      scope_id: text(identity.scopeId),
      tenant_key: text('tenant-key-a'),
      surface: ['null', null],
      log_type: text('audit'),
      plane: text('audit'),
      version: integer(identity.version),
      envelope_json: text(JSON.stringify(encrypted)),
      created_at: integer(1),
      updated_at: integer(1),
    });
    const sourcePorts = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: sourceKey,
    });
    const portableRow = await sourcePorts.transformAdminEnvelope(
      'admin.logging_key_material_bodies',
      sourceRow
    );
    expect(portableRow).not.toContain(encrypted.ciphertext);

    let targetEnvelope = '';
    const target = {
      writeSidecarText: vi.fn(async (...args: unknown[]) => {
        targetEnvelope = args[4] as string;
        expect(await (args[5] as (value: string) => Promise<boolean>)(targetEnvelope)).toBe(true);
      }),
      verifySidecarValue: vi.fn(),
    };
    const targetPorts = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: targetKey,
      OBJECT_ENCRYPTION_KEY_VERSION: '8',
    });
    await targetPorts.restoreAdminEnvelope(
      {},
      'admin.logging_key_material_bodies',
      source(target),
      portableRow
    );
    const restoredEnvelope = parsed<WrappedLoggingKeyMaterialEnvelope>(targetEnvelope);
    const restored = await unwrapLoggingKeyMaterial(restoredEnvelope, {
      rootKeyHex: targetKey,
      ...identity,
    });
    expect([...restored.keyBytes]).toEqual([...keyBytes]);
    expect(restoredEnvelope.keyVersion).toBe(8);

    const wrongSourcePorts = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: targetKey,
    });
    await expect(
      wrongSourcePorts.transformAdminEnvelope('admin.logging_key_material_bodies', sourceRow)
    ).rejects.toThrow('backup_admin_envelope_invalid');
  });

  it('rejects malformed or unexpected portable envelopes before restore', async () => {
    const ports = createTenantBackupAdminEnvelopePorts({
      OBJECT_ENCRYPTION_ROOT_KEY: targetKey,
    });
    await expect(
      ports.validateAdminEnvelope('admin.credential_secret_bodies', {
        credential_ref: text('credential-a'),
        destination_id: text('destination-a'),
        version: integer(1),
        envelope_json: text('{"version":1,"kind":"credential_secret"}'),
      })
    ).rejects.toThrow('backup_admin_envelope_invalid');
    await expect(ports.transformAdminEnvelope('admin.unknown', '{}')).rejects.toThrow(
      'backup_admin_envelope_invalid'
    );
  });
});
