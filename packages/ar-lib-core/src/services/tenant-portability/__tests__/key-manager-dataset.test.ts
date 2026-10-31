import { expect, it } from 'vitest';
import {
  createKeyManagerTenantBackupInspectionPolicy,
  decodeKeyManagerTenantBackupRow,
  encodeKeyManagerTenantBackupRow,
  KEY_MANAGER_TENANT_BACKUP_DATASET,
} from '../key-manager-dataset';
import { emptyKeyManagerTenantBackupSnapshot } from '../key-manager-portability';

it('encodes one tenant-owned KeyManager snapshot as an encrypted-bundle NDJSON record', async () => {
  const snapshot = emptyKeyManagerTenantBackupSnapshot();
  const bytes = await encodeKeyManagerTenantBackupRow('tenant-a', snapshot);
  const rowJson = new TextDecoder().decode(bytes).trimEnd();

  await expect(decodeKeyManagerTenantBackupRow(rowJson, 'tenant-a')).resolves.toEqual(snapshot);
  await expect(decodeKeyManagerTenantBackupRow(rowJson, 'tenant-b')).rejects.toThrow(
    'backup_key_manager_dataset_invalid'
  );
  expect(KEY_MANAGER_TENANT_BACKUP_DATASET.store).toBe('durable_object');
});

it('uses an installed policy to reject malformed snapshots before restore', async () => {
  const policy = createKeyManagerTenantBackupInspectionPolicy();
  const row = {
    tenant_id: ['text', 'tenant-a'] as const,
    snapshot_json: ['text', JSON.stringify({ kind: 'wrong' })] as const,
  };
  await expect(policy.inspectRow(row, {} as never)).rejects.toThrow(
    'backup_key_manager_dataset_invalid'
  );
});
