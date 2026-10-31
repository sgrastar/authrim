import { describe, expect, it } from 'vitest';
import {
  createTenantBackupRestorePreview,
  decodeTenantBackupRestoreApprovalCursor,
  encodeTenantBackupRestoreApprovalCursor,
} from '../restore-preview';

const planDigest = 'ab'.repeat(32);
const safeDelivery = {
  version: 1 as const,
  sourceEnvironment: 'stopped' as const,
  historicalDelivery: 'hold' as const,
  scheduledCatchup: 'disabled' as const,
  activation: 'new_events_only' as const,
};

describe('tenant backup restore preview', () => {
  it('round-trips a safe preview while preserving the sealed restore cursor', () => {
    const preview = createTenantBackupRestorePreview({
      planDigest,
      prerequisites: [],
      deliverySafety: safeDelivery,
    });
    const encoded = encodeTenantBackupRestoreApprovalCursor({
      planDigest,
      restoreCursor: JSON.stringify({ version: 1, sequenceOrdinal: 3 }),
      preview,
    });

    expect(decodeTenantBackupRestoreApprovalCursor(encoded)).toEqual({
      version: 1,
      planDigest,
      restoreCursor: { version: 1, sequenceOrdinal: 3 },
      preview: { ...preview, blockers: [] },
    });
  });

  it('reports unresolved required dependencies and unsafe delivery as explicit blockers', () => {
    const preview = createTenantBackupRestorePreview({
      planDigest,
      prerequisites: [
        {
          id: 'optional/directory',
          kind: 'directory_connection',
          scope: 'tenant',
          resolution: 'reconnect',
          status: 'unresolved',
          required: false,
        },
        {
          id: 'kms/customer-key',
          kind: 'key_material',
          scope: 'tenant',
          resolution: 'target_binding',
          status: 'unresolved',
          required: true,
        },
      ],
      deliverySafety: { ...safeDelivery, sourceEnvironment: 'not_confirmed' },
    });

    expect(preview.blockers).toEqual([
      { code: 'external_prerequisite_unresolved', subjectId: 'kms/customer-key' },
      { code: 'delivery_safety_unconfirmed', subjectId: null },
    ]);
  });

  it.each([
    [
      'changed blocker list',
      (value: Record<string, unknown>) => {
        const preview = value.preview as Record<string, unknown>;
        preview.blockers = [];
      },
    ],
    [
      'changed plan digest',
      (value: Record<string, unknown>) => {
        value.planDigest = 'cd'.repeat(32);
      },
    ],
    [
      'extra cursor field',
      (value: Record<string, unknown>) => {
        value.secret = 'must-not-pass';
      },
    ],
    [
      'missing restore cursor',
      (value: Record<string, unknown>) => {
        delete value.restoreCursor;
      },
    ],
  ] as const)('rejects a %s', (_label, mutate) => {
    const preview = createTenantBackupRestorePreview({
      planDigest,
      prerequisites: [
        {
          id: 'kms/customer-key',
          kind: 'key_material',
          scope: 'tenant',
          resolution: 'target_binding',
          status: 'unresolved',
          required: true,
        },
      ],
      deliverySafety: safeDelivery,
    });
    const value = JSON.parse(
      encodeTenantBackupRestoreApprovalCursor({
        planDigest,
        restoreCursor: '{"version":1,"sequenceOrdinal":0}',
        preview,
      })
    ) as Record<string, unknown>;
    mutate(value);
    expect(() => decodeTenantBackupRestoreApprovalCursor(JSON.stringify(value))).toThrow(
      'backup_restore_preview_invalid'
    );
  });

  it('rejects malformed or oversized cursors', () => {
    expect(() => decodeTenantBackupRestoreApprovalCursor(null)).toThrow(
      'backup_restore_preview_invalid'
    );
    expect(() =>
      decodeTenantBackupRestoreApprovalCursor(`{"padding":"${'x'.repeat(17000)}"}`)
    ).toThrow('backup_restore_preview_invalid');
  });
});
