/**
 * The platform's locks on settings, as stored in a PLATFORM settings document.
 *
 * A platform document may carry a reserved list of setting keys (`__locked__`) next to the
 * values. A locked setting cannot be changed by a tenant or a client, and any value they stored
 * for it is ignored: it resolves from the platform onward. The list is part of the document, so
 * the document's version covers it, it is saved and projected to KV with the values, and a
 * reader that loads the platform layer already has it.
 *
 * It is not a setting: every reader that hands a document on as plain values removes it first
 * (`withoutSettingLocks`). Only the platform document's list counts.
 *
 * No imports, so the raw-document readers (tenant-settings) and the manager can both use it.
 */

/** Reserved field of a platform settings document: the keys the platform has locked. */
export const SETTING_LOCKS_FIELD = '__locked__';

/** Why a tenant or client change to a locked setting is refused (the start of the reason text). */
export const LOCKED_BY_PLATFORM = 'locked_by_platform';

/** The keys a (platform) settings document lists as locked, sorted; none when it has no list. */
export function readSettingLocks(document: Record<string, unknown> | null | undefined): string[] {
  const raw = document?.[SETTING_LOCKS_FIELD];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((key): key is string => typeof key === 'string'))].sort();
}

/** A settings document as plain values: without the reserved lock list. */
export function withoutSettingLocks(document: Record<string, unknown>): Record<string, unknown> {
  if (!(SETTING_LOCKS_FIELD in document)) return document;
  const { [SETTING_LOCKS_FIELD]: _locks, ...values } = document;
  return values;
}

/** Whether a refusal reason (`rejected` of a PATCH) is the platform's lock. */
export function isLockedByPlatformReason(reason: string | undefined): boolean {
  return reason !== undefined && reason.startsWith(LOCKED_BY_PLATFORM);
}
