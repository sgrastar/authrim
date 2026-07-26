import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  DestinationProfileReleaseValidationError,
  filterOidcClaimsByDestinationConsent,
  filterSamlAttributesByDestinationConsent,
  loadDestinationProfileConsentDescriptor,
} from '../destination-profile-consent';

function adapter(input: { queryOne?: ReturnType<typeof vi.fn> }): DatabaseAdapter {
  return {
    queryOne: input.queryOne ?? vi.fn(),
    query: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('destination profile field consent', () => {
  it('infers legacy OIDC sub as required and keeps explicit optional claims optional', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_oidc',
        destination_type: 'oidc',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'sub', label: 'Subject', surfaces: ['id_token'] },
            { claimName: 'email', label: 'Email', required: false, surfaces: ['userinfo'] },
          ],
        }),
      }),
    });

    const descriptor = await loadDestinationProfileConsentDescriptor(
      adminAdapter,
      'tenant_a',
      'profile_oidc'
    );

    expect(descriptor?.fields).toEqual([
      expect.objectContaining({ key: 'sub', required: true }),
      expect.objectContaining({ key: 'email', required: false }),
    ]);
  });

  it('removes an unselected optional OIDC claim while preserving required and envelope claims', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_oidc',
        destination_type: 'oidc',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'sub', required: true },
            { claimName: 'email', required: false },
            { claimName: 'name', required: false },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        released_claims_json: JSON.stringify(['sub', 'name']),
        released_attributes_json: null,
      }),
    });

    const claims = await filterOidcClaimsByDestinationConsent({
      coreAdapter,
      adminAdapter,
      tenantId: 'tenant_a',
      subjectId: 'user_1',
      clientId: 'client_1',
      profileId: 'profile_oidc',
      claims: {
        iss: 'https://issuer.example',
        sub: 'user_1',
        email: 'a@example.com',
        name: 'A',
        undisclosed: 'must-not-leak',
      },
    });

    expect(claims).toEqual({ iss: 'https://issuer.example', sub: 'user_1', name: 'A' });
    expect(coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('AND statement_version = ?'),
      expect.arrayContaining(['destination_profile:profile_oidc', 'version_1'])
    );
  });

  it('fails OIDC release when a required claim is missing or a non-nullable claim is null', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_oidc',
        destination_type: 'oidc',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'sub', required: true, nullable: false },
            { claimName: 'email', required: true, nullable: false },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });

    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        clientId: 'client_1',
        profileId: 'profile_oidc',
        claims: { sub: 'user_1' },
      })
    ).rejects.toMatchObject<Partial<DestinationProfileReleaseValidationError>>({
      code: 'required_field_missing',
      field: 'email',
    });

    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        clientId: 'client_1',
        profileId: 'profile_oidc',
        claims: { sub: 'user_1', email: null },
      })
    ).rejects.toMatchObject<Partial<DestinationProfileReleaseValidationError>>({
      code: 'non_nullable_field_null',
      field: 'email',
    });

    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        clientId: 'client_1',
        profileId: 'profile_oidc',
        claims: { sub: null, email: 'a@example.com' },
      })
    ).rejects.toMatchObject<Partial<DestinationProfileReleaseValidationError>>({
      code: 'invalid_field_value',
      field: 'sub',
    });
  });

  it('keeps legacy OIDC sub unconditional while skipping other ungranted claims', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_oidc',
        destination_type: 'oidc',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            {
              claimName: 'sub',
              required: true,
              surfaces: ['id_token'],
              requiredScopes: ['openid'],
            },
            { claimName: 'email', required: true, requiredScopes: ['email'] },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });

    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        clientId: 'client_1',
        profileId: 'profile_oidc',
        surface: 'userinfo',
        grantedScopes: [],
        claims: { sub: 'user_1' },
      })
    ).resolves.toEqual({ sub: 'user_1' });
  });

  it('uses per-SP SAML policies to preserve required and remove hidden attributes', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_saml',
        destination_type: 'saml',
        version_id: 'version_2',
        schema_json: JSON.stringify({
          attributes: [
            { name: 'mail', required: true },
            { name: 'displayName', required: false },
            { name: 'department', required: false },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        released_claims_json: null,
        released_attributes_json: ['mail', 'department'],
      }),
    });

    const attributes = await filterSamlAttributesByDestinationConsent({
      coreAdapter,
      adminAdapter,
      tenantId: 'tenant_a',
      subjectId: 'user_1',
      samlSpId: 'https://sp.example',
      profileId: 'profile_saml',
      fieldPolicies: {
        mail: 'required',
        displayName: 'hidden',
        department: 'optional',
      },
      attributes: [
        { name: 'mail', values: ['a@example.com'] },
        { name: 'displayName', values: ['A'] },
        { name: 'department', values: ['Engineering'] },
        { name: 'undisclosed', values: ['must-not-leak'] },
      ],
    });

    expect(attributes.map((attribute) => attribute.name)).toEqual(['mail', 'department']);
    expect(coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('AND statement_version = ?'),
      expect.arrayContaining([expect.stringContaining('version_2:sp-policy-')])
    );
  });

  it('fails closed to required SAML attributes when no destination consent exists', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_saml',
        destination_type: 'saml',
        version_id: 'version_2',
        schema_json: JSON.stringify({
          attributes: [
            { name: 'mail', required: true },
            { name: 'displayName', required: false },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });

    const attributes = await filterSamlAttributesByDestinationConsent({
      coreAdapter,
      adminAdapter,
      tenantId: 'tenant_a',
      subjectId: 'user_1',
      samlSpId: 'https://sp.example',
      profileId: 'profile_saml',
      fieldPolicies: { mail: 'required', displayName: 'optional' },
      attributes: [
        { name: 'mail', values: ['a@example.com'] },
        { name: 'displayName', values: ['A'] },
      ],
    });

    expect(attributes.map((attribute) => attribute.name)).toEqual(['mail']);
  });
});
