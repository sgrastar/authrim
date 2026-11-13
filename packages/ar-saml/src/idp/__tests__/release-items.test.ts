/**
 * The items of a SAML release and an approval applied to it (release-items.ts): one key per
 * kind, name and format; values only when shown and never for an item made once approved; the
 * NameID always required; a placeholder never released.
 */
import { describe, expect, it } from 'vitest';
import {
  applySAMLReleaseApproval,
  samlApprovalNeedsIdentifiers,
  samlAttributeItemKey,
  samlNameIdItemKey,
  samlReleaseItems,
  type SAMLAttributeRelease,
} from '../release-items';

const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const URI = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';

function release(overrides: Partial<SAMLAttributeRelease> = {}): SAMLAttributeRelease {
  return {
    attributes: [
      { name: 'mail', nameFormat: URI, friendlyName: 'mail', values: ['a@example.edu'] },
      { name: 'affiliation', nameFormat: URI, values: ['member', 'student'] },
      {
        name: 'eptid',
        nameFormat: URI,
        values: ['https://idp!https://sp!authrim-deferred-identifier'],
      },
    ],
    required: new Set(['mail']),
    labels: new Map([['mail', 'Email address']]),
    deferred: new Set(['eptid']),
    withheldScopedValues: [],
    optionalMissingAttributes: [],
    ...overrides,
  };
}

const user = { id: 'user-1', email: 'a@example.edu' } as never;

describe('the items of a SAML release', () => {
  it('lists the NameID first, then the attributes, with labels and required-ness', () => {
    const items = samlReleaseItems(release(), {
      nameIdFormat: PERSISTENT,
      userInfo: user,
      showValues: true,
    });
    expect(items).toEqual([
      {
        key: samlNameIdItemKey(PERSISTENT),
        kind: 'nameid',
        label: PERSISTENT,
        required: true,
        deferred: true,
      },
      {
        key: samlAttributeItemKey({ name: 'mail', nameFormat: URI }),
        kind: 'attribute',
        label: 'Email address',
        required: true,
        values: ['a@example.edu'],
      },
      {
        key: samlAttributeItemKey({ name: 'affiliation', nameFormat: URI }),
        kind: 'attribute',
        label: 'affiliation',
        required: false,
        values: ['member', 'student'],
      },
      {
        key: samlAttributeItemKey({ name: 'eptid', nameFormat: URI }),
        kind: 'attribute',
        label: 'eptid',
        required: false,
        deferred: true,
      },
    ]);
  });

  it('shows no value when the SP does not show them, and the email NameID only then', () => {
    const items = samlReleaseItems(release(), {
      nameIdFormat: EMAIL,
      userInfo: user,
      showValues: false,
    });
    expect(items.some((item) => 'values' in item)).toBe(false);
    expect(items[0]).not.toHaveProperty('deferred');
    expect(
      samlReleaseItems(release(), { nameIdFormat: EMAIL, userInfo: user, showValues: true })[0]
    ).toMatchObject({ values: ['a@example.edu'] });
  });

  it('keys the same name in two formats apart', () => {
    expect(samlAttributeItemKey({ name: 'mail', nameFormat: URI })).not.toBe(
      samlAttributeItemKey({ name: 'mail' })
    );
    expect(samlNameIdItemKey(EMAIL)).not.toBe(samlNameIdItemKey(PERSISTENT));
  });

  it('treats every attribute as required without a Destination Profile', () => {
    const items = samlReleaseItems(release({ required: 'all' }), {
      nameIdFormat: PERSISTENT,
      userInfo: user,
      showValues: true,
    });
    expect(items.every((item) => item.required)).toBe(true);
  });
});

describe('an approval applied to a SAML release', () => {
  const mail = samlAttributeItemKey({ name: 'mail', nameFormat: URI });
  const affiliation = samlAttributeItemKey({ name: 'affiliation', nameFormat: URI });
  const eptid = samlAttributeItemKey({ name: 'eptid', nameFormat: URI });
  const nameId = samlNameIdItemKey(PERSISTENT);

  it('releases the approved items only', () => {
    const applied = applySAMLReleaseApproval(release(), [nameId, mail], PERSISTENT);
    expect(applied).toEqual({ ok: true, attributes: [release().attributes[0]] });
  });

  it('refuses when a required item or the NameID was not approved', () => {
    expect(applySAMLReleaseApproval(release(), [nameId], PERSISTENT)).toEqual({
      ok: false,
      missing: ['mail'],
    });
    expect(applySAMLReleaseApproval(release(), [mail], PERSISTENT)).toEqual({
      ok: false,
      missing: ['NameID'],
    });
  });

  it('never releases a placeholder, even when approved', () => {
    const applied = applySAMLReleaseApproval(release(), [nameId, mail, eptid], PERSISTENT);
    expect(applied.ok && applied.attributes.map((attribute) => attribute.name)).toEqual(['mail']);
  });

  it('releases everything for a trusted SP and the required items for one that does not ask', () => {
    const all = applySAMLReleaseApproval(release(), ['*'], PERSISTENT);
    // A value still standing as a placeholder is left out (identifiers are made first).
    expect(all.ok && all.attributes.map((attribute) => attribute.name)).toEqual([
      'mail',
      'affiliation',
    ]);
    const required = applySAMLReleaseApproval(release(), ['@required'], PERSISTENT);
    expect(required.ok && required.attributes.map((attribute) => attribute.name)).toEqual(['mail']);
  });

  it('makes identifiers only when an approved item needs one', () => {
    expect(samlApprovalNeedsIdentifiers(release(), [nameId, mail, affiliation])).toBe(false);
    expect(samlApprovalNeedsIdentifiers(release(), [nameId, mail, eptid])).toBe(true);
    expect(samlApprovalNeedsIdentifiers(release(), ['*'])).toBe(true);
    expect(samlApprovalNeedsIdentifiers(release(), ['@required'])).toBe(false);
  });
});
