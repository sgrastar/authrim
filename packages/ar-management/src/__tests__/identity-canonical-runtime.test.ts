import { describe, expect, it } from 'vitest';
import type { CanonicalRuntimeUserProjection } from '@authrim/ar-lib-core';
import { userToScim } from '@authrim/ar-lib-scim';
import { canonicalProjectionToScimInternalUser } from '../identity-canonical-runtime';

describe('canonicalProjectionToScimInternalUser', () => {
  it('maps canonical runtime projection into the existing SCIM internal user contract', () => {
    const projection: CanonicalRuntimeUserProjection = {
      id: 'user-1',
      tenant_id: 'tenant-a',
      subject_id: 'subject-1',
      account_id: 'account-1',
      account_type: 'user',
      lifecycle_state: 'active',
      account_status: 'active',
      suspended_at: null,
      suspended_until: null,
      locked_at: null,
      locked_until: null,
      email: 'person@example.test',
      email_verified: 1,
      name: 'Example Person',
      given_name: 'Example',
      family_name: 'Person',
      middle_name: null,
      nickname: null,
      preferred_username: 'person',
      profile: null,
      picture: null,
      website: null,
      gender: null,
      birthdate: null,
      zoneinfo: 'Asia/Tokyo',
      locale: 'ja-JP',
      phone_number: '+819012345678',
      phone_number_verified: 0,
      address_json: JSON.stringify({ country: 'JP' }),
      password_hash: null,
      external_id: 'external-1',
      last_login_at: null,
      active: 1,
      custom_attributes_json: JSON.stringify({ department: 'Platform' }),
      created_at: '2026-05-28T00:00:00.000Z',
      updated_at: '2026-05-28T01:00:00.000Z',
    };

    const internalUser = canonicalProjectionToScimInternalUser(projection);
    const scimUser = userToScim(internalUser, {
      baseUrl: 'https://tenant.example.test',
      includeGroups: false,
    });

    expect(internalUser).toMatchObject({
      id: 'user-1',
      tenant_id: 'tenant-a',
      email: 'person@example.test',
      email_verified: 1,
      active: 1,
    });
    expect(scimUser).toMatchObject({
      id: 'user-1',
      userName: 'person',
      active: true,
      emails: [{ value: 'person@example.test', primary: true }],
      name: {
        formatted: 'Example Person',
        givenName: 'Example',
        familyName: 'Person',
      },
    });
  });
});
