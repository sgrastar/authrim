/**
 * Comparing the retention two audit profiles keep, to tell whether a change shortens it (logs get
 * deleted sooner, or are no longer archived first). One definition for every audit-retention write:
 * profile updates, switching the default profile, the tenant's profile setting and the Settings API.
 */
import { resolveAuditRetention, type AuditProfile } from '@authrim/ar-lib-core';

export const DEFAULT_RETENTION_CONFIG = { eventLogRetentionDays: 90, piiLogRetentionDays: 365 };
export type RetentionConfig = typeof DEFAULT_RETENTION_CONFIG;

/**
 * The event and PII days shown for a profile (its own values, else its primary/archive days).
 * For display only: whether a change shortens retention is judged by `auditRetentionWeakened`.
 */
export function retentionConfigFromProfile(profile: AuditProfile): RetentionConfig {
  return {
    eventLogRetentionDays:
      profile.retention?.eventLogRetentionDays ??
      profile.retention?.primaryDays ??
      profile.retention?.archiveDays ??
      DEFAULT_RETENTION_CONFIG.eventLogRetentionDays,
    piiLogRetentionDays:
      profile.retention?.piiLogRetentionDays ??
      profile.retention?.primaryDays ??
      profile.retention?.archiveDays ??
      DEFAULT_RETENTION_CONFIG.piiLogRetentionDays,
  };
}

const RAW_DAY_FIELDS = [
  'eventLogRetentionDays',
  'piiLogRetentionDays',
  'primaryDays',
  'archiveDays',
] as const;

/**
 * The days a log of this type written now keeps under the profile, by the same order a write
 * uses (`resolveAuditRetention`); null when the profile sets nothing that applies and the write
 * falls back to the tenant's PII config, which a profile comparison cannot see.
 */
function profileRetentionDays(profile: AuditProfile, logType: 'event' | 'pii'): number | null {
  const resolved = resolveAuditRetention(profile, NO_TENANT_DEFAULTS, logType);
  return resolved.source === 'audit_profile' ? resolved.days : null;
}

// Only consulted for the source: the days are never read when the source is `pii_config`.
const NO_TENANT_DEFAULTS = {
  eventLogRetentionDays: 0,
  piiLogRetentionDays: 0,
} as unknown as Parameters<typeof resolveAuditRetention>[1];

/**
 * Whether moving from one audit profile to another keeps logs for less time or drops a safeguard:
 * a shorter effective event/PII retention (resolved the way a write resolves it; a side that falls
 * back to the tenant's PII config is unknown here, so any change to or from it counts as shorter),
 * a shorter explicit window (when both profiles set it), a lowered or removed minimum retention,
 * or archive-before-delete switched off.
 */
export function auditRetentionWeakened(before: AuditProfile, after: AuditProfile): boolean {
  for (const logType of ['event', 'pii'] as const) {
    const was = profileRetentionDays(before, logType);
    const now = profileRetentionDays(after, logType);
    if (was === null && now === null) continue;
    if (was === null || now === null || now < was) return true;
  }
  for (const field of RAW_DAY_FIELDS) {
    const previous = before.retention?.[field];
    const next = after.retention?.[field];
    if (typeof previous === 'number' && typeof next === 'number' && next < previous) return true;
  }
  const floor = before.retention?.minimumRetentionDays;
  if (typeof floor === 'number') {
    const next = after.retention?.minimumRetentionDays;
    if (typeof next !== 'number' || next < floor) return true;
  }
  return (
    before.retention?.archiveBeforeDelete === true && after.retention?.archiveBeforeDelete !== true
  );
}
