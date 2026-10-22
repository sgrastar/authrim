/**
 * The institution a tenant stands for (`institution.*` settings): how its scopes and names are
 * checked when saved, and read when used.
 *
 * Saving refuses what runtime could not use. Reading is stricter than a value being absent: a saved
 * scope list that is not valid (it can only get there around the Settings API) is "invalid", never
 * "unset", so that a consumer that gates on the scopes withholds what it would otherwise release
 * rather than falling back to releasing everything.
 */
import {
  INSTITUTION_DISPLAY_NAMES_KEY,
  INSTITUTION_SCOPES_KEY,
  MAX_INSTITUTION_DISPLAY_NAMES,
  MAX_INSTITUTION_NAME_LENGTH,
  MAX_INSTITUTION_SCOPES,
  REQUIRED_INSTITUTION_NAME_LANGUAGES,
} from '../types/settings/institution';

/** A DNS label: letters, digits and hyphens, not starting or ending with a hyphen. */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Why one scope is not a scope (null when it is): a lowercase domain name of at least two labels,
 * without wildcard, port, path, trailing dot, or the form of an IP address. A non-ASCII name is
 * given in its punycode form (`xn--`).
 */
export function institutionScopeProblem(scope: string): string | null {
  if (scope === '') return 'must not be empty';
  if (scope.includes('*')) return 'must not be a wildcard';
  if (scope !== scope.toLowerCase()) return 'must be lowercase';
  if (scope.length > 253) return 'must be at most 253 characters';
  const labels = scope.split('.');
  if (labels.length < 2) return 'must be a domain name with at least two labels';
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) {
    return 'must be a domain name of letters, digits and hyphens (a non-ASCII name in its xn-- form)';
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return 'must not be an IP address';
  return null;
}

/** The entries of a comma-separated scope list, untrimmed entries trimmed, empty ones kept. */
function splitScopes(value: string): string[] {
  return value.split(',').map((entry) => entry.trim());
}

/**
 * Why `institution.scopes` is not valid as saved (null when it is): a comma-separated list of one
 * to {@link MAX_INSTITUTION_SCOPES} distinct scopes. Clearing the setting is how a tenant has none.
 */
export function institutionScopesProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a comma-separated list of domain names';
  const entries = splitScopes(value);
  if (value.trim() === '') return 'must list at least one scope (clear the setting for none)';
  if (entries.length > MAX_INSTITUTION_SCOPES) {
    return `must list at most ${MAX_INSTITUTION_SCOPES} scopes`;
  }
  for (const entry of entries) {
    const problem = institutionScopeProblem(entry);
    if (problem) return `scope "${printable(entry)}" ${problem}`;
  }
  if (new Set(entries).size !== entries.length) return 'must not list a scope twice';
  return null;
}

/** A value of a request shown in a message: short, without control characters. */
function printable(value: string): string {
  const shown = value.length > 64 ? `${value.slice(0, 64)}...` : value;
  return shown.replace(CONTROL_CHARACTER, '?');
}

/**
 * The scopes of a tenant as runtime reads them.
 * - `unset`: none is saved.
 * - `set`: the scopes, the first being the default.
 * - `invalid`: something is saved that is not a valid list.
 */
export type InstitutionScopes =
  | { state: 'unset' }
  | { state: 'set'; scopes: readonly string[]; defaultScope: string }
  | { state: 'invalid' };

export function readInstitutionScopes(value: unknown): InstitutionScopes {
  if (value === undefined || value === null || value === '') return { state: 'unset' };
  if (institutionScopesProblem(value) !== null) return { state: 'invalid' };
  const scopes = splitScopes(value as string);
  return { state: 'set', scopes, defaultScope: scopes[0] };
}

/**
 * Why `institution.display_names` is not valid as saved (null when it is): JSON text of an object
 * from language tag to name, with at least the required languages.
 */
export function institutionDisplayNamesProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be JSON text of an object of language tags to names';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return 'must be JSON text of an object of language tags to names';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'must be JSON text of an object of language tags to names';
  }
  const names = parsed as Record<string, unknown>;
  const languages = Object.keys(names);
  if (languages.length > MAX_INSTITUTION_DISPLAY_NAMES) {
    return `must name the institution in at most ${MAX_INSTITUTION_DISPLAY_NAMES} languages`;
  }
  for (const language of REQUIRED_INSTITUTION_NAME_LANGUAGES) {
    if (!Object.hasOwn(names, language)) return `must give the name in "${language}"`;
  }
  for (const language of languages) {
    if (!LANGUAGE_TAG.test(language)) {
      return `"${printable(language)}" is not a language tag (a lowercase language such as ja or en, optionally with a region such as en-gb)`;
    }
    const name = names[language];
    if (
      typeof name !== 'string' ||
      name === '' ||
      name !== name.trim() ||
      name.length > MAX_INSTITUTION_NAME_LENGTH ||
      CONTROL_CHARACTER.test(name)
    ) {
      return `the name in "${language}" must be 1 to ${MAX_INSTITUTION_NAME_LENGTH} characters, without padding or control characters`;
    }
  }
  return null;
}

/**
 * The names of a tenant as runtime reads them: language tag to name, empty when none is saved or
 * the saved value is not valid (the name is only shown, so an invalid one is left out, not acted
 * on).
 */
export function readInstitutionDisplayNames(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'string' || institutionDisplayNamesProblem(value) !== null) return {};
  return JSON.parse(value) as Record<string, string>;
}

/**
 * Whether `institution.display_names` holds something that is not a valid set of names. Nothing
 * saved (or the default `{}`) is not invalid: it is unset.
 */
export function institutionDisplayNamesInvalid(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === '{}') return false;
  return institutionDisplayNamesProblem(value) !== null;
}

/** What a tenant's institution settings say. */
export interface TenantInstitution {
  scopes: InstitutionScopes;
  displayNames: Readonly<Record<string, string>>;
  /**
   * Set when something that is not a valid set of names is saved: `displayNames` is empty then,
   * and a consumer that gates on the institution must not read that as "no names registered".
   */
  namesInvalid?: true;
}

/**
 * From the effective values of the `institution` category (`resolveEffectiveSettings(env,
 * 'institution', { tenantId })`: the saved values, else the defaults, which are none).
 */
export function institutionFromSettings(values: Record<string, unknown>): TenantInstitution {
  return {
    scopes: readInstitutionScopes(values[INSTITUTION_SCOPES_KEY]),
    displayNames: readInstitutionDisplayNames(values[INSTITUTION_DISPLAY_NAMES_KEY]),
    ...(institutionDisplayNamesInvalid(values[INSTITUTION_DISPLAY_NAMES_KEY])
      ? { namesInvalid: true as const }
      : {}),
  };
}
