/**
 * What a consent step asks, as one key: the statements of a policy, their versions and the terms of
 * agreeing to them (required or not, how, to what it applies, what can be chosen), and for a
 * destination the profile, its consent version and which fields are required.
 *
 * Both sides judge "is this what was shown" with these functions: the Flow runtime when it takes
 * consent (and keeps the key of what its contract showed), and the Login UI when it decides whether
 * what a user ticked still means what it meant. A term added here is judged by both.
 */

export interface ConsentPresentationItem {
  statement_id: string;
  version?: string | null;
  version_id?: string | null;
  is_required?: boolean;
  checkbox_mode?: string;
  content_mode?: string;
  binding_type?: string | null;
  binding_value?: string | null;
  options?: ReadonlyArray<{ value: string }>;
}

export interface ConsentPresentationDestination {
  profile_id?: string | null;
  profile_version_id: string;
  consent_version?: string | null;
  fields: ReadonlyArray<{ key: string; required?: boolean }>;
}

/** The statements of a policy, the versions they were presented in and the terms of agreeing. */
export function consentPresentationKey(policy: {
  items: ReadonlyArray<ConsentPresentationItem>;
}): string {
  return JSON.stringify(
    policy.items
      .map((item) => [
        item.statement_id,
        item.version ?? null,
        item.version_id ?? null,
        item.is_required ?? null,
        item.checkbox_mode ?? null,
        item.content_mode ?? null,
        item.binding_type ?? null,
        item.binding_value ?? null,
        (item.options ?? []).map((option) => option.value).sort(),
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  );
}

/** The destination profile, its consent version and which of its fields are required. */
export function destinationPresentationKey(consent: ConsentPresentationDestination): string {
  return JSON.stringify([
    consent.profile_id ?? null,
    consent.profile_version_id,
    consent.consent_version ?? null,
    consent.fields
      .map((field) => [field.key, field.required ?? null])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
}

/** A consent step's key: its policy and its destination consent, either of which may be absent. */
export function consentStepKey(
  policy: { items: ReadonlyArray<ConsentPresentationItem> } | null,
  destination: ConsentPresentationDestination | null
): string {
  return JSON.stringify([
    policy ? consentPresentationKey(policy) : null,
    destination ? destinationPresentationKey(destination) : null,
  ]);
}
