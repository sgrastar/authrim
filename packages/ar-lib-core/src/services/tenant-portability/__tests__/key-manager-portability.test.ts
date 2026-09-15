import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import {
  keyManagerTenantBackupSnapshotIsEmpty,
  keyManagerTenantBackupSnapshotsEqual,
  normalizeKeyManagerTenantBackupSnapshot,
  type KeyManagerTenantBackupSnapshot,
  type PortableECAlgorithm,
} from '../key-manager-portability';

const config = { rotationIntervalDays: 90, retentionPeriodDays: 30 };

async function rsa(algorithm: 'RS256' | 'PS256', kid: string) {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  return {
    kid,
    publicJWK: { ...(await exportJWK(pair.publicKey)), kid, use: 'sig', alg: algorithm },
    privatePEM: await exportPKCS8(pair.privateKey),
    createdAt: 100,
    status: 'active' as const,
  };
}

async function ec(algorithm: PortableECAlgorithm, kid: string) {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  const curve = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[algorithm] as
    | 'P-256'
    | 'P-384'
    | 'P-521';
  return {
    kid,
    algorithm,
    curve,
    publicJWK: { ...(await exportJWK(pair.publicKey)), kid, use: 'sig', alg: algorithm },
    privatePEM: await exportPKCS8(pair.privateKey),
    createdAt: 100,
    status: 'active' as const,
  };
}

async function snapshot(): Promise<KeyManagerTenantBackupSnapshot> {
  const rsaKey = await rsa('RS256', 'rsa-a');
  const vcKey = await ec('ES256', 'vc-a');
  const oidcEsKey = await ec('ES256', 'oidc-es-a');
  const oidcPsKey = await rsa('PS256', 'oidc-ps-a');
  return {
    kind: 'authrim.key_manager_tenant_backup.v1',
    version: 1,
    rsa: {
      keys: [rsaKey],
      activeKeyId: rsaKey.kid,
      config,
      lastRotation: 100,
      secrets: {
        'saml:pairwise:tenant-a': {
          secretRef: 'saml:pairwise:tenant-a',
          active: { kid: 'secret-a', value: 'secret-value', createdAt: 100 },
          updatedAt: 100,
        },
      },
    },
    vcEc: {
      keys: [vcKey],
      activeKeyIds: { ES256: vcKey.kid, ES384: null, ES512: null },
      config,
      lastRotation: 100,
    },
    oidcEs256: {
      keys: [oidcEsKey],
      activeKeyId: oidcEsKey.kid,
      config,
      lastRotation: 100,
    },
    oidcPs256: {
      keys: [oidcPsKey],
      activeKeyId: oidcPsKey.kid,
      config,
      lastRotation: 100,
    },
  };
}

it('validates every signing pair, rotation state and managed secret in a tenant snapshot', async () => {
  const source = await snapshot();
  const normalized = await normalizeKeyManagerTenantBackupSnapshot(source);
  expect(keyManagerTenantBackupSnapshotsEqual(source, normalized)).toBe(true);
  expect(keyManagerTenantBackupSnapshotIsEmpty(normalized)).toBe(false);
  expect(normalized.vcEc.activeKeyIds).toEqual({
    ES256: 'vc-a',
    ES384: null,
    ES512: null,
  });
});

it('rejects a mismatched private key and inconsistent active generation', async () => {
  const source = await snapshot();
  const other = await rsa('RS256', 'rsa-a');
  await expect(
    normalizeKeyManagerTenantBackupSnapshot({
      ...source,
      rsa: { ...source.rsa, keys: [{ ...source.rsa.keys[0], privatePEM: other.privatePEM }] },
    })
  ).rejects.toThrow('backup_key_manager_snapshot_invalid');
  await expect(
    normalizeKeyManagerTenantBackupSnapshot({
      ...source,
      oidcEs256: { ...source.oidcEs256, activeKeyId: null },
    })
  ).rejects.toThrow('backup_key_manager_snapshot_invalid');
});

it('rejects unknown version-one fields instead of silently dropping future key state', async () => {
  const source = await snapshot();
  await expect(
    normalizeKeyManagerTenantBackupSnapshot({ ...source, futureKeyState: { active: true } })
  ).rejects.toThrow('backup_key_manager_snapshot_invalid');
  await expect(
    normalizeKeyManagerTenantBackupSnapshot({
      ...source,
      rsa: { ...source.rsa, futureRotationState: 'pending' },
    })
  ).rejects.toThrow('backup_key_manager_snapshot_invalid');
});

it('recognizes an empty initialized target without treating configuration as data', async () => {
  const empty = await normalizeKeyManagerTenantBackupSnapshot({
    kind: 'authrim.key_manager_tenant_backup.v1',
    version: 1,
    rsa: { keys: [], activeKeyId: null, config, lastRotation: null, secrets: {} },
    vcEc: {
      keys: [],
      activeKeyIds: { ES256: null, ES384: null, ES512: null },
      config,
      lastRotation: null,
    },
    oidcEs256: { keys: [], activeKeyId: null, config, lastRotation: null },
    oidcPs256: { keys: [], activeKeyId: null, config, lastRotation: null },
  });
  expect(keyManagerTenantBackupSnapshotIsEmpty(empty)).toBe(true);
});
