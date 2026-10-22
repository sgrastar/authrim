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
