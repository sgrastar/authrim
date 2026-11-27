/**
 * SCIM mapper - null extension attribute handling
 *
 * A null manager or null enterprise extension is malformed input, not a crash: the rest of
 * the resource must still be mapped / validated.
 */

import { describe, it, expect } from 'vitest';
import { userToScim, validateScimUser, type InternalUser } from '../utils/scim-mapper';
import { SCIM_SCHEMAS } from '../types/scim';

const baseUser: InternalUser = {
  id: 'u1',
  email: 'a@example.com',
  email_verified: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('userToScim with a null manager', () => {
  it('keeps the enterprise extension built from the other attributes', () => {
    const scim = userToScim(
      { ...baseUser, custom_attributes_json: JSON.stringify({ department: 'R&D', manager: null }) },
      { baseUrl: 'https://x.test' }
    );
    expect(scim.schemas).toContain(SCIM_SCHEMAS.ENTERPRISE_USER);
    expect(scim[SCIM_SCHEMAS.ENTERPRISE_USER]).toEqual({
      employeeNumber: undefined,
      costCenter: undefined,
      organization: undefined,
      division: undefined,
      department: 'R&D',
      manager: undefined,
    });
  });
});

describe('validateScimUser with a null enterprise extension', () => {
  it('reports it as a non-object instead of throwing', () => {
    const result = validateScimUser({
      userName: 'a',
      [SCIM_SCHEMAS.ENTERPRISE_USER]: null,
    } as never);
    expect(result).toEqual({
      valid: false,
      errors: [`${SCIM_SCHEMAS.ENTERPRISE_USER} must be an object`],
    });
  });
});
