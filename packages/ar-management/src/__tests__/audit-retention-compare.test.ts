import { describe, expect, it } from 'vitest';
import type { AuditProfile } from '@authrim/ar-lib-core';
import { auditRetentionWeakened } from '../audit-retention-compare';

function profile(
  retention: AuditProfile['retention'],
  extra: Partial<AuditProfile> = {}
): AuditProfile {
  return { kind: 'audit', id: 'audit-test', retention, ...extra } as AuditProfile;
}

const withPrimary = { primary: { backend: 'd1' } } as unknown as Partial<AuditProfile>;

describe('auditRetentionWeakened', () => {
  it('is false for a longer or unchanged retention', () => {
    const before = profile({ eventLogRetentionDays: 90, piiLogRetentionDays: 365 });
    expect(auditRetentionWeakened(before, before)).toBe(false);
    expect(
      auditRetentionWeakened(
        before,
        profile({ eventLogRetentionDays: 180, piiLogRetentionDays: 400 })
      )
    ).toBe(false);
  });

  it('is true for a shorter event or PII retention', () => {
    const before = profile({ eventLogRetentionDays: 90, piiLogRetentionDays: 365 });
    expect(
      auditRetentionWeakened(
        before,
        profile({ eventLogRetentionDays: 30, piiLogRetentionDays: 365 })
      )
    ).toBe(true);
  });

  it('resolves like a write: archiveDays does not apply while a primary is configured', () => {
    // Dropping the explicit event days leaves a primary profile without primaryDays: a write then
    // falls back to the tenant's PII config, not to archiveDays.
    const before = profile({ eventLogRetentionDays: 365, archiveDays: 730 }, withPrimary);
    const after = profile({ archiveDays: 730 }, withPrimary);
    expect(auditRetentionWeakened(before, after)).toBe(true);
  });

  it('counts a move to or from the tenant PII config fallback as shorter (unknown here)', () => {
    const explicit = profile({ eventLogRetentionDays: 90, piiLogRetentionDays: 365 });
    const fallback = profile({});
    expect(auditRetentionWeakened(explicit, fallback)).toBe(true);
    expect(auditRetentionWeakened(fallback, explicit)).toBe(true);
    expect(auditRetentionWeakened(fallback, profile({}))).toBe(false);
  });

  it('is true when the minimum retention is lowered or archive-before-delete is switched off', () => {
    const before = profile({
      eventLogRetentionDays: 90,
      piiLogRetentionDays: 365,
      minimumRetentionDays: 30,
      archiveBeforeDelete: true,
    });
    expect(
      auditRetentionWeakened(before, profile({ ...before.retention, minimumRetentionDays: 7 }))
    ).toBe(true);
    expect(
      auditRetentionWeakened(before, profile({ ...before.retention, archiveBeforeDelete: false }))
    ).toBe(true);
  });
});
