import type { CanonicalRuntimeUserProjection } from '@authrim/ar-lib-core';
import type { InternalUser } from '@authrim/ar-lib-scim';

export function canonicalProjectionToScimInternalUser(
  projection: CanonicalRuntimeUserProjection
): InternalUser {
  return {
    id: projection.id,
    tenant_id: projection.tenant_id,
    email: projection.email ?? '',
    email_verified: projection.email_verified,
    name: projection.name,
    given_name: projection.given_name,
    family_name: projection.family_name,
    middle_name: projection.middle_name,
    nickname: projection.nickname,
    preferred_username: projection.preferred_username,
    profile: projection.profile,
    picture: projection.picture,
    website: projection.website,
    gender: projection.gender,
    birthdate: projection.birthdate,
    zoneinfo: projection.zoneinfo,
    locale: projection.locale,
    phone_number: projection.phone_number,
    phone_number_verified: projection.phone_number_verified,
    address_json: projection.address_json,
    updated_at: projection.updated_at,
    created_at: projection.created_at,
    custom_attributes_json: projection.custom_attributes_json,
    password_hash: projection.password_hash,
    external_id: projection.external_id,
    active: projection.active,
  };
}
