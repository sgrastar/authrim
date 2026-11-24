import { describe, expect, it } from 'vitest';
import { adaptCsvPreview } from '../../adapters/csv';
import { adaptOidcClaimsPreview } from '../../adapters/oidc';
import { adaptSamlAttributesPreview } from '../../adapters/saml';
import { adaptScimUser, adaptScimUserPreview, SCIM_SOURCE_NAMESPACE } from '../../adapters/scim';
import { TEST_CATALOG, edge, fieldRef } from '../../test-support';

const canonicalEmail = {
  side: 'canonical' as const,
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};
const emailEdge = edge(fieldRef('csv', 'email', 'field.csv.email'), canonicalEmail);
const nameEdge = edge(fieldRef('csv', 'name'), { ...canonicalEmail, path: 'name' });

function expectedRules(edges: (typeof emailEdge)[]) {
  return edges.map((item) => ({
    id: item.id,
    targetRef: item.targetRef,
    edges: [item],
    transforms: [],
    output: { edgeIndex: 0 },
  }));
}

describe('csv adapter exact output', () => {
  it('reports one reason per missing required column and keeps present ones', () => {
    const result = adaptCsvPreview({
      row: { email: 'a@example.test', name: 'A' },
      columnToPath: { email: 'email', name: 'name' },
      requiredColumns: ['email', 'phone', 'dept'],
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
    });

    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual([
      { category: 'adapter', code: 'adapter.missing_column', severity: 'error' },
      { category: 'adapter', code: 'adapter.missing_column', severity: 'error' },
    ]);
    expect(result.input).toEqual({
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
      graphRules: expectedRules([emailEdge, nameEdge]),
      sourceValues: [
        {
          value: 'a@example.test',
          sourceRef: { side: 'source', namespace: 'csv', path: 'email' },
          metadata: { sourceType: 'csv', columnName: 'email', csvHeaderName: 'email' },
        },
        {
          value: 'A',
          sourceRef: { side: 'source', namespace: 'csv', path: 'name' },
          metadata: { sourceType: 'csv', columnName: 'name', csvHeaderName: 'name' },
        },
      ],
    });
  });

  it('succeeds without reasons when all required columns exist or none are required', () => {
    const base = {
      row: { email: 'a@example.test' },
      columnToPath: { email: 'email' },
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    };
    expect(adaptCsvPreview({ ...base, requiredColumns: ['email'] })).toMatchObject({
      status: 'success',
      reasons: [],
    });
    expect(adaptCsvPreview(base)).toMatchObject({ status: 'success', reasons: [] });
  });

  it('treats a present column with an undefined value as present', () => {
    const result = adaptCsvPreview({
      row: { email: undefined },
      columnToPath: { email: 'email' },
      requiredColumns: ['email'],
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
  });
});

describe('oidc adapter exact output', () => {
  it('accepts object and null claim requests and builds exact envelopes', () => {
    const result = adaptOidcClaimsPreview({
      claims: { email: { essential: true }, name: null },
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
    });

    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.input).toEqual({
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
      graphRules: expectedRules([emailEdge, nameEdge]),
      sourceValues: [
        {
          value: { essential: true },
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          metadata: { sourceType: 'oidc', oidcClaimName: 'email', fieldPath: 'email' },
        },
        {
          value: null,
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'name' },
          metadata: { sourceType: 'oidc', oidcClaimName: 'name', fieldPath: 'name' },
        },
      ],
    });
  });

  it('flags primitive claim requests as unsupported and still emits them', () => {
    const result = adaptOidcClaimsPreview({
      claims: { email: 'yes', flag: true, count: 3, ok: {} },
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });

    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual([
      { category: 'adapter', code: 'adapter.unsupported_claim_shape', severity: 'error' },
      { category: 'adapter', code: 'adapter.unsupported_claim_shape', severity: 'error' },
      { category: 'adapter', code: 'adapter.unsupported_claim_shape', severity: 'error' },
    ]);
    expect(result.input?.sourceValues.map((item) => item.value)).toEqual(['yes', true, 3, {}]);
  });
});

describe('saml adapter exact output', () => {
  it('collapses single values, keeps multi values, and records exact metadata', () => {
    const result = adaptSamlAttributesPreview({
      attributes: [
        { name: 'mail', nameFormat: 'urn:format', values: ['a@example.test'] },
        { name: 'groups', values: ['g1', 'g2'] },
        { name: 'empty', values: [] },
      ],
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
    });

    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.input).toEqual({
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
      graphRules: expectedRules([emailEdge, nameEdge]),
      sourceValues: [
        {
          value: 'a@example.test',
          sourceRef: { side: 'source', namespace: 'saml.attribute', path: 'mail' },
          metadata: {
            sourceType: 'saml',
            samlAttributeName: 'mail',
            samlNameFormat: 'urn:format',
          },
        },
        {
          value: ['g1', 'g2'],
          sourceRef: { side: 'source', namespace: 'saml.attribute', path: 'groups' },
          metadata: {
            sourceType: 'saml',
            samlAttributeName: 'groups',
            samlNameFormat: undefined,
          },
        },
        {
          value: [],
          sourceRef: { side: 'source', namespace: 'saml.attribute', path: 'empty' },
          metadata: { sourceType: 'saml', samlAttributeName: 'empty', samlNameFormat: undefined },
        },
      ],
    });
  });

  it('reports exactly one reason per malformed attribute', () => {
    const result = adaptSamlAttributesPreview({
      attributes: [
        { name: '', values: ['x'] },
        { name: 'ok', values: ['y'] },
        { name: 'bad', values: 'abc' as unknown as unknown[] },
      ],
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });

    expect(result.status).toBe('partial');
    expect(result.reasons).toEqual([
      { category: 'adapter', code: 'adapter.unsupported_attribute_shape', severity: 'error' },
      { category: 'adapter', code: 'adapter.unsupported_attribute_shape', severity: 'error' },
    ]);
  });

  it('flags only an empty name when values are a valid array', () => {
    const result = adaptSamlAttributesPreview({
      attributes: [{ name: '', values: [] }],
      catalog: TEST_CATALOG,
      edges: [],
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.input?.graphRules).toEqual([]);
  });

  it('flags only a non-array value when the name is present', () => {
    const result = adaptSamlAttributesPreview({
      attributes: [{ name: 'mail', values: 'abc' as unknown as unknown[] }],
      catalog: TEST_CATALOG,
      edges: [],
    });
    expect(result.reasons).toHaveLength(1);
  });
});

describe('scim adapter exact output', () => {
  const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

  function envelopeOf(path: string, value: unknown) {
    return {
      value,
      sourceRef: { side: 'source', namespace: 'scim.attribute', path },
      metadata: { sourceType: 'scim', scimPath: path, fieldPath: path },
    };
  }

  it('exposes the namespace constant and the preview alias', () => {
    expect(SCIM_SOURCE_NAMESPACE).toBe('scim.attribute');
    expect(adaptScimUserPreview).toBe(adaptScimUser);
  });

  it('maps every supported attribute to its own path in a stable order', () => {
    const emails = [
      { value: 'work@example.test', primary: false },
      { value: 'main@example.test', primary: true },
    ];
    const phoneNumbers = [{ value: '+1-555' }];
    const addresses = [{ city: 'A' }, { city: 'B', primary: true }];
    const groups = [{ value: 'g1' }];
    const result = adaptScimUser({
      user: {
        userName: 'u',
        externalId: 'x',
        active: false,
        displayName: 'dn',
        nickName: 'nn',
        profileUrl: 'https://p.example.test',
        title: 't',
        userType: 'ut',
        preferredLanguage: 'ja',
        locale: 'ja-JP',
        timezone: 'Asia/Tokyo',
        name: {
          formatted: 'f',
          givenName: 'g',
          familyName: 'fa',
          middleName: 'm',
          honorificPrefix: 'Dr',
          honorificSuffix: 'Jr',
        },
        emails,
        phoneNumbers,
        addresses,
        groups,
        [ENTERPRISE]: {
          employeeNumber: 'E1',
          costCenter: 'CC',
          organization: 'Org',
          division: 'Div',
          department: 'Dep',
          manager: { value: 'mgr' },
        },
      },
      catalog: TEST_CATALOG,
      edges: [emailEdge, nameEdge],
    });

    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.input?.catalog).toBe(TEST_CATALOG);
    expect(result.input?.edges).toEqual([emailEdge, nameEdge]);
    expect(result.input?.graphRules).toEqual(expectedRules([emailEdge, nameEdge]));
    expect(result.input?.sourceValues).toEqual([
      envelopeOf('userName', 'u'),
      envelopeOf('externalId', 'x'),
      envelopeOf('active', false),
      envelopeOf('displayName', 'dn'),
      envelopeOf('nickName', 'nn'),
      envelopeOf('profileUrl', 'https://p.example.test'),
      envelopeOf('title', 't'),
      envelopeOf('userType', 'ut'),
      envelopeOf('preferredLanguage', 'ja'),
      envelopeOf('locale', 'ja-JP'),
      envelopeOf('timezone', 'Asia/Tokyo'),
      envelopeOf('name.formatted', 'f'),
      envelopeOf('name.givenName', 'g'),
      envelopeOf('name.familyName', 'fa'),
      envelopeOf('name.middleName', 'm'),
      envelopeOf('name.honorificPrefix', 'Dr'),
      envelopeOf('name.honorificSuffix', 'Jr'),
      envelopeOf('emails', emails),
      envelopeOf('emails.value', 'main@example.test'),
      envelopeOf('phoneNumbers', phoneNumbers),
      envelopeOf('phoneNumbers.value', '+1-555'),
      envelopeOf('addresses', addresses),
      envelopeOf('addresses.primary', { city: 'B', primary: true }),
      envelopeOf('groups', groups),
      envelopeOf('enterprise.employeeNumber', 'E1'),
      envelopeOf('enterprise.costCenter', 'CC'),
      envelopeOf('enterprise.organization', 'Org'),
      envelopeOf('enterprise.division', 'Div'),
      envelopeOf('enterprise.department', 'Dep'),
      envelopeOf('enterprise.manager.value', 'mgr'),
    ]);
  });

  it('yields undefined values for an empty user without throwing', () => {
    const result = adaptScimUser({ user: {}, catalog: TEST_CATALOG, edges: [] });
    const values = result.input?.sourceValues ?? [];
    expect(values).toHaveLength(30);
    expect(values.every((item) => item.value === undefined)).toBe(true);
  });

  it('falls back to the first record when none is primary and ignores non-records', () => {
    const result = adaptScimUser({
      user: {
        emails: [
          'junk',
          null,
          [1],
          { value: 'first@example.test' },
          { value: 'second@example.test' },
        ],
        addresses: [{ city: 'A' }, { city: 'B' }],
      },
      catalog: TEST_CATALOG,
      edges: [],
    });
    const byPath = new Map(
      result.input?.sourceValues.map((item) => [item.sourceRef.path, item.value])
    );
    expect(byPath.get('emails.value')).toBe('first@example.test');
    expect(byPath.get('addresses.primary')).toEqual({ city: 'A' });
  });

  it('requires primary to be exactly true and handles non-array multi values', () => {
    const result = adaptScimUser({
      user: {
        emails: [
          { value: 'a', primary: 'true' },
          { value: 'b', primary: 1 },
        ],
        phoneNumbers: { value: 'not-an-array' },
        addresses: 'nope',
      },
      catalog: TEST_CATALOG,
      edges: [],
    });
    const byPath = new Map(
      result.input?.sourceValues.map((item) => [item.sourceRef.path, item.value])
    );
    expect(byPath.get('emails.value')).toBe('a');
    expect(byPath.get('phoneNumbers.value')).toBeUndefined();
    expect(byPath.get('addresses.primary')).toBeUndefined();
  });

  it('returns undefined for an empty or all-junk multi value list', () => {
    const result = adaptScimUser({
      user: { emails: [], phoneNumbers: ['x', 3] },
      catalog: TEST_CATALOG,
      edges: [],
    });
    const byPath = new Map(
      result.input?.sourceValues.map((item) => [item.sourceRef.path, item.value])
    );
    expect(byPath.get('emails.value')).toBeUndefined();
    expect(byPath.get('phoneNumbers.value')).toBeUndefined();
  });

  it('reads nested paths only through real objects', () => {
    const run = (user: Record<string, unknown>) => {
      const result = adaptScimUser({ user, catalog: TEST_CATALOG, edges: [] });
      return new Map(result.input?.sourceValues.map((item) => [item.sourceRef.path, item.value]));
    };
    expect(run({ name: 'plain' }).get('name.givenName')).toBeUndefined();
    expect(run({ name: null }).get('name.givenName')).toBeUndefined();
    expect(run({ name: { other: 'x' } }).get('name.givenName')).toBeUndefined();
    expect(run({ name: { givenName: undefined } }).get('name.givenName')).toBeUndefined();
    expect(
      run({ [ENTERPRISE]: { manager: 'flat' } }).get('enterprise.manager.value')
    ).toBeUndefined();
    expect(run({ [ENTERPRISE]: { manager: {} } }).get('enterprise.manager.value')).toBeUndefined();
    expect(
      run({ [ENTERPRISE]: [{ employeeNumber: 'E' }] }).get('enterprise.employeeNumber')
    ).toBeUndefined();
    expect(run({ [ENTERPRISE]: 'str' }).get('enterprise.employeeNumber')).toBeUndefined();
  });
});
