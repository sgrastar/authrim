import { describe, expect, it } from 'vitest';
import {
  IDENTITY_IDENTIFIER_REASON_CODES,
  createOidcIdentityBindingKey,
  createSamlIdentityBindingKey,
  planOidcSubjectIdentifierStrategy,
  planSamlSubjectIdentifierStrategy,
  planScimSubjectIdentifierStrategy,
  validateSubjectIdentifierStrategy,
} from '../identity-identifier-bridge';

describe('identity identifier bridge binding keys', () => {
  it('scopes SAML hard-match keys by issuer, NameID format, qualifiers, and destination', async () => {
    const base = await createSamlIdentityBindingKey({
      issuer: 'https://idp.example.edu/idp',
      nameId: 'opaque-saml-nameid',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      nameQualifier: 'https://idp.example.edu/idp',
      spNameQualifier: 'https://sp.example.org/saml',
      destinationScope: 'sp:library',
    });
    const otherSp = await createSamlIdentityBindingKey({
      issuer: 'https://idp.example.edu/idp',
      nameId: 'opaque-saml-nameid',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      nameQualifier: 'https://idp.example.edu/idp',
      spNameQualifier: 'https://other-sp.example.org/saml',
      destinationScope: 'sp:library',
    });

    expect(base.protocol).toBe('saml');
    expect(base.sourceId).toBe('https://idp.example.edu/idp');
    expect(base.providerSubjectKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(otherSp.providerSubjectKeyHash).not.toBe(base.providerSubjectKeyHash);
    expect(JSON.stringify(base.metadata)).not.toContain('opaque-saml-nameid');
  });

  it('scopes OIDC hard-match keys by issuer and never stores raw sub in metadata', async () => {
    const issuerA = await createOidcIdentityBindingKey({
      issuer: 'https://op-a.example.edu',
      subject: 'opaque-oidc-sub',
      clientId: 'client-a',
      sectorIdentifier: 'rp.example.org',
    });
    const issuerB = await createOidcIdentityBindingKey({
      issuer: 'https://op-b.example.edu',
      subject: 'opaque-oidc-sub',
      clientId: 'client-a',
      sectorIdentifier: 'rp.example.org',
    });

    expect(issuerA.protocol).toBe('oidc');
    expect(issuerA.providerSubjectKeyHash).not.toBe(issuerB.providerSubjectKeyHash);
    expect(JSON.stringify(issuerA.metadata)).not.toContain('opaque-oidc-sub');
  });
});

describe('OIDC subject identifier strategy planning', () => {
  it('fails closed when no existing identifier or effective strategy exists', () => {
    expect(planOidcSubjectIdentifierStrategy({})).toEqual({
      status: 'fail_closed',
      strategy: null,
      inheritedFrom: null,
      reasonCode: IDENTITY_IDENTIFIER_REASON_CODES.subjectIdentifierStrategyMissing,
    });
  });

  it('uses an existing subject identifier before issuing a new one', () => {
    expect(
      planOidcSubjectIdentifierStrategy({
        existingIdentifierValue: 'existing-subject',
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
        clientOverrideStrategy: {
          kind: 'deterministic_hmac',
          keyRef: 'key-1',
          sourceBindingRef: 'binding-1',
        },
      })
    ).toEqual({
      status: 'use_existing',
      identifierValue: 'existing-subject',
      inheritedFrom: 'existing',
      reasonCode: null,
    });
  });

  it('inherits tenant default strategy and lets client override win', () => {
    expect(
      planOidcSubjectIdentifierStrategy({
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
      })
    ).toMatchObject({
      status: 'issue_with_strategy',
      inheritedFrom: 'tenant_default',
      strategy: { kind: 'opaque_pairwise' },
    });

    expect(
      planOidcSubjectIdentifierStrategy({
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
        clientOverrideStrategy: { kind: 'opaque_public' },
      })
    ).toMatchObject({
      status: 'issue_with_strategy',
      inheritedFrom: 'client_override',
      strategy: { kind: 'opaque_public' },
    });
  });

  it('lets destination override sit between client override and tenant default', () => {
    expect(
      planOidcSubjectIdentifierStrategy({
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
        destinationOverrideStrategy: { kind: 'imported_external', sourceSystemRef: 'legacy-op' },
      })
    ).toMatchObject({
      status: 'issue_with_strategy',
      inheritedFrom: 'destination_override',
      strategy: { kind: 'imported_external' },
    });
  });

  it('rejects subject strategies that try to store raw matching identifiers in metadata', () => {
    expect(() =>
      validateSubjectIdentifierStrategy({
        kind: 'opaque_pairwise',
        metadata: { email: 'person@example.edu' },
      })
    ).toThrow(/raw subject identifiers/);
  });

  it('requires explicit key and source binding for deterministic issuance', () => {
    expect(() =>
      validateSubjectIdentifierStrategy({
        kind: 'deterministic_hmac',
        keyRef: 'key-1',
      })
    ).toThrow(/strategy.sourceBindingRef is required/);
  });
});

describe('SAML and SCIM subject identifier strategy planning', () => {
  it('requires an effective strategy for SAML persistent NameID when no existing value exists', () => {
    expect(
      planSamlSubjectIdentifierStrategy({
        requirement: 'required',
      })
    ).toEqual({
      status: 'fail_closed',
      strategy: null,
      inheritedFrom: null,
      reasonCode: IDENTITY_IDENTIFIER_REASON_CODES.subjectIdentifierStrategyMissing,
    });
  });

  it('does not require a strategy for SAML transient NameID', () => {
    expect(
      planSamlSubjectIdentifierStrategy({
        requirement: 'not_required',
      })
    ).toEqual({
      status: 'not_required',
      identifierValue: null,
      strategy: null,
      inheritedFrom: null,
      reasonCode: null,
    });
  });

  it('keeps inbound SCIM token identity separate from outbound SCIM id issuance', () => {
    expect(
      planScimSubjectIdentifierStrategy({
        requirement: 'not_required',
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
      })
    ).toMatchObject({
      status: 'not_required',
    });

    expect(
      planScimSubjectIdentifierStrategy({
        requirement: 'required',
        tenantDefaultStrategy: { kind: 'opaque_pairwise' },
      })
    ).toMatchObject({
      status: 'issue_with_strategy',
      inheritedFrom: 'tenant_default',
      strategy: { kind: 'opaque_pairwise' },
    });
  });
});
