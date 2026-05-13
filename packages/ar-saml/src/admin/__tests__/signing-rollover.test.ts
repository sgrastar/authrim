import type { SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  promoteSAMLNextSigningCertificate,
  publishSAMLNextSigningCertificate,
  retireSAMLBackupSigningCertificate,
} from '../signing-rollover';

describe('SAML signing certificate rollover operations', () => {
  it('publishes a next certificate and enables active+next metadata publication', () => {
    const policy = publishSAMLNextSigningCertificate(
      {
        active: {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: 'ACTIVE',
        },
      },
      {
        tenantId: 'tenant-a',
        role: 'idp',
        keyRef: 'tenant:tenant-a:saml:idp:next:signing',
        certificate: 'NEXT',
        metadataPublishFrom: 1000,
        plannedActivationAt: 2000,
      }
    );

    expect(policy.metadataCertificatePublication).toBe('active_next');
    expect(policy.next).toMatchObject({
      slot: 'next',
      keyRef: 'tenant:tenant-a:saml:idp:next:signing',
      certificate: 'NEXT',
      state: 'published_next',
      metadataPublishFrom: 1000,
      plannedActivationAt: 2000,
    });
  });

  it('rejects next key refs from a different tenant', () => {
    expect(() =>
      publishSAMLNextSigningCertificate(undefined, {
        tenantId: 'tenant-a',
        role: 'idp',
        keyRef: 'tenant:tenant-b:saml:idp:next:signing',
        certificate: 'NEXT',
      })
    ).toThrow('SAML signing key reference must be tenant-scoped');
  });

  it('promotes next certificate and keeps previous active as overlap backup', () => {
    const policy: SAMLSigningKeyPolicy = {
      metadataCertificatePublication: 'active_next',
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:signing',
        certificate: 'ACTIVE',
        state: 'active',
      },
      next: {
        slot: 'next',
        keyRef: 'tenant:tenant-a:saml:idp:next:signing',
        certificate: 'NEXT',
        state: 'published_next',
      },
    };

    const promoted = promoteSAMLNextSigningCertificate(policy, {
      tenantId: 'tenant-a',
      role: 'idp',
      promotedAt: 3000,
    });

    expect(promoted.active).toMatchObject({
      slot: 'active',
      keyRef: 'tenant:tenant-a:saml:idp:next:signing',
      certificate: 'NEXT',
      state: 'active',
      plannedActivationAt: 3000,
    });
    expect(promoted.next).toBeUndefined();
    expect(promoted.backup).toMatchObject({
      slot: 'backup',
      keyRef: 'tenant:tenant-a:saml:idp:signing',
      certificate: 'ACTIVE',
      state: 'overlap',
    });
    expect(promoted.metadataCertificatePublication).toBe('active_next_backup');
  });

  it('retires the backup certificate and returns to active-only publication', () => {
    const retired = retireSAMLBackupSigningCertificate({
      metadataCertificatePublication: 'active_next_backup',
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:next:signing',
        certificate: 'NEXT',
      },
      backup: {
        slot: 'backup',
        keyRef: 'tenant:tenant-a:saml:idp:signing',
        certificate: 'ACTIVE',
      },
    });

    expect(retired.backup).toBeUndefined();
    expect(retired.metadataCertificatePublication).toBe('active_only');
  });
});
