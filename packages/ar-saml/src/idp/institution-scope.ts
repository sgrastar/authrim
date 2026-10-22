/**
 * The scope of the scoped attributes an IdP releases (eduPersonScopedAffiliation, eduPersonPrincipalName).
 *
 * A scoped value is `local@scope`, and a service provider trusts the scope only because the IdP's
 * metadata lists it (shibmd:Scope). So a tenant that has registered its institution's scopes
 * (`institution.scopes`) releases such a value only under one of them: a value of the person's own
 * that names another scope is withheld, never passed on. A value with no scope gets the tenant's
 * default one. A tenant with no registered scope releases the values as they come, as before.
 *
 * Pure: it works on the attributes a mapping produced, and says what it withheld by code, never by
 * value (the only thing named besides the attribute is a scope, which is a domain name).
 */
import type { SAMLAttribute } from '@authrim/ar-lib-core';
import { institutionScopeProblem, type InstitutionScopes } from '@authrim/ar-lib-core';

/**
 * What the tenant's registered scopes say, as far as the release needs them.
 * `unavailable`: the settings could not be read, so whether scopes are registered is not known.
 */
export type SAMLInstitutionScopePolicy = InstitutionScopes | { state: 'unavailable' };

export type SAMLScopedAttributeKind = 'eduPersonScopedAffiliation' | 'eduPersonPrincipalName';

/** Why a scoped value was not released. */
export type SAMLScopedValueWithholdReason =
  /** The scope of the value is not one the tenant registered. */
  | 'scope_not_registered'
  /** There is nothing before or after the `@`. */
  | 'value_malformed'
  /** The tenant's saved scopes are not a valid list, so no scope can be trusted. */
  | 'institution_scopes_invalid'
  /** The tenant's institution settings could not be read. */
  | 'institution_settings_unavailable';

/** What was withheld from one attribute for one reason (and under one scope, when it has one). */
export interface SAMLWithheldScopedValues {
  attribute: SAMLScopedAttributeKind;
  /** The Name the attribute was to be released under. */
  name: string;
  reason: SAMLScopedValueWithholdReason;
  /** The scope the withheld values named, when it is a domain name (a scope is not personal). */
  scope?: string;
  count: number;
}

/**
 * How each scoped attribute can be told from what a mapping says about it: its name, and the
 * places a field mapping set keeps what an attribute is (a catalog entry id, a path, the field it
 * is read from). A hint matches when it names the attribute (`eduPersonPrincipalName`, in any case
 * and with any separators, as a part of a longer id such as `target.eduPersonPrincipalName`), is
 * its common short form (`eppn`, `epsa`) or carries its OID (with or without `urn:oid:`).
 */
const SCOPED_ATTRIBUTE_HINTS: Record<
  SAMLScopedAttributeKind,
  { names: readonly string[]; shortForms: readonly string[]; oid: RegExp }
> = {
  eduPersonScopedAffiliation: {
    names: ['edupersonscopedaffiliation'],
    shortForms: ['epsa'],
    oid: /(^|[^0-9.])1\.3\.6\.1\.4\.1\.5923\.1\.1\.1\.9($|[^0-9.])/,
  },
  eduPersonPrincipalName: {
    names: ['edupersonprincipalname'],
    shortForms: ['eppn'],
    oid: /(^|[^0-9.])1\.3\.6\.1\.4\.1\.5923\.1\.1\.1\.6($|[^0-9.])/,
  },
};

/** Which scoped attribute these hints say, or null when none of them says one. */
export function scopedKindFromHints(
  hints: ReadonlyArray<string | undefined | null>
): SAMLScopedAttributeKind | null {
  for (const hint of hints) {
    if (typeof hint !== 'string' || hint === '') continue;
    const squashed = hint.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const kind of Object.keys(SCOPED_ATTRIBUTE_HINTS) as SAMLScopedAttributeKind[]) {
      const known = SCOPED_ATTRIBUTE_HINTS[kind];
      if (
        known.names.some((name) => squashed.includes(name)) ||
        known.shortForms.includes(squashed) ||
        known.oid.test(hint)
      ) {
        return kind;
      }
    }
  }
  return null;
}

/** Which scoped attribute this is by its Name or FriendlyName alone, or null for any other. */
export function scopedAttributeKind(attribute: SAMLAttribute): SAMLScopedAttributeKind | null {
  return scopedKindFromHints([attribute.name, attribute.friendlyName]);
}

/**
 * Applies the tenant's scopes to the scoped attributes among `attributes`. `kindOf` says which
 * attributes are scoped; the release passes the one that also knows what the mapping says an
 * attribute is, and the decision to read the scopes at all asks the same function.
 */
export function applySAMLInstitutionScopePolicy(
  attributes: SAMLAttribute[],
  policy: SAMLInstitutionScopePolicy,
  kindOf: (attribute: SAMLAttribute) => SAMLScopedAttributeKind | null = scopedAttributeKind
): { attributes: SAMLAttribute[]; withheld: SAMLWithheldScopedValues[] } {
  if (policy.state === 'unset') return { attributes, withheld: [] };

  const withheld = new Map<string, SAMLWithheldScopedValues>();
  const note = (
    kind: SAMLScopedAttributeKind,
    name: string,
    reason: SAMLScopedValueWithholdReason,
    scope?: string
  ): void => {
    const key = [kind, name, reason, scope ?? ''].join('\u0000');
    const existing = withheld.get(key);
    if (existing) existing.count += 1;
    else
      withheld.set(key, { attribute: kind, name, reason, ...(scope ? { scope } : {}), count: 1 });
  };

  const released: SAMLAttribute[] = [];
  for (const attribute of attributes) {
    const kind = kindOf(attribute);
    if (!kind) {
      released.push(attribute);
      continue;
    }
    const values: string[] = [];
    for (const value of attribute.values) {
      const outcome = scopeValue(value, policy);
      if (outcome.released !== undefined) {
        if (!values.includes(outcome.released)) values.push(outcome.released);
      } else {
        note(kind, attribute.name, outcome.reason, outcome.scope);
      }
    }
    if (values.length > 0) released.push({ ...attribute, values });
  }
  return { attributes: released, withheld: [...withheld.values()] };
}

function scopeValue(
  value: string,
  policy: Exclude<SAMLInstitutionScopePolicy, { state: 'unset' }>
):
  | { released: string }
  | { released?: undefined; reason: SAMLScopedValueWithholdReason; scope?: string } {
  if (policy.state === 'unavailable') {
    return { reason: 'institution_settings_unavailable' };
  }
  if (policy.state === 'invalid') {
    return { reason: 'institution_scopes_invalid' };
  }
  if (value.trim() === '') return { reason: 'value_malformed' };
  const parts = value.split('@');
  // The local part of a scoped value has no @ of its own, so more than one is not a value of ours.
  if (parts.length > 2) return { reason: 'value_malformed' };
  // No scope of its own: the tenant's default one.
  if (parts.length === 1) return { released: `${value}@${policy.defaultScope}` };
  const [local, scope] = parts;
  if (local.trim() === '' || scope.trim() === '') return { reason: 'value_malformed' };
  if (!policy.scopes.includes(scope)) {
    // The scope is the person's own claim; it is only named when it is a domain name.
    return {
      reason: 'scope_not_registered',
      ...(institutionScopeProblem(scope) === null ? { scope } : {}),
    };
  }
  return { released: value };
}
