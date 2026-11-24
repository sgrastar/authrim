/**
 * SCIM mapper conversion and validation - mutation-hardening tests
 *
 * Exact-value assertions on resource mapping, ETags and the error lists of the validators.
 */

import { describe, it, expect } from 'vitest';
import {
  userToScim,
  groupToScim,
  scimToGroup,
  parseEtag,
  validateScimUser,
  validateScimGroup,
  validateScimPatchOp,
  type InternalUser,
  type InternalGroup,
} from '../utils/scim-mapper';
import { SCIM_SCHEMAS } from '../types/scim';
import type { ScimGroup, ScimUser } from '../types/scim';

const baseUrl = 'https://auth.example.com';
const ENTERPRISE = SCIM_SCHEMAS.ENTERPRISE_USER;

function internalUser(overrides: Partial<InternalUser> = {}): InternalUser {
  return {
    id: 'u1',
    email: 'u1@example.com',
    email_verified: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('userToScim details', () => {
  it('maps the core fields exactly', () => {
    expect(
      userToScim(
        internalUser({
          external_id: 'ext-1',
          preferred_username: 'uone',
          name: 'U One',
          nickname: 'one',
          profile: 'https://example.com/u1',
          locale: 'ja-JP',
          zoneinfo: 'Asia/Tokyo',
          given_name: 'U',
          family_name: 'One',
          middle_name: 'M',
          phone_number: '+81 3 0000 0000',
          active: 1,
        }),
        { baseUrl }
      )
    ).toEqual({
      schemas: [SCIM_SCHEMAS.USER],
      id: 'u1',
      externalId: 'ext-1',
      userName: 'uone',
      name: { formatted: 'U One', givenName: 'U', familyName: 'One', middleName: 'M' },
      displayName: 'U One',
      nickName: 'one',
      profileUrl: 'https://example.com/u1',
      preferredLanguage: 'ja-JP',
      locale: 'ja-JP',
      timezone: 'Asia/Tokyo',
      active: true,
      emails: [{ value: 'u1@example.com', type: 'work', primary: true }],
      phoneNumbers: [{ value: '+81 3 0000 0000', type: 'work', primary: true }],
      meta: {
        resourceType: 'User',
        created: '2024-01-01T00:00:00.000Z',
        lastModified: '2024-01-02T00:00:00.000Z',
        location: 'https://auth.example.com/scim/v2/Users/u1',
        version: 'W/"1704153600000"',
      },
    });
  });

  it('falls back to the email as user name and omits empty optional fields', () => {
    const user = userToScim(internalUser(), { baseUrl });
    expect(user.userName).toBe('u1@example.com');
    expect(user.name).toBeUndefined();
    expect(user.phoneNumbers).toBeUndefined();
    expect(user.addresses).toBeUndefined();
    expect(user.groups).toBeUndefined();
    expect(user.schemas).toEqual([SCIM_SCHEMAS.USER]);
  });

  it.each([
    ['given_name', { given_name: 'G' }, { givenName: 'G' }],
    ['family_name', { family_name: 'F' }, { familyName: 'F' }],
    ['middle_name', { middle_name: 'M' }, { middleName: 'M' }],
  ])('builds a name from %s alone', (_label, fields, expected) => {
    expect(userToScim(internalUser(fields), { baseUrl }).name).toEqual({
      formatted: undefined,
      givenName: undefined,
      familyName: undefined,
      middleName: undefined,
      ...expected,
    });
  });

  it.each([
    [undefined, true],
    [1, true],
    [0, false],
  ])('maps active %s to %s', (active, expected) => {
    expect(userToScim(internalUser({ active }), { baseUrl }).active).toBe(expected);
  });

  it('marks the address from address_json as primary', () => {
    const user = userToScim(
      internalUser({
        address_json: JSON.stringify({
          formatted: 'F',
          street_address: 'S',
          locality: 'L',
          region: 'R',
          postal_code: 'P',
          country: 'C',
        }),
      }),
      { baseUrl }
    );
    expect(user.addresses).toEqual([
      {
        formatted: 'F',
        streetAddress: 'S',
        locality: 'L',
        region: 'R',
        postalCode: 'P',
        country: 'C',
        primary: true,
      },
    ]);
  });

  it('ignores an address that is not JSON', () => {
    expect(
      userToScim(internalUser({ address_json: '{bad' }), { baseUrl }).addresses
    ).toBeUndefined();
  });

  it('only lists groups when asked to', () => {
    const groups = [{ value: 'g1', display: 'G1' }] as ScimUser['groups'];
    expect(userToScim(internalUser(), { baseUrl, groups }).groups).toBeUndefined();
    expect(
      userToScim(internalUser(), { baseUrl, includeGroups: false, groups }).groups
    ).toBeUndefined();
    expect(userToScim(internalUser(), { baseUrl, includeGroups: true, groups }).groups).toEqual(
      groups
    );
    expect(userToScim(internalUser(), { baseUrl, includeGroups: true }).groups).toEqual([]);
  });

  it('reads title and user type from the custom attributes in either spelling', () => {
    const snake = userToScim(
      internalUser({ custom_attributes_json: JSON.stringify({ title: 'Dr', user_type: 'staff' }) }),
      { baseUrl }
    );
    expect([snake.title, snake.userType]).toEqual(['Dr', 'staff']);
    const camel = userToScim(
      internalUser({ custom_attributes_json: JSON.stringify({ userType: 'guest' }) }),
      { baseUrl }
    );
    expect(camel.userType).toBe('guest');
    const empty = userToScim(
      internalUser({ custom_attributes_json: JSON.stringify({ title: '', user_type: 7 }) }),
      { baseUrl }
    );
    expect([empty.title, empty.userType]).toEqual([undefined, undefined]);
  });

  it.each([
    ['employee_number', { employee_number: 'E1' }, { employeeNumber: 'E1' }],
    ['employeeNumber', { employeeNumber: 'E2' }, { employeeNumber: 'E2' }],
    ['cost_center', { cost_center: 'C1' }, { costCenter: 'C1' }],
    ['costCenter', { costCenter: 'C2' }, { costCenter: 'C2' }],
    ['organization', { organization: 'O' }, { organization: 'O' }],
    ['division', { division: 'D' }, { division: 'D' }],
    ['department', { department: 'P' }, { department: 'P' }],
  ])('builds the enterprise extension from %s alone', (_label, custom, expected) => {
    const user = userToScim(internalUser({ custom_attributes_json: JSON.stringify(custom) }), {
      baseUrl,
    }) as unknown as Record<string, unknown>;
    expect(user.schemas).toEqual([SCIM_SCHEMAS.USER, ENTERPRISE]);
    expect(user[ENTERPRISE]).toEqual({
      employeeNumber: undefined,
      costCenter: undefined,
      organization: undefined,
      division: undefined,
      department: undefined,
      manager: undefined,
      ...expected,
    });
  });

  it.each([
    ['a string', 'm1'],
    ['an object with a string value', { value: 'm1', displayName: 'M' }],
  ])('links the manager given as %s', (_label, manager) => {
    const user = userToScim(internalUser({ custom_attributes_json: JSON.stringify({ manager }) }), {
      baseUrl,
    }) as unknown as Record<string, { manager: unknown }>;
    expect(user[ENTERPRISE].manager).toEqual({
      value: 'm1',
      $ref: 'https://auth.example.com/scim/v2/Users/m1',
    });
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['an object without a value', { displayName: 'M' }],
    ['an object with a numeric value', { value: 5 }],
    ['an empty string', ''],
  ])('has no enterprise extension for a manager that is %s', (_label, manager) => {
    const user = userToScim(internalUser({ custom_attributes_json: JSON.stringify({ manager }) }), {
      baseUrl,
    }) as unknown as Record<string, unknown>;
    expect(user.schemas).toEqual([SCIM_SCHEMAS.USER]);
    expect(user[ENTERPRISE]).toBeUndefined();
  });

  it('has no enterprise extension without enterprise attributes or with bad JSON', () => {
    for (const json of [JSON.stringify({ other: 'x' }), '{bad']) {
      const user = userToScim(internalUser({ custom_attributes_json: json }), {
        baseUrl,
      }) as unknown as Record<string, unknown>;
      expect(user.schemas).toEqual([SCIM_SCHEMAS.USER]);
      expect(user[ENTERPRISE]).toBeUndefined();
    }
  });
});

describe('groupToScim and scimToGroup details', () => {
  const group: InternalGroup = {
    id: 'g1',
    name: 'Admins',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-02-01T00:00:00Z',
    external_id: 'ext-g1',
  };
  const members = [{ user_id: 'u1', email: 'u1@example.com' }];

  it('maps a group with its members', () => {
    expect(groupToScim(group, { baseUrl }, members)).toEqual({
      schemas: [SCIM_SCHEMAS.GROUP],
      id: 'g1',
      externalId: 'ext-g1',
      displayName: 'Admins',
      meta: {
        resourceType: 'Group',
        created: '2024-01-01T00:00:00.000Z',
        lastModified: '2024-02-01T00:00:00.000Z',
        location: 'https://auth.example.com/scim/v2/Groups/g1',
        version: 'W/"1706745600000"',
      },
      members: [
        {
          value: 'u1',
          $ref: 'https://auth.example.com/scim/v2/Users/u1',
          type: 'User',
          display: 'u1@example.com',
        },
      ],
    });
  });

  it('uses the creation time as modification time when there is no update', () => {
    const { updated_at: _unused, ...withoutUpdate } = group;
    expect(groupToScim(withoutUpdate, { baseUrl }).meta.lastModified).toBe(
      '2024-01-01T00:00:00.000Z'
    );
  });

  it('omits members when empty, absent or switched off', () => {
    expect('members' in groupToScim(group, { baseUrl }, [])).toBe(false);
    expect('members' in groupToScim(group, { baseUrl })).toBe(false);
    expect('members' in groupToScim(group, { baseUrl, includeMembers: false }, members)).toBe(
      false
    );
  });

  it('keeps only the fields that are set when converting back', () => {
    expect(scimToGroup({ externalId: 'e', displayName: 'N' })).toStrictEqual({
      external_id: 'e',
      name: 'N',
    });
    expect(scimToGroup({ externalId: '', displayName: '' })).toStrictEqual({});
    expect(scimToGroup({})).toStrictEqual({});
  });
});

describe('parseEtag details', () => {
  it('strips a leading weak marker and a trailing quote only', () => {
    expect(parseEtag('W/"123"')).toBe('123');
    expect(parseEtag('"123"')).toBe('"123');
    expect(parseEtag('123')).toBe('123');
    expect(parseEtag('xW/"1"')).toBe('xW/"1');
    expect(parseEtag('W/"a"b"')).toBe('a"b');
  });
});

describe('validateScimUser details', () => {
  const valid = (user: Partial<ScimUser>) => validateScimUser(user);
  const asUser = (value: unknown) => value as Partial<ScimUser>;

  it('accepts a minimal user', () => {
    expect(valid({ userName: 'u' })).toEqual({ valid: true, errors: [] });
  });

  it.each([
    [undefined, 'userName is required'],
    [5, 'userName is required'],
    ['', 'userName is required'],
    ['   ', 'userName is required'],
  ])('rejects user name %j', (userName, message) => {
    expect(validateScimUser(asUser({ userName }))).toEqual({ valid: false, errors: [message] });
  });

  it('limits the user name to 1024 bytes after trimming', () => {
    expect(valid({ userName: `${'a'.repeat(1024)} ` }).valid).toBe(true);
    expect(valid({ userName: ' '.concat('a'.repeat(1024)) }).valid).toBe(true);
    expect(valid({ userName: 'a'.repeat(1025) })).toEqual({
      valid: false,
      errors: ['userName is invalid'],
    });
    expect(valid({ userName: 'é'.repeat(512) }).valid).toBe(true);
    expect(valid({ userName: 'é'.repeat(513) }).valid).toBe(false);
  });

  it.each(['a\u0000b', 'a\tb', 'a\u001fb', 'a\u007fb', 'a\nb'])(
    'rejects control characters in %j',
    (userName) => {
      expect(valid({ userName })).toEqual({ valid: false, errors: ['userName is invalid'] });
    }
  );

  it.each([
    'externalId',
    'displayName',
    'nickName',
    'profileUrl',
    'title',
    'userType',
    'preferredLanguage',
    'locale',
    'timezone',
  ])('requires %s to be a string', (attribute) => {
    expect(validateScimUser(asUser({ userName: 'u', [attribute]: 5 }))).toEqual({
      valid: false,
      errors: [`${attribute} must be a string`],
    });
    expect(validateScimUser(asUser({ userName: 'u', [attribute]: null })).errors).toEqual([
      `${attribute} must be a string`,
    ]);
    expect(validateScimUser(asUser({ userName: 'u', [attribute]: 'ok' }))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('requires active to be a boolean', () => {
    expect(validateScimUser(asUser({ userName: 'u', active: 'yes' })).errors).toEqual([
      'active must be a boolean',
    ]);
    expect(validateScimUser(asUser({ userName: 'u', active: false })).errors).toEqual([]);
  });

  it('checks the name object and each of its fields', () => {
    const fields = [
      'formatted',
      'familyName',
      'givenName',
      'middleName',
      'honorificPrefix',
      'honorificSuffix',
    ];
    const name = Object.fromEntries(fields.map((field) => [field, 1]));
    expect(validateScimUser(asUser({ userName: 'u', name })).errors).toEqual(
      fields.map((field) => `name.${field} must be a string`)
    );
    for (const bad of ['text', null, 5, []]) {
      expect(validateScimUser(asUser({ userName: 'u', name: bad })).errors).toEqual([
        'name must be an object',
      ]);
    }
  });

  it('checks the emails list', () => {
    expect(validateScimUser(asUser({ userName: 'u', emails: 'x' })).errors).toEqual([
      'emails must be an array',
    ]);
    expect(validateScimUser(asUser({ userName: 'u', emails: [null, 'x', [], 5] })).errors).toEqual([
      'emails[0] must be an object',
      'emails[1] must be an object',
      'emails[2] must be an object',
      'emails[3] must be an object',
    ]);
    expect(
      validateScimUser(
        asUser({
          userName: 'u',
          emails: [
            { value: 5 },
            { value: 'a@b.c', primary: 'x' },
            { value: 'ok@b.c', primary: true },
          ],
        })
      ).errors
    ).toEqual(['emails[0].value is invalid', 'emails[1].primary must be a boolean']);
  });

  it.each([
    ['a@b.c', true],
    ['  a@b.c  ', true],
    ['', false],
    ['   ', false],
    ['@b.c', false],
    ['a@', false],
    ['a@@b.c', false],
    ['a@b@c', false],
    ['ab.c', false],
    ['a b@c.d', false],
    ['a\t@c.d', false],
    ['a​@c.d', false],
    ['a\u0001@c.d', false],
    [`${'a'.repeat(316)}@b.c`, true],
    [`${'a'.repeat(317)}@b.c`, false],
    ['é'.repeat(158) + '@b.c', true],
    ['é'.repeat(159) + '@b.c', false],
  ])('judges the email %j valid=%s', (value, ok) => {
    const result = validateScimUser(asUser({ userName: 'u', emails: [{ value }] }));
    expect(result.errors).toEqual(ok ? [] : ['emails[0].value is invalid']);
  });

  it('checks phone numbers and addresses as multi-valued attributes', () => {
    expect(validateScimUser(asUser({ userName: 'u', phoneNumbers: 'x' })).errors).toEqual([
      'phoneNumbers must be an array',
    ]);
    expect(
      validateScimUser(asUser({ userName: 'u', phoneNumbers: [null, [], 'x'] })).errors
    ).toEqual([
      'phoneNumbers[0] must be an object',
      'phoneNumbers[1] must be an object',
      'phoneNumbers[2] must be an object',
    ]);
    expect(
      validateScimUser(
        asUser({ userName: 'u', phoneNumbers: [{ value: 1, type: 2, primary: 'x' }] })
      ).errors
    ).toEqual([
      'phoneNumbers[0].value must be a string',
      'phoneNumbers[0].type must be a string',
      'phoneNumbers[0].primary must be a boolean',
    ]);
    const address = Object.fromEntries(
      ['formatted', 'streetAddress', 'locality', 'region', 'postalCode', 'country', 'type'].map(
        (field) => [field, 1]
      )
    );
    expect(
      validateScimUser(asUser({ userName: 'u', addresses: [address, { primary: 1 }] })).errors
    ).toEqual([
      'addresses[0].formatted must be a string',
      'addresses[0].streetAddress must be a string',
      'addresses[0].locality must be a string',
      'addresses[0].region must be a string',
      'addresses[0].postalCode must be a string',
      'addresses[0].country must be a string',
      'addresses[0].type must be a string',
      'addresses[1].primary must be a boolean',
    ]);
    expect(
      validateScimUser(asUser({ userName: 'u', phoneNumbers: [{ value: 'x', primary: true }] }))
        .errors
    ).toEqual([]);
  });

  it('checks the enterprise extension and its manager', () => {
    const fields = ['employeeNumber', 'costCenter', 'organization', 'division', 'department'];
    const enterprise = Object.fromEntries(fields.map((field) => [field, 1]));
    expect(validateScimUser(asUser({ userName: 'u', [ENTERPRISE]: enterprise })).errors).toEqual(
      fields.map((field) => `${ENTERPRISE}.${field} must be a string`)
    );
    expect(validateScimUser(asUser({ userName: 'u', [ENTERPRISE]: 'x' })).errors).toEqual([
      `${ENTERPRISE} must be an object`,
    ]);
    expect(validateScimUser(asUser({ userName: 'u', [ENTERPRISE]: [] })).errors).toEqual([
      `${ENTERPRISE} must be an object`,
    ]);
    expect(
      validateScimUser(asUser({ userName: 'u', [ENTERPRISE]: { manager: 'm' } })).errors
    ).toEqual([`${ENTERPRISE}.manager must be an object`]);
    expect(
      validateScimUser(
        asUser({ userName: 'u', [ENTERPRISE]: { manager: { value: 1, $ref: 2, displayName: 3 } } })
      ).errors
    ).toEqual([
      `${ENTERPRISE}.manager.value must be a string`,
      `${ENTERPRISE}.manager.$ref must be a string`,
      `${ENTERPRISE}.manager.displayName must be a string`,
    ]);
    expect(
      validateScimUser(asUser({ userName: 'u', [ENTERPRISE]: { manager: { value: 'm' } } })).errors
    ).toEqual([]);
  });

  it('adds the errors of the assurance extension', () => {
    expect(
      validateScimUser(asUser({ userName: 'u', [SCIM_SCHEMAS.ASSURANCE_USER]: 'x' })).errors
    ).toEqual([`${SCIM_SCHEMAS.ASSURANCE_USER} must be an object`]);
  });
});

describe('validateScimPatchOp details', () => {
  const PATCH = SCIM_SCHEMAS.PATCH_OP;
  const schemasError = `schemas must include ${PATCH}`;
  const patchOp = (operations: unknown, schemas: unknown = [PATCH]) => ({
    schemas,
    Operations: operations,
  });

  it.each([null, undefined, 'x', 5, []])('rejects %j as a request', (value) => {
    expect(validateScimPatchOp(value)).toEqual({
      valid: false,
      errors: ['Patch request must be an object'],
    });
  });

  it.each([
    ['missing', undefined],
    ['not an array', PATCH],
    ['holding a non-string', [5, PATCH]],
    ['without the PatchOp URN', [SCIM_SCHEMAS.USER]],
  ])('requires the PatchOp schema (%s)', (_label, schemas) => {
    expect(validateScimPatchOp({ schemas, Operations: [{ op: 'remove', path: 'a' }] })).toEqual({
      valid: false,
      errors: [schemasError],
    });
  });

  it('accepts the PatchOp schema among others', () => {
    expect(
      validateScimPatchOp(patchOp([{ op: 'remove', path: 'a' }], [SCIM_SCHEMAS.USER, PATCH]))
    ).toEqual({ valid: true, errors: [] });
  });

  it.each([undefined, [], 'x', {}])(
    'requires a non-empty Operations array, got %j',
    (operations) => {
      expect(validateScimPatchOp(patchOp(operations))).toEqual({
        valid: false,
        errors: ['Operations must be a non-empty array'],
      });
    }
  );

  it('reports both the schema and the Operations problem', () => {
    expect(validateScimPatchOp({ schemas: [], Operations: [] })).toEqual({
      valid: false,
      errors: [schemasError, 'Operations must be a non-empty array'],
    });
  });

  it('requires every operation to be an object', () => {
    expect(validateScimPatchOp(patchOp([null, 'x', [], 5])).errors).toEqual([
      'Operations[0] must be an object',
      'Operations[1] must be an object',
      'Operations[2] must be an object',
      'Operations[3] must be an object',
    ]);
  });

  it.each(['add', 'remove', 'replace', 'ADD', 'Remove', 'REPLACE'])(
    'accepts the operation %s',
    (op) => {
      expect(validateScimPatchOp(patchOp([{ op, path: 'a', value: 'x' }]))).toEqual({
        valid: true,
        errors: [],
      });
    }
  );

  it.each([[undefined], [5], [''], ['move'], ['copy']])('rejects the operation name %j', (op) => {
    expect(validateScimPatchOp(patchOp([{ op, path: 'a' }]))).toEqual({
      valid: false,
      errors: ['Operations[0].op is unsupported'],
    });
  });

  it('requires a path to be a string', () => {
    expect(validateScimPatchOp(patchOp([{ op: 'remove', path: 5 }])).errors).toEqual([
      'Operations[0].path must be a string',
    ]);
    expect(validateScimPatchOp(patchOp([{ op: 'remove', path: null }])).errors).toEqual([
      'Operations[0].path must be a string',
    ]);
  });

  it.each([
    ['add', undefined],
    ['replace', undefined],
    ['add', null],
    ['replace', 'text'],
    ['add', 5],
    ['replace', []],
    ['REPLACE', false],
  ])('requires an object value for %s without a path (value %j)', (op, value) => {
    expect(validateScimPatchOp(patchOp([{ op, value }]))).toEqual({
      valid: false,
      errors: ['Operations[0].value must be an object when path is omitted'],
    });
  });

  it('accepts an object value without a path, and remove without a path or value', () => {
    expect(validateScimPatchOp(patchOp([{ op: 'add', value: { a: 1 } }])).errors).toEqual([]);
    expect(validateScimPatchOp(patchOp([{ op: 'replace', value: {} }])).errors).toEqual([]);
    expect(validateScimPatchOp(patchOp([{ op: 'remove' }])).errors).toEqual([]);
  });

  it('numbers the errors by operation', () => {
    expect(
      validateScimPatchOp(
        patchOp([
          { op: 'remove', path: 'a' },
          { op: 'bogus', path: 'b' },
        ])
      ).errors
    ).toEqual(['Operations[1].op is unsupported']);
  });
});

describe('validateScimGroup details', () => {
  const asGroup = (value: unknown) => value as Partial<ScimGroup>;

  it.each([undefined, 5, '', '   '])('requires a display name, got %j', (displayName) => {
    expect(validateScimGroup(asGroup({ displayName }))).toEqual({
      valid: false,
      errors: ['displayName is required'],
    });
  });

  it('requires external id to be a string', () => {
    expect(validateScimGroup(asGroup({ displayName: 'g', externalId: 5 }))).toEqual({
      valid: false,
      errors: ['externalId must be a string'],
    });
    expect(validateScimGroup(asGroup({ displayName: 'g', externalId: 'e' })).valid).toBe(true);
  });

  it('requires members to be an array of objects with a string value', () => {
    expect(validateScimGroup(asGroup({ displayName: 'g', members: 'x' }))).toEqual({
      valid: false,
      errors: ['members must be an array'],
    });
    expect(
      validateScimGroup(
        asGroup({ displayName: 'g', members: [null, 'x', [], { value: 5 }, {}, { value: 'u1' }] })
      ).errors
    ).toEqual([
      'members[0] must be an object',
      'members[1] must be an object',
      'members[2] must be an object',
      'members[3].value must be a string',
      'members[4].value must be a string',
    ]);
    expect(validateScimGroup(asGroup({ displayName: 'g', members: [] }))).toEqual({
      valid: true,
      errors: [],
    });
  });
});
