import { describe, expect, it } from 'vitest';
import {
  applyPatchOperations,
  selectPrimaryScimObject,
  selectPrimaryScimValue,
  userToScim,
  validateScimUser,
  type InternalUser,
} from '../utils/scim-mapper';
import { SCIM_SCHEMAS } from '../types/scim';

const baseUser = (overrides: Partial<InternalUser> = {}): InternalUser => ({
  id: 'user-contract',
  email: 'user.contract@example.com',
  email_verified: 1,
  preferred_username: 'user-contract',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  active: 1,
  ...overrides,
});

describe('SCIM user mapping contract', () => {
  it('converts a minimal internal user without inventing optional attributes', () => {
    const resource = userToScim(baseUser(), { baseUrl: 'https://id.example' });

    expect(resource).toMatchObject({
      schemas: [SCIM_SCHEMAS.USER],
      id: 'user-contract',
      userName: 'user-contract',
      active: true,
      emails: [{ value: 'user.contract@example.com', primary: true }],
    });
    expect(resource.name).toBeUndefined();
    expect(resource.phoneNumbers).toBeUndefined();
  });

  it('preserves Japanese, accents, emoji, symbols, and all mapped profile fields', () => {
    const displayName = '山田 Zoë 🚀 — R&D / 開発';
    const resource = userToScim(
      baseUser({
        external_id: '外部-ID-№42',
        name: displayName,
        given_name: '太郎',
        family_name: '山田',
        middle_name: 'Élodie 🚀',
        nickname: 'たろちゃん✨',
        profile: 'https://example.com/プロフィール?q=✓',
        phone_number: '+81-90-1234-5678',
        locale: 'ja-JP',
        zoneinfo: 'Asia/Tokyo',
        address_json: JSON.stringify({
          formatted: '東京都千代田区1–2–3 🏢',
          locality: '東京',
          country: 'JP',
        }),
        custom_attributes_json: JSON.stringify({
          employee_number: '社員-É-001',
          cost_center: '研究開発/R&D',
          organization: '株式会社例示',
          division: 'Platform 🚀',
          department: '認証・認可',
          manager: '管理者-001',
          title: 'Staff Engineer ⚙️',
          user_type: '正社員',
        }),
      }),
      { baseUrl: 'https://id.example' }
    );

    expect(resource).toMatchObject({
      externalId: '外部-ID-№42',
      displayName,
      name: { givenName: '太郎', familyName: '山田', middleName: 'Élodie 🚀' },
      nickName: 'たろちゃん✨',
      title: 'Staff Engineer ⚙️',
      userType: '正社員',
      locale: 'ja-JP',
      timezone: 'Asia/Tokyo',
      phoneNumbers: [{ value: '+81-90-1234-5678', primary: true }],
      addresses: [{ formatted: '東京都千代田区1–2–3 🏢', locality: '東京', country: 'JP' }],
      [SCIM_SCHEMAS.ENTERPRISE_USER]: {
        employeeNumber: '社員-É-001',
        costCenter: '研究開発/R&D',
        organization: '株式会社例示',
        division: 'Platform 🚀',
        department: '認証・認可',
        manager: { value: '管理者-001' },
      },
    });
    expect(JSON.stringify(resource)).toContain('🚀');
    expect(JSON.stringify(resource)).toContain('Zoë');
  });

  it('ignores unknown custom attributes instead of leaking them into the SCIM resource', () => {
    const resource = userToScim(
      baseUser({
        custom_attributes_json: JSON.stringify({
          unknown_secret: 'must-not-leak',
          anotherUnknownObject: { nested: true },
        }),
      }),
      { baseUrl: 'https://id.example' }
    );

    expect(resource.schemas).toEqual([SCIM_SCHEMAS.USER]);
    expect(JSON.stringify(resource)).not.toContain('must-not-leak');
    expect(JSON.stringify(resource)).not.toContain('anotherUnknownObject');
  });

  it('enforces the 1024-byte userName boundary without making email globally required', () => {
    expect(validateScimUser({ userName: 'a'.repeat(1024) })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateScimUser({ userName: 'a'.repeat(1025) })).toMatchObject({
      valid: false,
      errors: ['userName is invalid'],
    });
  });

  it('selects the primary multi-valued entry and falls back to the first valid object', () => {
    const emails = [
      { value: 'first@example.com', type: 'home' },
      { value: 'primary@example.com', type: 'work', primary: true },
    ];

    expect(selectPrimaryScimValue(emails)).toBe('primary@example.com');
    expect(selectPrimaryScimObject(emails)).toEqual(emails[1]);
    expect(selectPrimaryScimValue([{ value: 'fallback@example.com' }])).toBe(
      'fallback@example.com'
    );
  });

  it('applies operation and attribute names case-insensitively without changing key casing', () => {
    const resource = {
      displayName: '変更前',
      name: { givenName: '太郎' },
      emails: [{ type: 'work', value: 'before@example.com' }],
    };

    const result = applyPatchOperations(resource, [
      { op: 'REPLACE' as 'replace', path: 'DISPLAYNAME', value: '変更後 🚀' },
      { op: 'Replace' as 'replace', path: 'NAME.GIVENNAME', value: 'Zoë' },
      {
        op: 'replace',
        path: 'EMAILS[TYPE eq "work"].VALUE',
        value: 'unicode.é@example.com',
      },
    ]);

    expect(result).toEqual({
      displayName: '変更後 🚀',
      name: { givenName: 'Zoë' },
      emails: [{ type: 'work', value: 'unicode.é@example.com' }],
    });
    expect(result).not.toHaveProperty('DISPLAYNAME');
  });
});
