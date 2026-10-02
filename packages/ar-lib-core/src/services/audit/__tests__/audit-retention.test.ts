import { describe, expect, it } from 'vitest';
import { resolveAuditRetention } from '../audit-service';
import { DEFAULT_PII_CONFIG } from '../types';
import type { AuditProfile } from '../../../types/runtime-profile';

function profile(overrides: Partial<AuditProfile> = {}): AuditProfile {
  return {
    kind: 'audit',
    id: 'p',
    primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
    sinks: [],
    ...overrides,
  } as AuditProfile;
}

const tenantConfig = { ...DEFAULT_PII_CONFIG, eventLogRetentionDays: 45, piiLogRetentionDays: 500 };

describe('resolveAuditRetention', () => {
  it('takes a delivery plan first, then the profile, then the tenant PII config', () => {
    expect(resolveAuditRetention(profile(), tenantConfig, 'event', 7)).toEqual({
      days: 7,
      source: 'delivery_plan',
    });
    expect(
      resolveAuditRetention(
        profile({ retention: { eventLogRetentionDays: 30, piiLogRetentionDays: 60 } }),
        tenantConfig,
        'pii'
      )
    ).toEqual({ days: 60, source: 'audit_profile' });
    expect(resolveAuditRetention(profile(), tenantConfig, 'event', null)).toEqual({
      days: 45,
      source: 'pii_config',
    });
    expect(resolveAuditRetention(profile(), tenantConfig, 'pii')).toEqual({
      days: 500,
      source: 'pii_config',
    });
  });

  it('uses primaryDays with a primary store and archiveDays without one', () => {
    const retention = { primaryDays: 14, archiveDays: 400 };
    expect(resolveAuditRetention(profile({ retention }), tenantConfig, 'event')).toEqual({
      days: 14,
      source: 'audit_profile',
    });
    expect(
      resolveAuditRetention(profile({ primary: null, retention }), tenantConfig, 'event')
    ).toEqual({ days: 400, source: 'audit_profile' });
  });
});
