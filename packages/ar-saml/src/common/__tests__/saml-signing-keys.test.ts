import type { SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  buildSAMLSigningKeyRef,
  resolveSAMLSigningKeyRef,
  getSAMLSigningPolicy,
  resolveSAMLIdPSigningPolicy,
} from '../saml-signing-keys';

describe('SAML signing key references', () => {
  it('uses tenant role scoped key refs by default', () => {
    expect(
      buildSAMLSigningKeyRef({
        tenantId: 'tenant-a',
        role: 'idp',
        counterpartyEntityId: 'https://sp.example.com/saml',
      })
    ).toBe('tenant:tenant-a:saml:idp:signing');
  });

  it('supports provider scoped key refs for high-security counterparties', () => {
    expect(
      buildSAMLSigningKeyRef({
        tenantId: 'tenant-a',
        role: 'idp',
        counterpartyEntityId: 'https://sp.example.com/saml',
        policy: { scope: 'provider' },
      })
    ).toBe('tenant:tenant-a:saml:idp:provider:https%3A%2F%2Fsp.example.com%2Fsaml:signing');
  });

  it('uses explicit active keyRef when configured', () => {
    const policy: SAMLSigningKeyPolicy = {
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:sp:custom-key-ref',
      },
    };

    expect(
      resolveSAMLSigningKeyRef({
        tenantId: 'tenant-a',
        role: 'sp',
        counterpartyEntityId: 'https://idp.example.com/saml',
        policy,
      })
    ).toBe('tenant:tenant-a:saml:sp:custom-key-ref');
  });

  it('rejects active keyRefs that are not scoped to the same tenant', () => {
    const policy: SAMLSigningKeyPolicy = {
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-b:saml:sp:signing',
      },
    };

    expect(() =>
      resolveSAMLSigningKeyRef({
        tenantId: 'tenant-a',
        role: 'sp',
        counterpartyEntityId: 'https://idp.example.com/saml',
        policy,
      })
    ).toThrow('SAML signing key reference must be tenant-scoped');
  });

  it('returns an empty policy for legacy provider configs', () => {
    expect(getSAMLSigningPolicy()).toEqual({});
  });

  it('falls back to tenant IdP signing policy when an SP has no explicit signing policy', async () => {
    const env = {
      SETTINGS: {
        get: async () =>
          JSON.stringify({
            entityIdStyle: 'metadata_url',
            interactiveLoginUrlPolicy: 'tenant_host',
            signingKeyPolicies: {
              idp: {
                active: {
                  slot: 'active',
                  keyRef: 'tenant:tenant-a:saml:idp:rollover-active',
                },
              },
            },
          }),
      },
    };

    await expect(
      resolveSAMLIdPSigningPolicy(env as never, 'tenant-a', {
        entityId: 'https://sp.example.com/saml',
        acsUrl: 'https://sp.example.com/acs',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: {},
        signAssertions: false,
        signResponses: true,
        allowedBindings: ['post'],
      })
    ).resolves.toEqual({
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:rollover-active',
      },
    });
  });

  it('uses an explicit SP signing policy when configured', async () => {
    const env = {
      SETTINGS: {
        get: async () =>
          JSON.stringify({
            entityIdStyle: 'metadata_url',
            interactiveLoginUrlPolicy: 'tenant_host',
            signingKeyPolicies: {
              idp: {
                active: {
                  slot: 'active',
                  keyRef: 'tenant:tenant-a:saml:idp:rollover-active',
                },
              },
            },
          }),
      },
    };

    await expect(
      resolveSAMLIdPSigningPolicy(env as never, 'tenant-a', {
        entityId: 'https://sp.example.com/saml',
        acsUrl: 'https://sp.example.com/acs',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: {},
        signingKeyPolicy: {
          active: {
            slot: 'active',
            keyRef: 'tenant:tenant-a:saml:idp:sp-explicit',
          },
        },
        signAssertions: false,
        signResponses: true,
        allowedBindings: ['post'],
      })
    ).resolves.toEqual({
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:sp-explicit',
      },
    });
  });
});
