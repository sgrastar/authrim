import type { CanonicalRuntimeUserProjection } from '../repositories/identity/canonical-runtime-user-projection';

export interface CanonicalRuntimeOIDCClaimsUser {
  name: string | null;
  family_name: string | null;
  given_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  profile: string | null;
  picture: string | null;
  website: string | null;
  gender: string | null;
  birthdate: string | null;
  zoneinfo: string | null;
  locale: string | null;
  updated_at: number | null;
  email: string | null;
  email_verified: boolean;
  phone_number: string | null;
  phone_number_verified: boolean;
  address: string | null;
}

function isoToUnixSeconds(value: string): number | null {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return null;
  }
  return Math.floor(millis / 1000);
}

export function canonicalProjectionToOIDCClaimsUser(
  projection: CanonicalRuntimeUserProjection
): CanonicalRuntimeOIDCClaimsUser {
  return {
    name: projection.name,
    family_name: projection.family_name,
    given_name: projection.given_name,
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
    updated_at: isoToUnixSeconds(projection.updated_at),
    email: projection.email,
    email_verified: projection.email_verified === 1,
    phone_number: projection.phone_number,
    phone_number_verified: projection.phone_number_verified === 1,
    address: projection.address_json,
  };
}
