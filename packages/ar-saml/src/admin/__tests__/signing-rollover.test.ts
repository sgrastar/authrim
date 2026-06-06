import type { SAMLSigningKeyPolicy } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  deleteSAMLNextSigningCertificate,
  getSAMLNextSigningCertificates,
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
    expect(policy.next).toBeUndefined();
    expect(policy.nextCandidates).toHaveLength(1);
    expect(policy.nextCandidates?.[0]).toMatchObject({
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
    expect(promoted.nextCandidates).toBeUndefined();
    expect(promoted.backup).toMatchObject({
      slot: 'backup',
      keyRef: 'tenant:tenant-a:saml:idp:signing',
      certificate: 'ACTIVE',
      state: 'overlap',
    });
    expect(promoted.metadataCertificatePublication).toBe('active_next_backup');
  });

  it('promotes a selected next certificate when multiple switchable certificates exist', () => {
    const policy: SAMLSigningKeyPolicy = {
      metadataCertificatePublication: 'active_next',
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:signing',
        certificate: 'ACTIVE',
        state: 'active',
      },
      nextCandidates: [
        {
          slot: 'next',
          keyRef: 'tenant:tenant-a:saml:idp:next-1:signing',
          kid: 'next-1',
          certificate: 'NEXT1',
          state: 'published_next',
        },
        {
          slot: 'next',
          keyRef: 'tenant:tenant-a:saml:idp:next-2:signing',
          kid: 'next-2',
          certificate: 'NEXT2',
          state: 'published_next',
        },
      ],
    };

    const promoted = promoteSAMLNextSigningCertificate(policy, {
      tenantId: 'tenant-a',
      role: 'idp',
      promotedAt: 3000,
      targetKid: 'next-2',
    });

    expect(promoted.active?.certificate).toBe('NEXT2');
    expect(getSAMLNextSigningCertificates(promoted)).toHaveLength(1);
    expect(promoted.nextCandidates?.[0]?.certificate).toBe('NEXT1');
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

  it('deletes the next certificate without removing active or backup certificates', () => {
    const deleted = deleteSAMLNextSigningCertificate({
      metadataCertificatePublication: 'active_next_backup',
      active: {
        slot: 'active',
        keyRef: 'tenant:tenant-a:saml:idp:signing',
        certificate: 'ACTIVE',
      },
      next: {
        slot: 'next',
        keyRef: 'tenant:tenant-a:saml:idp:next:signing',
        certificate: 'NEXT',
      },
      backup: {
        slot: 'backup',
        keyRef: 'tenant:tenant-a:saml:idp:backup:signing',
        certificate: 'BACKUP',
      },
    });

    expect(deleted.next).toBeUndefined();
    expect(deleted.nextCandidates).toBeUndefined();
    expect(deleted.active?.certificate).toBe('ACTIVE');
    expect(deleted.backup?.certificate).toBe('BACKUP');
    expect(deleted.metadataCertificatePublication).toBe('active_next_backup');
  });

  it('does not delete a next certificate when the requested target is missing', () => {
    expect(() =>
      deleteSAMLNextSigningCertificate(
        {
          metadataCertificatePublication: 'active_next',
          nextCandidates: [
            {
              slot: 'next',
              keyRef: 'tenant:tenant-a:saml:idp:next:signing',
              kid: 'next-1',
              certificate: 'NEXT',
            },
          ],
        },
        { targetKid: 'missing' }
      )
    ).toThrow('Cannot delete SAML signing certificate without a matching next certificate');
  });
});
