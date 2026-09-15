import { exportJWK, generateKeyPair } from 'jose';
import { expect, it, vi } from 'vitest';
import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
  exportPortableUpstreamProviderSecretsRow,
  portableUpstreamProviderSecrets,
  restorePortableUpstreamProviderSecrets,
  verifyPortableUpstreamProviderSecrets,
} from '../portable-upstream-provider-secrets';

const sourceKey = '92c6d2037e6f92a64f73397a72525a3d9987bb8143c782f084b61ebca2ba26b9';
const targetKey = '9eb901d53332850a579baa6d79739e8e79fa296c320274c42e7b9cc56836b12f';

function row(input: {
  client: readonly [string, string | null];
  privateJwk: readonly [string, string | null];
  publicJwk: readonly [string, string | null];
}) {
  return JSON.stringify({
    id: ['text', 'provider-a'],
    tenant_id: ['text', 'tenant-a'],
    client_secret_encrypted: input.client,
    private_key_jwk_encrypted: input.privateJwk,
    public_key_jwk: input.publicJwk,
  });
}

async function keyPair() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return {
    privateJwk: JSON.stringify(await exportJWK(pair.privateKey)),
    publicJwk: JSON.stringify(await exportJWK(pair.publicKey)),
  };
}

it('exports both upstream provider secrets as typed values and re-encrypts with the target key', async () => {
  const pair = await keyPair();
  const sourceClient = await encryptUpstreamProviderSecret('provider-secret', sourceKey);
  const sourcePrivate = await encryptUpstreamProviderSecret(pair.privateJwk, sourceKey);
  const portableRow = await exportPortableUpstreamProviderSecretsRow(
    row({
      client: ['text', sourceClient],
      privateJwk: ['text', sourcePrivate],
      publicJwk: ['text', pair.publicJwk],
    }),
    sourceKey
  );
  expect(portableRow).not.toContain(sourceClient);
  expect(portableRow).not.toContain(sourcePrivate);
  const decoded = await portableUpstreamProviderSecrets(JSON.parse(portableRow));
  expect(decoded).toEqual({
    tenantId: 'tenant-a',
    providerId: 'provider-a',
    clientSecret: 'provider-secret',
    privateJwk: pair.privateJwk,
  });

  const targetClient = await encryptUpstreamProviderSecret(decoded.clientSecret!, targetKey);
  expect(await decryptUpstreamProviderSecret(targetClient, targetKey)).toBe('provider-secret');
  await expect(decryptUpstreamProviderSecret(targetClient, sourceKey)).rejects.toThrow(
    'backup_portable_upstream_provider_secret_invalid'
  );
});

it('uses fenced sidecar writes for both secret fields and verifies the target ciphertext', async () => {
  const pair = await keyPair();
  const rowJson = await exportPortableUpstreamProviderSecretsRow(
    row({
      client: ['text', await encryptUpstreamProviderSecret('provider-secret', sourceKey)],
      privateJwk: ['text', await encryptUpstreamProviderSecret(pair.privateJwk, sourceKey)],
      publicJwk: ['text', pair.publicJwk],
    }),
    sourceKey
  );
  const stored = new Map<string, string | null>([
    ['client_secret_encrypted', ''],
    ['private_key_jwk_encrypted', null],
  ]);
  const target = {
    writeSidecarText: vi.fn(async (...args: unknown[]) => {
      const field = args[3] as string;
      const value = args[4] as string;
      const matches = args[5] as (stored: string) => Promise<boolean>;
      expect(await matches(value)).toBe(true);
      stored.set(field, value);
    }),
    verifySidecarValue: vi.fn(async (...args: unknown[]) => {
      const field = args[3] as string;
      const matches = args[4] as (stored: string | null) => Promise<boolean>;
      expect(await matches(stored.get(field) ?? null)).toBe(true);
    }),
  };
  const shared = { target: target as never, policy: {} as never, manifest: {} as never, rowJson };
  await restorePortableUpstreamProviderSecrets({ ...shared, targetEncryptionKey: targetKey });
  expect(
    await decryptUpstreamProviderSecret(stored.get('client_secret_encrypted')!, targetKey)
  ).toBe('provider-secret');
  expect(
    await decryptUpstreamProviderSecret(stored.get('private_key_jwk_encrypted')!, targetKey)
  ).toBe(pair.privateJwk);
  await verifyPortableUpstreamProviderSecrets({ ...shared, targetEncryptionKey: targetKey });
});

it('preserves empty client and absent private key without requiring an environment key', async () => {
  const portableRow = await exportPortableUpstreamProviderSecretsRow(
    row({ client: ['text', ''], privateJwk: ['null', null], publicJwk: ['null', null] }),
    undefined
  );
  expect(await portableUpstreamProviderSecrets(JSON.parse(portableRow))).toMatchObject({
    clientSecret: null,
    privateJwk: null,
  });
  const target = {
    writeSidecarText: vi.fn(),
    verifySidecarValue: vi.fn(async (...args: unknown[]) => {
      const field = args[3] as string;
      const matches = args[4] as (stored: string | null) => Promise<boolean>;
      expect(await matches(field === 'client_secret_encrypted' ? '' : null)).toBe(true);
    }),
  };
  await restorePortableUpstreamProviderSecrets({
    target: target as never,
    policy: {} as never,
    manifest: {} as never,
    rowJson: portableRow,
    targetEncryptionKey: undefined,
  });
  expect(target.writeSidecarText).not.toHaveBeenCalled();
});

it('rejects wrong source keys, untyped values, and a private JWK that does not match public JWK', async () => {
  const first = await keyPair();
  const second = await keyPair();
  const encrypted = await encryptUpstreamProviderSecret('provider-secret', sourceKey);
  await expect(
    exportPortableUpstreamProviderSecretsRow(
      row({ client: ['text', encrypted], privateJwk: ['null', null], publicJwk: ['null', null] }),
      targetKey
    )
  ).rejects.toThrow('backup_portable_upstream_provider_secret_invalid');
  await expect(
    portableUpstreamProviderSecrets(
      JSON.parse(
        row({ client: ['text', '{}'], privateJwk: ['text', '{}'], publicJwk: ['null', null] })
      )
    )
  ).rejects.toThrow('backup_portable_upstream_provider_secret_invalid');
  await expect(
    exportPortableUpstreamProviderSecretsRow(
      row({
        client: ['text', ''],
        privateJwk: ['text', await encryptUpstreamProviderSecret(first.privateJwk, sourceKey)],
        publicJwk: ['text', second.publicJwk],
      }),
      sourceKey
    )
  ).rejects.toThrow('backup_portable_upstream_provider_secret_invalid');
});
