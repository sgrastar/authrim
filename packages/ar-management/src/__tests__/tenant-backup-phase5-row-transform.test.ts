import { describe, expect, it, vi } from 'vitest';
import { encryptValue } from '@authrim/ar-lib-core';
import { portableWebhookSecret } from '@authrim/ar-lib-core/services/tenant-portability/portable-webhook-secret';
import {
  createPhase5TenantBackupRowTransform,
  PHASE5_TRANSFORMED_SQLITE_DATASETS,
} from '../tenant-backup-phase5-row-transform';

describe('Phase 5 row transform', () => {
  it('keeps all earlier transforms and handles webhook/admin secrets explicitly', async () => {
    expect(PHASE5_TRANSFORMED_SQLITE_DATASETS).toEqual([
      'core.oauth_clients',
      'core.upstream_providers',
      'admin.credential_secret_bodies',
      'admin.logging_key_material_bodies',
      'core.webhook_configs',
    ]);
    const key = '11'.repeat(32);
    const secret = await encryptValue('webhook-secret', key, 'AES-256-GCM', 1);
    const transformAdminEnvelope = vi.fn().mockResolvedValue('portable-admin-row');
    const transform = createPhase5TenantBackupRowTransform(
      { PII_ENCRYPTION_KEY: key },
      { transformAdminEnvelope }
    );
    const transformed = await transform({
      datasetId: 'core.webhook_configs',
      rowJson: JSON.stringify({
        id: ['text', 'webhook-a'],
        tenant_id: ['text', 'tenant-a'],
        secret_encrypted: ['text', secret.encrypted],
      }),
    } as never);
    expect(portableWebhookSecret(JSON.parse(transformed)).plaintext).toBe('webhook-secret');
    await expect(
      transform({ datasetId: 'admin.credential_secret_bodies', rowJson: '{}' } as never)
    ).resolves.toBe('portable-admin-row');
    expect(transformAdminEnvelope).toHaveBeenCalledWith('admin.credential_secret_bodies', '{}');
  });
});
