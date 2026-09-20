import { expect, it } from 'vitest';
import { encryptValue } from '@authrim/ar-lib-core';
import { portableOauthClientSecret } from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { createPhase3TenantBackupRowTransform } from '../tenant-backup-phase3-row-transform';

it('uses the installed RP key and rejects any other dataset', async () => {
  const key = '11'.repeat(32);
  const secret = await encryptValue('secret', key, 'AES-256-GCM', 1);
  const transform = createPhase3TenantBackupRowTransform({ RP_TOKEN_ENCRYPTION_KEY: key });
  const rowJson = JSON.stringify({
    tenant_id: ['text', 'tenant-a'],
    client_id: ['text', 'client-a'],
    logout_webhook_secret_encrypted: ['text', secret.encrypted],
  });
  const transformed = await transform({
    datasetId: 'core.oauth_clients',
    rowJson,
  } as never);
  expect(portableOauthClientSecret(JSON.parse(transformed) as PortableSqliteRow).plaintext).toBe(
    'secret'
  );
  await expect(transform({ datasetId: 'core.roles', rowJson } as never)).rejects.toThrow(
    'backup_phase3_row_transform_dataset'
  );
});
