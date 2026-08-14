import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  DestinationProfileReleaseValidationError,
  filterIntrospectionClaimsByResourceServerProfile,
  filterOidcClaimsByDestinationConsent,
  filterOidcClaimsWithoutDestinationProfile,
  filterSamlAttributesByDestinationConsent,
  isProtectedIdentityMappingDestinationClaim,
  loadDestinationProfileConsentDescriptor,
  OIDC_PROTOCOL_ENVELOPE_CLAIMS,
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
  it('protects OIDC envelope claims regardless of the configured destination namespace', () => {
    for (const namespace of ['oidc.claim', 'custom', 'oidc.claims', 'tenant.ns']) {
      for (const claim of OIDC_PROTOCOL_ENVELOPE_CLAIMS) {
        expect(
          isProtectedIdentityMappingDestinationClaim(namespace, claim),
          `${namespace}:${claim}`
        ).toBe(true);
      }
      expect(isProtectedIdentityMappingDestinationClaim(namespace, 'sub')).toBe(false);
      expect(isProtectedIdentityMappingDestinationClaim(namespace, 'email')).toBe(false);
    }
  });

  it('keeps standard OIDC claims but drops unprofiled Authrim and custom extensions', () => {
    expect(
      filterOidcClaimsWithoutDestinationProfile({
        iss: 'https://issuer.example',
        sub: 'user_1',
        email: 'user@example.com',
        '::age_over_18': true,
        authrim_roles: ['admin'],
        user_type: 'anonymous',
        upgrade_eligible: true,
        department: 'Finance',
      })
    ).toEqual({
      iss: 'https://issuer.example',
      sub: 'user_1',
      email: 'user@example.com',
      '::age_over_18': true,
    });
  });

  it('fails closed for introspection extensions when the Resource Server has no active profile', async () => {
    const adminAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });
    const claims = await filterIntrospectionClaimsByResourceServerProfile({
      adminAdapter,
      tenantId: 'tenant_a',
      resourceServerId: 'payments-api',
      grantedScopes: ['roles'],
      claims: {
        active: true,
        sub: 'user_1',
        roles: ['admin'],
        authrim_elevation: { grant_id: 'must-not-leak' },
        private_note: 'no',
      },
    });

    expect(claims).toEqual({ active: true, sub: 'user_1' });
  });

  it('rejects ambiguous active Resource Server profiles instead of using update order', async () => {
    const queryOne = vi.fn().mockResolvedValue({
      profile_id: 'profile_rs_newest',
      destination_type: 'resource_server',
      version_id: 'version_2',
      schema_json: JSON.stringify({ claims: [{ claimName: 'active', required: true }] }),
      matching_profile_count: 2,
    });
    const adminAdapter = adapter({
      queryOne,
    });

    await expect(
      filterIntrospectionClaimsByResourceServerProfile({
        adminAdapter,
        tenantId: 'tenant_a',
        resourceServerId: 'payments-api',
        grantedScopes: [],
        claims: { active: true, sub: 'user_1' },
      })
    ).rejects.toMatchObject({ code: 'destination_profile_ambiguous' });
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(*) OVER () AS matching_profile_count'),
      expect.any(Array)
    );
  });

  it('releases only scoped extensions from the authenticated Resource Server profile', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_rs',
        destination_type: 'resource_server',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'active', required: true },
            { claimName: 'roles', requiredScopes: ['roles'] },
            { claimName: 'employee_number', requiredScopes: ['employee'] },
          ],
        }),
      }),
    });
    const claims = await filterIntrospectionClaimsByResourceServerProfile({
      adminAdapter,
      tenantId: 'tenant_a',
      resourceServerId: 'payments-api',
      grantedScopes: ['roles'],
      claims: {
        active: true,
        sub: 'user_1',
        roles: ['approver'],
        employee_number: '42',
        private_note: 'no',
      },
    });

    expect(claims).toEqual({ active: true, sub: 'user_1', roles: ['approver'] });
  });

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

  it('rejects OIDC claims that violate configured type and allowed-value constraints', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_oidc',
        destination_type: 'oidc',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'sub', required: true, valueType: 'string' },
            {
              claimName: 'account_status',
              required: true,
              valueType: 'string',
              valueMultiplicity: 'single',
              allowedValues: ['active', 'suspended'],
            },
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
        claims: { sub: 'user_1', account_status: 1 },
      })
    ).rejects.toMatchObject({ code: 'invalid_field_value', field: 'account_status' });

    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        clientId: 'client_1',
        profileId: 'profile_oidc',
        claims: { sub: 'user_1', account_status: 'deleted' },
      })
    ).rejects.toMatchObject({ code: 'invalid_field_value', field: 'account_status' });
  });

  it('rejects introspection claims that violate configured multiplicity', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_rs',
        destination_type: 'resource_server',
        version_id: 'version_1',
        schema_json: JSON.stringify({
          claims: [
            { claimName: 'active', required: true },
            {
              claimName: 'roles',
              requiredScopes: ['roles'],
              valueType: 'string',
              valueMultiplicity: 'multi',
            },
          ],
        }),
      }),
    });

    await expect(
      filterIntrospectionClaimsByResourceServerProfile({
        adminAdapter,
        tenantId: 'tenant_a',
        resourceServerId: 'payments-api',
        grantedScopes: ['roles'],
        claims: { active: true, roles: 'approver' },
      })
    ).rejects.toMatchObject({ code: 'invalid_field_value', field: 'roles' });
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

  it('rejects SAML attribute values outside the destination profile contract', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_saml',
        destination_type: 'saml',
        version_id: 'version_2',
        schema_json: JSON.stringify({
          attributes: [
            {
              name: 'eduPersonAffiliation',
              valueType: 'string',
              valueMultiplicity: 'multi',
              allowedValues: ['faculty', 'student'],
            },
          ],
        }),
      }),
    });
    const coreAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });

    await expect(
      filterSamlAttributesByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        samlSpId: 'https://sp.example',
        profileId: 'profile_saml',
        attributes: [{ name: 'eduPersonAffiliation', values: ['staff'] }],
      })
    ).rejects.toMatchObject({
      code: 'invalid_field_value',
      field: 'eduPersonAffiliation',
    });
  });

  it('rechecks SAML release classification safety at runtime', async () => {
    const adminAdapter = adapter({
      queryOne: vi.fn().mockResolvedValue({
        profile_id: 'profile_saml',
        destination_type: 'saml',
        version_id: 'version_2',
        schema_json: JSON.stringify({
          attributes: [{ name: 'mail', classification: 'internal' }],
        }),
      }),
    });
    const coreAdapter = adapter({ queryOne: vi.fn().mockResolvedValue(null) });

    await expect(
      filterSamlAttributesByDestinationConsent({
        coreAdapter,
        adminAdapter,
        tenantId: 'tenant_a',
        subjectId: 'user_1',
        samlSpId: 'https://sp.example',
        profileId: 'profile_saml',
        releaseSafetyBinding: {
          catalog: {
            entries: [
              {
                id: 'field.profile.email',
                namespace: 'authrim.profile',
                path: 'email',
                valueType: 'string',
                cardinality: 'single',
                classification: 'pii',
              },
            ],
          },
          edges: [
            {
              id: 'edge_email',
              sourceRef: {
                side: 'source',
                namespace: 'authrim.profile',
                path: 'email',
                catalogEntryId: 'field.profile.email',
              },
              targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'mail' },
            },
          ],
        } as never,
        attributes: [{ name: 'mail', values: ['user@example.com'] }],
      })
    ).rejects.toThrow(/cannot lower sensitive classification/i);
  });
});
