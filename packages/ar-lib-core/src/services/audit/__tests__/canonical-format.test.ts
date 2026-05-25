import { describe, expect, it } from 'vitest';
import { buildCanonicalAuditArchiveRecordFromEntry } from '../canonical-format';

describe('audit canonical archive format', () => {
  it('does not copy inline event detail into D-format archive summary', () => {
    const record = buildCanonicalAuditArchiveRecordFromEntry(
      { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
      'event_log',
      {
        id: 'evt-1',
        tenantId: 'tenant-a',
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        severity: 'info',
        anonymizedUserId: 'anon-1',
        clientId: 'client-1',
        requestId: 'req-1',
        detailsJson: JSON.stringify({
          authorization: 'Bearer secret-token',
          email: 'alice@example.com',
        }),
        createdAt: 1_779_321_600_000,
      },
      't_tenant',
      { auditProfileId: 'audit-profile-1' }
    );

    expect(record.summary).toMatchObject({
      audit_log_type: 'event_log',
      event_type: 'auth.login',
      event_category: 'auth',
      has_inline_detail: true,
      has_sensitive_detail: false,
    });
    expect(JSON.stringify(record)).not.toContain('Bearer secret-token');
    expect(JSON.stringify(record)).not.toContain('alice@example.com');
    expect(JSON.stringify(record)).not.toContain('detailsJson');
  });

  it('does not copy PII encrypted values or real user id into D-format archive summary', () => {
    const record = buildCanonicalAuditArchiveRecordFromEntry(
      { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
      'pii_log',
      {
        id: 'pii-1',
        tenantId: 'tenant-a',
        userId: 'real-user-1',
        anonymizedUserId: 'anon-1',
        changeType: 'update',
        affectedFields: JSON.stringify(['email', 'name']),
        valuesR2Key: 'sensitive-detail-catalog:catalog-1',
        valuesEncrypted: JSON.stringify({ ciphertext: 'encrypted-pii-value' }),
        encryptionKeyId: 'key-1',
        encryptionIv: 'iv-1',
        actorType: 'admin',
        actorUserId: 'admin-1',
        retentionUntil: 1_779_408_000_000,
        createdAt: 1_779_321_600_000,
      },
      't_tenant'
    );

    expect(record.detail_ref).toEqual({
      object_catalog_id: 'catalog-1',
      class: 'pii_log_values',
    });
    expect(record.summary).toMatchObject({
      audit_log_type: 'pii_log',
      anonymized_user_id: 'anon-1',
      affected_fields: ['email', 'name'],
      has_inline_encrypted_values: true,
      has_sensitive_detail: true,
    });
    expect(JSON.stringify(record)).not.toContain('real-user-1');
    expect(JSON.stringify(record)).not.toContain('encrypted-pii-value');
    expect(JSON.stringify(record)).not.toContain('valuesEncrypted');
  });
});
