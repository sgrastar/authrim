import { describe, expect, it } from 'vitest';
import {
  createTenantBackupRestorePreview,
  decodeTenantBackupRestoreApprovalCursor,
  encodeTenantBackupRestoreApprovalCursor,
  isTenantBackupRestorePreviewCurrent,
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

  describe('platform profile warnings', () => {
    const warning = (id: string, kind: 'platform_method_profile' | 'platform_session_profile') => ({
      id,
      kind,
      scope: 'shared' as const,
      resolution: 'target_binding' as const,
      status: 'unresolved' as const,
      required: false,
    });
    const preview = (prerequisites: unknown[]) =>
      createTenantBackupRestorePreview({ planDigest, prerequisites, deliverySafety: safeDelivery });

    it('keeps a non-required warning non-blocking and decodes a cursor stored without any', () => {
      const withWarning = preview([warning('pmp_missing', 'platform_method_profile')]);
      expect(withWarning.blockers).toEqual([]);
      const restoreCursor = JSON.stringify({ version: 1, sequenceOrdinal: 1 });
      const decoded = decodeTenantBackupRestoreApprovalCursor(
        encodeTenantBackupRestoreApprovalCursor({ planDigest, restoreCursor, preview: withWarning })
      );
      expect(decoded.preview.prerequisites.map(({ id }) => id)).toEqual(['pmp_missing']);
      // A cursor stored before the warnings existed has the same shape, with none listed.
      const old = decodeTenantBackupRestoreApprovalCursor(
        JSON.stringify({
          version: 1,
          planDigest,
          restoreCursor: { version: 1, sequenceOrdinal: 1 },
          preview: {
            version: 1,
            planDigest,
            prerequisites: [],
            deliverySafety: safeDelivery,
            blockers: [],
          },
        })
      );
      expect(old.preview.prerequisites).toEqual([]);
    });

    it('leaves the warnings out of the approval check: they never block a restore', () => {
      const stored = preview([warning('pmp_a', 'platform_method_profile')]);
      expect(isTenantBackupRestorePreviewCurrent(stored, stored)).toBe(true);
      // Fixed since, or another profile unusable since: the approval still goes through.
      expect(isTenantBackupRestorePreviewCurrent(stored, preview([]))).toBe(true);
      expect(
        isTenantBackupRestorePreviewCurrent(
          stored,
          preview([
            warning('pmp_a', 'platform_method_profile'),
            warning('psp_b', 'platform_session_profile'),
          ])
        )
      ).toBe(true);
      // A preview stored before the warnings existed is approved as it was.
      expect(isTenantBackupRestorePreviewCurrent(preview([]), stored)).toBe(true);
    });

    it('still compares everything else exactly', () => {
      const stored = preview([]);
      const changed = createTenantBackupRestorePreview({
        planDigest,
        prerequisites: [
          {
            id: 'kms/key',
            kind: 'key_material',
            scope: 'tenant',
            resolution: 'target_binding',
            status: 'resolved',
            required: true,
          },
        ],
        deliverySafety: safeDelivery,
      });
      expect(isTenantBackupRestorePreviewCurrent(stored, changed)).toBe(false);
    });
  });
});
