/**
 * Which profile fields a login from an external IdP (OIDC or SAML) updates.
 *
 * The tenant chooses a default (`external_idp.jit_update_fields`) and each IdP may override it
 * (an OIDC provider's `profile_update_fields`, a SAML IdP's `profileUpdateFields`). Updates happen
 * only with `external_idp.jit_update_on_login` and `external_idp.jit_provisioning_enabled` on.
 * The fields are Authrim's standard profile claims, after any attribute mapping; contacts (email,
 * phone) and the account state are never updated this way.
 */

/**
 * The profile fields a login can update (the standard claims a profile holds). Not
 * preferred_username: it is also an identifier (SCIM userName, username login) kept unique with
 * its own lookup index, which a profile update does not maintain.
 */
export const PROFILE_UPDATE_FIELDS = [
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
] as const;

export type ProfileUpdateField = (typeof PROFILE_UPDATE_FIELDS)[number];

/** What a login has always updated: the tenant default unless the tenant changes it. */
export const DEFAULT_PROFILE_UPDATE_FIELDS: readonly ProfileUpdateField[] = [
  'name',
  'given_name',
  'family_name',
  'picture',
  'locale',
];

const ALLOWED = new Set<string>(PROFILE_UPDATE_FIELDS);

/** Why a value is not a list of profile update fields, or null when it is one. */
export function profileUpdateFieldsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'must be an array of profile field names';
  }
  const seen = new Set<string>();
  for (const field of value) {
    if (typeof field !== 'string' || !ALLOWED.has(field)) {
      return `may name only ${PROFILE_UPDATE_FIELDS.join(', ')}`;
    }
    if (seen.has(field)) {
      return `names ${field} more than once`;
    }
    seen.add(field);
  }
  return null;
}

/** A list of profile update fields as saved, or null when it is not one. */
export function parseProfileUpdateFields(value: unknown): ProfileUpdateField[] | null {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return profileUpdateFieldsProblem(parsed) === null ? (parsed as ProfileUpdateField[]) : null;
}

/**
 * The fields a login from this IdP updates: its own list when it has one (an empty list updates
 * nothing), otherwise the tenant default. A list that cannot be read updates nothing, rather than
 * fields nobody chose.
 */
export function resolveProfileUpdateFields(
  tenantDefault: unknown,
  providerOverride?: unknown
): ProfileUpdateField[] {
  if (providerOverride !== undefined && providerOverride !== null) {
    return parseProfileUpdateFields(providerOverride) ?? [];
  }
  return parseProfileUpdateFields(tenantDefault) ?? [];
}

/** The chosen fields' values among the claims: string values only. */
export function profileValuesFromClaims(
  claims: Record<string, unknown>,
  fields: readonly ProfileUpdateField[]
): Partial<Record<ProfileUpdateField, string>> {
  return Object.fromEntries(
    fields
      .filter((field) => typeof claims[field] === 'string')
      .map((field) => [field, claims[field] as string])
  ) as Partial<Record<ProfileUpdateField, string>>;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
