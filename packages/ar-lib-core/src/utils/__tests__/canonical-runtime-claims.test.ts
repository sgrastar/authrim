import { describe, expect, it } from 'vitest';

import { canonicalProjectionToOIDCClaimsUser } from '../canonical-runtime-claims';
import type { CanonicalRuntimeUserProjection } from '../../repositories/identity/canonical-runtime-user-projection';

describe('canonicalProjectionToOIDCClaimsUser', () => {
  it('maps canonical runtime projection into OIDC standard claims input', () => {
    const projection: CanonicalRuntimeUserProjection = {
      id: 'user-1',
      tenant_id: 'tenant-1',
      subject_id: 'subject:user-1',
      account_id: 'account:user-1',
      account_type: 'user',
      lifecycle_state: 'active',
      account_status: 'active',
      suspended_at: null,
      suspended_until: null,
      locked_at: null,
      locked_until: null,
      email: 'user@example.com',
      email_verified: 1,
      name: 'User One',
      given_name: 'User',
      family_name: 'One',
      middle_name: null,
      nickname: 'u1',
      preferred_username: 'userone',
      profile: 'https://example.com/users/user-1',
      picture: null,
      website: null,
      gender: null,
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'ja-JP',
      phone_number: '+819012345678',
      phone_number_verified: 0,
      address_json: JSON.stringify({ country: 'JP' }),
      password_hash: null,
      external_id: null,
      active: 1,
      custom_attributes_json: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    };

    expect(canonicalProjectionToOIDCClaimsUser(projection)).toMatchObject({
      email: 'user@example.com',
      email_verified: true,
      name: 'User One',
      phone_number: '+819012345678',
      phone_number_verified: false,
      address: JSON.stringify({ country: 'JP' }),
      updated_at: 1767312000,
    });
  });
});
