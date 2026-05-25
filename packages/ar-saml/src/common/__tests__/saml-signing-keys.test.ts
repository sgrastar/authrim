import type { SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  buildSAMLSigningKeyRef,
  resolveSAMLSigningKeyRef,
  getSAMLSigningPolicy,
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
});
