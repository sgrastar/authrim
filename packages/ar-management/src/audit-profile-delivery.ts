/**
 * Where an audit profile sends its logs (primary store, archive, sinks) and how it is bound into
 * a step-up. Delivery is compared on its whole configuration: URLs, header values, token refs and
 * store targets all count, so a change of any of them is a change of destination.
 */
import {
  BUILTIN_RUNTIME_PROFILES,
  DEFAULT_AUDIT_PROFILE_ID,
  type AuditProfile,
} from '@authrim/ar-lib-core';
import { sha256Hex } from './admin-step-up-digest';

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What decides where logs go and whether they get there: the targets and the delivery guarantees
 * (what happens when an archive or sink write fails, and how the request path behaves while
 * delivery is degraded). Weakening a guarantee (best-effort instead of retrying or gating
 * cleanup, fail-open instead of fail-closed) can lose logs for archive/sink-only setups, so it is
 * a change of delivery like a new destination is, and is gated as one
 * (`webhook.destination.update`): the receipt is about how logs leave the system, with the modes
 * bound in the params. A change in either direction counts; only the targets and these modes are
 * compared, never retention (that has its own comparison).
 */
function deliveryOf(profile: AuditProfile) {
  return {
    primary: profile.primary ?? null,
    archive: profile.archive ?? null,
    sinks: profile.sinks ?? [],
    archiveFailureMode: profile.archiveFailureMode ?? null,
    sinkFailureMode: profile.sinkFailureMode ?? null,
    backpressure: profile.backpressure ?? null,
  };
}

/** The delivery guarantees in the clear (no secrets in them), for the step-up params. */
export function auditDeliveryGuarantees(profile: AuditProfile) {
  return {
    archive_failure_mode: profile.archiveFailureMode ?? null,
    sink_failure_mode: profile.sinkFailureMode ?? null,
    backpressure: profile.backpressure ?? null,
  };
}

/**
 * What runtime uses for an audit profile id that is not registered (a deleted profile, an id a
 * tenant names that was never created): the built-in standard profile. A missing profile is
 * therefore compared as that profile, never as "no delivery".
 */
export function effectiveAuditProfile(profile: AuditProfile | null | undefined): AuditProfile {
  if (profile) return profile;
  return BUILTIN_RUNTIME_PROFILES.find(
    (item): item is AuditProfile => item.kind === 'audit' && item.id === DEFAULT_AUDIT_PROFILE_ID
  ) as AuditProfile;
}

/**
 * Whether `after` sends logs somewhere `before` does not, or with other guarantees: the whole
 * delivery (primary store, archive, sinks and the modes) is compared. A missing profile (null or
 * undefined, on either side: a create, a delete, an unregistered id) counts as what runtime uses
 * for it, the built-in standard profile (see `effectiveAuditProfile`).
 */
export function auditDeliveryChanged(
  before: AuditProfile | null | undefined,
  after: AuditProfile | null | undefined
): boolean {
  return (
    stableJson(deliveryOf(effectiveAuditProfile(before))) !==
    stableJson(deliveryOf(effectiveAuditProfile(after)))
  );
}

/**
 * The delivery configuration as digests only (URLs, header values and token refs are secrets):
 * one digest of the whole delivery and one per target, in order.
 */
export async function auditDeliveryDigests(input: AuditProfile | null | undefined): Promise<{
  delivery_sha256: string;
  target_sha256: string[];
  archive_failure_mode: string | null;
  sink_failure_mode: string | null;
  backpressure: unknown;
}> {
  const profile = effectiveAuditProfile(input);
  const delivery = deliveryOf(profile);
  const targets = [delivery.primary, delivery.archive, ...delivery.sinks];
  return {
    ...auditDeliveryGuarantees(profile),
    delivery_sha256: await sha256Hex(stableJson(delivery)),
    target_sha256: await Promise.all(targets.map((target) => sha256Hex(stableJson(target)))),
  };
}

/** The digest of the retention settings that a profile applies, for binding into a step-up. */
export async function auditRetentionDigest(profile: AuditProfile): Promise<string> {
  return sha256Hex(stableJson(profile.retention ?? null));
}
