import { describe, expect, it, vi } from 'vitest';
import { encryptValue } from '@authrim/ar-lib-core/utils/pii-encryption';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { portableTotpSecret } from '@authrim/ar-lib-core/services/tenant-portability/portable-totp-secret';
import {
  createPhase8TenantBackupRowTransform,
  createPhase8TenantBackupRowFilter,
  PHASE8_FILTERED_LOG_DATASETS,
  PHASE8_SENSITIVE_SQLITE_DATASETS,
  PHASE8_TRANSFORMED_SQLITE_DATASETS,
} from '../tenant-backup-phase8-row-transform';

function context(datasetId: string, rowJson: string, boundaryUnixMs?: number) {
  return {
    datasetId,
    rowJson,
    boundaryUnixMs,
    selection: {
      settings: true,
      users: true,
      admin: true,
      artifacts: true,
      logs: { audit: true, other: true, sensitive: true, period: 7 as const },
    },
  } as never;
}

describe('Phase 8 row transform', () => {
  const sourceKey = '11'.repeat(32);
  const transform = createPhase8TenantBackupRowTransform(
    { RP_TOKEN_ENCRYPTION_KEY: '22'.repeat(32), PII_ENCRYPTION_KEY: sourceKey },
    {
      transformAdminEnvelope: vi.fn(),
      loadExternalPiiLogValues: vi.fn(),
    }
  );
  const filter = createPhase8TenantBackupRowFilter();

  it('filters logs against the immutable bundle boundary', async () => {
    const boundary = 100 * 86_400_000;
    const row = (createdAt: number) =>
      JSON.stringify({ id: ['text', 'id'], created_at: ['integer', String(createdAt)] });
    await expect(filter(context('core.audit_log', row(93 * 86_400_000), boundary))).resolves.toBe(
      true
    );
    await expect(
      filter(context('core.audit_log', row(93 * 86_400_000 - 1), boundary))
    ).resolves.toBe(false);
    await expect(filter(context('core.audit_log', row(boundary)))).rejects.toThrow(
      'backup_phase8_log_boundary'
    );
  });

  it('filters mixed log dependency catalogs by category, sensitive permission, and window', async () => {
    const boundary = 100 * 86_400_000;
    const row = (logType: string, plane: string, createdAt: number) =>
      JSON.stringify({
        log_type: ['text', logType],
        plane: ['text', plane],
        created_at: ['integer', String(createdAt)],
      });
    const selected = context(
      'core.log_object_catalog',
      row('audit', 'archive', boundary),
      boundary
    ) as unknown as {
      rowJson: string;
      selection: TenantBackupSelection;
    };
    selected.selection.logs.other = false;
    selected.selection.logs.sensitive = false;
    await expect(filter(selected as never)).resolves.toBe(true);
    await expect(
      filter({ ...selected, rowJson: row('operational', 'archive', boundary) } as never)
    ).resolves.toBe(false);
    await expect(
      filter({ ...selected, rowJson: row('audit', 'sensitive_detail', boundary) } as never)
    ).resolves.toBe(false);
    await expect(
      filter({
        ...selected,
        rowJson: row('audit', 'archive', 93 * 86_400_000 - 1),
      } as never)
    ).resolves.toBe(false);

    const sensitive = context(
      'admin.sensitive_detail_chunk_index',
      JSON.stringify({
        object_class: ['text', 'admin_audit_detail'],
        created_at: ['integer', String(boundary)],
      }),
      boundary
    ) as unknown as { selection: TenantBackupSelection };
    sensitive.selection.logs.other = false;
    sensitive.selection.logs.sensitive = true;
    await expect(filter(sensitive as never)).resolves.toBe(true);
    sensitive.selection.logs.audit = false;
    await expect(filter(sensitive as never)).resolves.toBe(false);
  });

  it('uses the installed TOTP codec and scrubs held delivery ciphertext', async () => {
    const encrypted = await encryptValue('JBSWY3DPEHPK3PXP', sourceKey, 'AES-256-GCM', 3);
    const totp = JSON.stringify({
      id: ['text', 'totp-a'],
      tenant_id: ['text', 'tenant-a'],
      secret_encrypted: ['text', encrypted.encrypted],
      secret_key_version: ['integer', '3'],
    });
    const portable = await transform(context('core.totp_credentials', totp, 10));
    expect(portableTotpSecret(JSON.parse(portable) as unknown as PortableSqliteRow).plaintext).toBe(
      'JBSWY3DPEHPK3PXP'
    );
    const notification = JSON.stringify({
      payload_envelope_json: ['text', 'source-ciphertext'],
      payload_key_id: ['text', 'source-key'],
      recipient_encrypted: ['text', 'source-recipient'],
      recipient_encryption_key_version: ['integer', '3'],
    });
    await expect(
      transform(context('core.notification_delivery_intents', notification, 10))
    ).resolves.toBe(
      JSON.stringify({
        payload_envelope_json: ['null', null],
        payload_key_id: ['null', null],
        recipient_encrypted: ['null', null],
        recipient_encryption_key_version: ['null', null],
      })
    );
  });

  it('keeps source Admins as references without carrying source login material', async () => {
    const row = JSON.stringify({
      id: ['text', 'source-admin'],
      tenant_id: ['text', 'tenant-a'],
      email: ['text', 'admin@example.test'],
      name: ['text', 'Source Admin'],
      password_hash: ['text', 'password-hash'],
      totp_secret_encrypted: ['text', 'source-ciphertext'],
      last_login_ip: ['text', '192.0.2.10'],
    });

    await expect(transform(context('admin.admin_users', row, 10))).resolves.toBe(
      JSON.stringify({
        id: ['text', 'source-admin'],
        tenant_id: ['text', 'tenant-a'],
        email: ['text', 'admin@example.test'],
        name: ['text', 'Source Admin'],
        password_hash: ['null', null],
        totp_secret_encrypted: ['null', null],
        last_login_ip: ['null', null],
      })
    );
  });

  it('covers every identified Phase 8 sensitive dataset and keeps the transform list unique', () => {
    expect(PHASE8_SENSITIVE_SQLITE_DATASETS).toHaveLength(8);
    expect(new Set(PHASE8_TRANSFORMED_SQLITE_DATASETS).size).toBe(
      PHASE8_TRANSFORMED_SQLITE_DATASETS.length
    );
    expect(PHASE8_FILTERED_LOG_DATASETS).toHaveLength(43);
    for (const dataset of PHASE8_SENSITIVE_SQLITE_DATASETS)
      if (dataset !== 'pii.identity_identifier_replacement_challenges')
        expect(PHASE8_TRANSFORMED_SQLITE_DATASETS).toContain(dataset);
    expect(PHASE8_TRANSFORMED_SQLITE_DATASETS).not.toContain(
      'pii.identity_identifier_replacement_challenges'
    );
  });
});
