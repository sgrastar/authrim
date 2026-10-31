import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
  portableUpstreamProviderSecrets,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import { expect, it } from 'vitest';
import {
  createPhase4TenantBackupRowTransform,
  PHASE4_TRANSFORMED_SQLITE_DATASETS,
} from '../tenant-backup-phase4-row-transform';

const sourceKey = '92c6d2037e6f92a64f73397a72525a3d9987bb8143c782f084b61ebca2ba26b9';

it('pins both cumulative encrypted SQL datasets to the installed transform', async () => {
  expect(PHASE4_TRANSFORMED_SQLITE_DATASETS).toEqual([
    'core.oauth_clients',
    'core.upstream_providers',
  ]);
  const transform = createPhase4TenantBackupRowTransform({ RP_TOKEN_ENCRYPTION_KEY: sourceKey });
  const encrypted = await encryptUpstreamProviderSecret('provider-secret', sourceKey);
  const rowJson = await transform({
    datasetId: 'core.upstream_providers',
    rowJson: JSON.stringify({
      id: ['text', 'provider-a'],
      tenant_id: ['text', 'tenant-a'],
      client_secret_encrypted: ['text', encrypted],
      private_key_jwk_encrypted: ['null', null],
      public_key_jwk: ['null', null],
    }),
  } as never);
  expect(rowJson).not.toContain(encrypted);
  expect(await portableUpstreamProviderSecrets(JSON.parse(rowJson))).toMatchObject({
    clientSecret: 'provider-secret',
    privateJwk: null,
  });
  await expect(decryptUpstreamProviderSecret(encrypted, sourceKey)).resolves.toBe(
    'provider-secret'
  );
});

it('rejects datasets outside the installed transform set', async () => {
  const transform = createPhase4TenantBackupRowTransform({ RP_TOKEN_ENCRYPTION_KEY: sourceKey });
  await expect(transform({ datasetId: 'core.tenants', rowJson: '{}' } as never)).rejects.toThrow(
    'backup_phase4_row_transform_dataset'
  );
});
