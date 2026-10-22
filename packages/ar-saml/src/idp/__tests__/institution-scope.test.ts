import { describe, expect, it } from 'vitest';
import type { SAMLAttribute } from '@authrim/ar-lib-core';
import {
  applySAMLInstitutionScopePolicy,
  scopedAttributeKind,
  type SAMLInstitutionScopePolicy,
} from '../institution-scope';

const EPSA = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9';
const EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
const MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
const SCHAC = 'urn:oid:1.3.6.1.4.1.25178.1.2.9';
const ORG_NAME = 'urn:oid:2.5.4.10';

const set = (...scopes: string[]): SAMLInstitutionScopePolicy => ({
  state: 'set',
  scopes,
  defaultScope: scopes[0],
});

const attribute = (name: string, values: string[], friendlyName?: string): SAMLAttribute => ({
  name,
  friendlyName,
  values,
});

describe('which attributes are scoped', () => {
  it.each([
    [EPSA, 'eduPersonScopedAffiliation'],
    ['urn:mace:dir:attribute-def:eduPersonScopedAffiliation', 'eduPersonScopedAffiliation'],
    ['eduPersonScopedAffiliation', 'eduPersonScopedAffiliation'],
    [EPPN, 'eduPersonPrincipalName'],
    ['urn:mace:dir:attribute-def:eduPersonPrincipalName', 'eduPersonPrincipalName'],
    ['EDUPERSONPRINCIPALNAME', 'eduPersonPrincipalName'],
    ['eppn', 'eduPersonPrincipalName'],
    ['EPPN', 'eduPersonPrincipalName'],
    ['epsa', 'eduPersonScopedAffiliation'],
    ['1.3.6.1.4.1.5923.1.1.1.6', 'eduPersonPrincipalName'],
    ['1.3.6.1.4.1.5923.1.1.1.9', 'eduPersonScopedAffiliation'],
    ['urn:oid:1.3.6.1.4.1.5923.1.1.1.9', 'eduPersonScopedAffiliation'],
    ['target.eduPersonPrincipalName', 'eduPersonPrincipalName'],
    ['field.saml.edu_person_scoped_affiliation', 'eduPersonScopedAffiliation'],
    [SCHAC, 'schacHomeOrganization'],
    ['1.3.6.1.4.1.25178.1.2.9', 'schacHomeOrganization'],
    ['schac_home_organization', 'schacHomeOrganization'],
    ['target.schacHomeOrganization', 'schacHomeOrganization'],
    [ORG_NAME, 'organizationName'],
    ['2.5.4.10', 'organizationName'],
    ['o', 'organizationName'],
    ['O', 'organizationName'],
    ['organizationName', 'organizationName'],
    ['organization_name', 'organizationName'],
    ['urn:mace:dir:attribute-def:o', 'organizationName'],
    ['URN:MACE:DIR:ATTRIBUTE-DEF:O', 'organizationName'],
    ['urn:mace:dir:attribute-def:organizationName', 'organizationName'],
    ['urn:mace:dir:attribute-def:eduPersonPrincipalName', 'eduPersonPrincipalName'],
    ['urn:mace:dir:attribute-def:eduPersonScopedAffiliation', 'eduPersonScopedAffiliation'],
    ['urn:mace:terena.org:attribute-def:schacHomeOrganization', 'schacHomeOrganization'],
  ])('reads %s as %s', (name, kind) => {
    expect(scopedAttributeKind(attribute(name, ['x']))).toBe(kind);
  });

  it('knows an attribute by its friendly name when the name is something else', () => {
    expect(scopedAttributeKind(attribute('custom-name', ['x'], 'eduPersonPrincipalName'))).toBe(
      'eduPersonPrincipalName'
    );
  });

  it('does not take other attributes for scoped ones', () => {
    expect(scopedAttributeKind(attribute(MAIL, ['x@y.example'], 'mail'))).toBeNull();
    // Another OID that merely begins like the ePPN one.
    expect(scopedAttributeKind(attribute('urn:oid:1.3.6.1.4.1.5923.1.1.1.60', ['x']))).toBeNull();
    expect(scopedAttributeKind(attribute('urn:oid:11.3.6.1.4.1.5923.1.1.1.6', ['x']))).toBeNull();
    expect(scopedAttributeKind(attribute('eppn2', ['x']))).toBeNull();
    // The URN forms are whole names; another attribute's URN that ends the same way is not them.
    for (const name of [
      'urn:mace:dir:attribute-def:ou',
      'urn:mace:dir:attribute-def:o2',
      'urn:mace:dir:attribute-def:mail',
    ]) {
      expect(scopedAttributeKind(attribute(name, ['x'])), name).toBeNull();
    }
    // The organization name is a short name: only the whole name counts, never a part of a word.
    for (const name of [
      'ou',
      'other',
      'to',
      'mobile',
      'organization',
      'urn:oid:2.5.4.100',
      'urn:oid:2.5.4.1',
      'urn:oid:12.5.4.10',
      'urn:oid:1.3.6.1.4.1.25178.1.2.90',
    ]) {
      expect(scopedAttributeKind(attribute(name, ['x'])), name).toBeNull();
    }
    // eduPersonAffiliation has no scope.
    expect(
      scopedAttributeKind(attribute('urn:oid:1.3.6.1.4.1.5923.1.1.1.1', ['member']))
    ).toBeNull();
  });
});

describe('a tenant with no registered scope', () => {
  it('releases the values as they come, as before', () => {
    const attributes = [
      attribute(EPSA, ['member@anywhere.example']),
      attribute(EPPN, ['someone@elsewhere.example']),
    ];
    const result = applySAMLInstitutionScopePolicy(attributes, { state: 'unset' });
    expect(result.attributes).toBe(attributes);
    expect(result.withheld).toEqual([]);
  });
});

describe('a tenant with registered scopes', () => {
  const policy = set('example.ac.jp', 'med.example.ac.jp');

  it('releases a value under a registered scope, any of them', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(EPSA, ['member@example.ac.jp', 'staff@med.example.ac.jp']),
        attribute(EPPN, ['alice@med.example.ac.jp']),
      ],
      policy
    );
    expect(result.attributes).toEqual([
      attribute(EPSA, ['member@example.ac.jp', 'staff@med.example.ac.jp']),
      attribute(EPPN, ['alice@med.example.ac.jp']),
    ]);
    expect(result.withheld).toEqual([]);
  });

  it('withholds a value under a scope that is not registered, and says which scope', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPSA, ['member@example.ac.jp', 'faculty@other.example'])],
      policy
    );
    expect(result.attributes).toEqual([attribute(EPSA, ['member@example.ac.jp'])]);
    expect(result.withheld).toEqual([
      {
        attribute: 'eduPersonScopedAffiliation',
        name: EPSA,
        reason: 'scope_not_registered',
        scope: 'other.example',
        count: 1,
      },
    ]);
  });

  it('does not take a registered scope as the suffix of another (no substring match)', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(EPPN, [
          'alice@notexample.ac.jp',
          'alice@example.ac.jp.evil.example',
          'alice@sub.example.ac.jp',
          'alice@EXAMPLE.AC.JP',
        ]),
      ],
      policy
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld.map((entry) => [entry.reason, entry.count])).toEqual([
      ['scope_not_registered', 1],
      ['scope_not_registered', 1],
      ['scope_not_registered', 1],
      ['scope_not_registered', 1],
    ]);
  });

  it('withholds a value with more than one @, whichever scope is last', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(EPPN, [
          'alice@rival.example@example.ac.jp',
          'a@b@evil.example',
          'a@@example.ac.jp',
        ]),
      ],
      policy
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld).toEqual([
      {
        attribute: 'eduPersonPrincipalName',
        name: EPPN,
        reason: 'value_malformed',
        count: 3,
      },
    ]);
  });

  it('gives no default scope to an empty value, or one of spaces', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPPN, ['', '   ', '\t', ' @example.ac.jp'])],
      policy
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld).toEqual([
      expect.objectContaining({ reason: 'value_malformed', count: 4 }),
    ]);
  });

  it('gives a value with no scope the default one (the first registered)', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPSA, ['member']), attribute(EPPN, ['alice'])],
      policy
    );
    expect(result.attributes).toEqual([
      attribute(EPSA, ['member@example.ac.jp']),
      attribute(EPPN, ['alice@example.ac.jp']),
    ]);
    expect(result.withheld).toEqual([]);
  });

  it('does not repeat a value that the default scope made the same as another', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPSA, ['member', 'member@example.ac.jp'])],
      policy
    );
    expect(result.attributes).toEqual([attribute(EPSA, ['member@example.ac.jp'])]);
  });

  it('withholds a value with nothing before or after the @', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPPN, ['@example.ac.jp', 'alice@'])],
      policy
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld).toEqual([
      {
        attribute: 'eduPersonPrincipalName',
        name: EPPN,
        reason: 'value_malformed',
        count: 2,
      },
    ]);
  });

  it('names a scope only when it is a domain name, never other text the person controls', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPPN, ['alice@secret person data', 'bob@UPPER.example'])],
      policy
    );
    expect(result.withheld.every((entry) => entry.scope === undefined)).toBe(true);
    expect(JSON.stringify(result.withheld)).not.toContain('secret');
    expect(JSON.stringify(result.withheld)).not.toContain('alice');
  });

  it('drops an attribute none of whose values can be released, and keeps the others', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(MAIL, ['alice@gmail.example'], 'mail'),
        attribute(EPSA, ['member@other.example']),
        attribute(EPPN, ['alice@example.ac.jp']),
      ],
      policy
    );
    expect(result.attributes.map((entry) => entry.name)).toEqual([MAIL, EPPN]);
    // mail is not scoped: the person's own domain there is no business of the tenant's scopes.
    expect(result.attributes[0].values).toEqual(['alice@gmail.example']);
  });

  it('counts what it withheld per attribute, reason and scope', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(EPSA, ['a@x.example', 'b@x.example', 'c@y.example']),
        attribute(EPPN, ['d@x.example']),
      ],
      policy
    );
    expect(result.withheld).toEqual([
      expect.objectContaining({
        attribute: 'eduPersonScopedAffiliation',
        scope: 'x.example',
        count: 2,
      }),
      expect.objectContaining({
        attribute: 'eduPersonScopedAffiliation',
        scope: 'y.example',
        count: 1,
      }),
      expect.objectContaining({
        attribute: 'eduPersonPrincipalName',
        scope: 'x.example',
        count: 1,
      }),
    ]);
  });
});

describe('a tenant whose scopes cannot be trusted', () => {
  it('withholds every scoped value when the saved scopes are not valid, and keeps other attributes', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(MAIL, ['a@b.example']), attribute(EPSA, ['member@example.ac.jp', 'x'])],
      { state: 'invalid' }
    );
    expect(result.attributes).toEqual([attribute(MAIL, ['a@b.example'])]);
    expect(result.withheld).toEqual([
      {
        attribute: 'eduPersonScopedAffiliation',
        name: EPSA,
        reason: 'institution_scopes_invalid',
        count: 2,
      },
    ]);
  });

  it('withholds every scoped value when the settings cannot be read', () => {
    const result = applySAMLInstitutionScopePolicy(
      [attribute(EPPN, ['alice@example.ac.jp']), attribute(MAIL, ['a@b.example'])],
      { state: 'unavailable' }
    );
    expect(result.attributes).toEqual([attribute(MAIL, ['a@b.example'])]);
    expect(result.withheld).toEqual([
      expect.objectContaining({
        attribute: 'eduPersonPrincipalName',
        reason: 'institution_settings_unavailable',
        count: 1,
      }),
    ]);
  });
});

describe('the attributes that name the institution', () => {
  const registered = set('example.ac.jp', 'med.example.ac.jp');
  const names = ['例大学', 'Example University'];
  const apply = (
    attributes: SAMLAttribute[],
    policy: SAMLInstitutionScopePolicy,
    registeredNames = names
  ) => applySAMLInstitutionScopePolicy(attributes, policy, scopedAttributeKind, registeredNames);

  it('releases schacHomeOrganization when it is a registered scope, exactly', () => {
    const result = apply([attribute(SCHAC, ['example.ac.jp', 'med.example.ac.jp'])], registered);
    expect(result.attributes).toEqual([attribute(SCHAC, ['example.ac.jp', 'med.example.ac.jp'])]);
    expect(result.withheld).toEqual([]);
  });

  it('withholds a schacHomeOrganization that is not a registered scope, and says which domain', () => {
    const result = apply(
      [
        attribute(SCHAC, [
          'rival.example',
          'example.ac.jp',
          'EXAMPLE.AC.JP',
          'sub.example.ac.jp',
          '',
        ]),
      ],
      registered
    );
    expect(result.attributes).toEqual([attribute(SCHAC, ['example.ac.jp'])]);
    expect(result.withheld).toEqual([
      {
        attribute: 'schacHomeOrganization',
        name: SCHAC,
        reason: 'organization_not_registered',
        scope: 'rival.example',
        count: 1,
      },
      // What is not a domain name is not named.
      {
        attribute: 'schacHomeOrganization',
        name: SCHAC,
        reason: 'organization_not_registered',
        count: 2,
      },
      expect.objectContaining({ scope: 'sub.example.ac.jp', count: 1 }),
    ]);
  });

  it('releases the organization name when it is a registered name in any language, exactly', () => {
    const result = apply([attribute(ORG_NAME, ['Example University', '例大学'])], registered);
    expect(result.attributes).toEqual([attribute(ORG_NAME, ['Example University', '例大学'])]);
  });

  it('withholds an organization name that is not registered, and never names it', () => {
    const result = apply(
      [attribute(ORG_NAME, ['Rival University', 'example university', 'Example University '])],
      registered
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld).toEqual([
      {
        attribute: 'organizationName',
        name: ORG_NAME,
        reason: 'organization_not_registered',
        count: 3,
      },
    ]);
    expect(JSON.stringify(result.withheld)).not.toContain('Rival');
  });

  it('holds both to the registered values when only the names, or only the scopes, are registered', () => {
    expect(
      apply([attribute(SCHAC, ['example.ac.jp']), attribute(ORG_NAME, ['Example University'])], {
        state: 'unset',
      }).attributes
    ).toEqual([attribute(ORG_NAME, ['Example University'])]);
    expect(apply([attribute(ORG_NAME, ['Example University'])], registered, []).attributes).toEqual(
      []
    );
  });

  it('withholds both when the saved scopes are not valid or the settings cannot be read', () => {
    for (const [policy, reason] of [
      [{ state: 'invalid' }, 'institution_scopes_invalid'],
      [{ state: 'unavailable' }, 'institution_settings_unavailable'],
    ] as const) {
      const result = apply(
        [attribute(SCHAC, ['example.ac.jp']), attribute(ORG_NAME, ['Example University'])],
        policy
      );
      expect(result.attributes).toEqual([]);
      expect(result.withheld.map((entry) => entry.reason)).toEqual([reason, reason]);
    }
  });

  it('withholds both for a tenant that registered nothing: it has no institution to name', () => {
    const result = apply(
      [attribute(SCHAC, ['rival.example']), attribute(ORG_NAME, ['Rival University'])],
      { state: 'unset' },
      []
    );
    expect(result.attributes).toEqual([]);
    expect(result.withheld).toEqual([
      {
        attribute: 'schacHomeOrganization',
        name: SCHAC,
        reason: 'institution_not_registered',
        // No scope is named here: the tenant has none, and the value is the person's.
        count: 1,
      },
      {
        attribute: 'organizationName',
        name: ORG_NAME,
        reason: 'institution_not_registered',
        count: 1,
      },
    ]);
    expect(JSON.stringify(result.withheld)).not.toContain('Rival');
    expect(JSON.stringify(result.withheld)).not.toContain('rival.example');
  });

  it('withholds them for such a tenant whatever the value, even one that looks right', () => {
    const result = apply(
      [attribute(SCHAC, ['example.ac.jp', '']), attribute(ORG_NAME, ['Example University'])],
      { state: 'unset' },
      []
    );
    expect(result.attributes).toEqual([]);
    // Both values of schacHomeOrganization, and the one of o.
    expect(result.withheld.map((entry) => [entry.attribute, entry.reason, entry.count])).toEqual([
      ['schacHomeOrganization', 'institution_not_registered', 2],
      ['organizationName', 'institution_not_registered', 1],
    ]);
  });

  it('still releases the scoped values of such a tenant as they come, beside the withheld ones', () => {
    const eppn = attribute(EPPN, ['someone@elsewhere.example']);
    const epsa = attribute(EPSA, ['member@anywhere.example']);
    const result = apply(
      [eppn, attribute(SCHAC, ['rival.example']), epsa, attribute(ORG_NAME, ['Rival University'])],
      { state: 'unset' },
      []
    );
    expect(result.attributes).toEqual([eppn, epsa]);
    expect(result.withheld.map((entry) => entry.attribute)).toEqual([
      'schacHomeOrganization',
      'organizationName',
    ]);
  });

  it('keeps to the existing rule when only the scopes are registered: scope for schacHomeOrganization, name for o', () => {
    const result = apply(
      [
        attribute(SCHAC, ['example.ac.jp', 'rival.example']),
        attribute(ORG_NAME, ['Example University']),
      ],
      registered,
      []
    );
    expect(result.attributes).toEqual([attribute(SCHAC, ['example.ac.jp'])]);
    expect(result.withheld.map((entry) => entry.reason)).toEqual([
      'organization_not_registered',
      'organization_not_registered',
    ]);
  });

  it('keeps to the existing rule when only the names are registered', () => {
    const result = apply(
      [attribute(SCHAC, ['example.ac.jp']), attribute(ORG_NAME, ['Example University'])],
      { state: 'unset' }
    );
    expect(result.attributes).toEqual([attribute(ORG_NAME, ['Example University'])]);
    expect(result.withheld).toEqual([
      expect.objectContaining({
        attribute: 'schacHomeOrganization',
        reason: 'organization_not_registered',
      }),
    ]);
  });

  it('does not touch the scoped affiliation of a tenant that registered names but no scope', () => {
    const attributes = [attribute(EPSA, ['member@rival.example'])];
    expect(apply(attributes, { state: 'unset' }).attributes).toEqual(attributes);
  });
});

describe('a tenant whose saved names are not valid', () => {
  it('withholds the scoped values and the attributes that name the institution, with its own reason', () => {
    const result = applySAMLInstitutionScopePolicy(
      [
        attribute(EPSA, ['member@example.ac.jp']),
        attribute(SCHAC, ['example.ac.jp']),
        attribute(ORG_NAME, ['Example University']),
        attribute(MAIL, ['a@b.example'], 'mail'),
      ],
      { state: 'names_invalid' },
      scopedAttributeKind,
      []
    );
    expect(result.attributes).toEqual([attribute(MAIL, ['a@b.example'], 'mail')]);
    expect(result.withheld.map((entry) => [entry.attribute, entry.reason])).toEqual([
      ['eduPersonScopedAffiliation', 'institution_names_invalid'],
      ['schacHomeOrganization', 'institution_names_invalid'],
      ['organizationName', 'institution_names_invalid'],
    ]);
  });
});
