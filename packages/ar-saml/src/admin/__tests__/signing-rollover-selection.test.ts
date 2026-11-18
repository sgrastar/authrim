/**
 * Signing certificate rollover: candidate selection, de-duplication and publication states.
 */

import { describe, expect, it } from 'vitest';
import type { SAMLSigningKeyPolicy, SAMLSigningKeyReference } from '@authrim/ar-lib-core';
import {
  deleteSAMLNextSigningCertificate,
  getSAMLNextSigningCertificates,
  promoteSAMLNextSigningCertificate,
  publishSAMLNextSigningCertificate,
  retireSAMLBackupSigningCertificate,
} from '../signing-rollover';

const TENANT = 'tenant-a';
const ref = (overrides: Partial<SAMLSigningKeyReference>): SAMLSigningKeyReference => ({
  slot: 'next',
  state: 'published_next',
  ...overrides,
});

describe('getSAMLNextSigningCertificates', () => {
  it('should list the legacy next slot first and de-duplicate by kid, keyRef, certificate or id', () => {
    const policy: SAMLSigningKeyPolicy = {
      next: ref({ kid: 'k1', certificate: 'c1' }),
      nextCandidates: [
        ref({ kid: 'k1', certificate: 'other' }), // same kid
        ref({ keyRef: 'ref-2' }),
        ref({ keyRef: 'ref-2', certificate: 'x' }), // same keyRef
        ref({ certificate: 'c3' }),
        ref({ certificate: 'c3' }), // same certificate
        ref({ id: 'id-4' }),
        ref({ id: 'id-4' }), // same id
        ref({}), // nothing to key on: always kept
        ref({}),
      ],
    };
    const result = getSAMLNextSigningCertificates(policy);
    expect(result.map((c) => c.kid ?? c.keyRef ?? c.certificate ?? c.id ?? '-')).toEqual([
      'k1',
      'ref-2',
      'c3',
      'id-4',
      '-',
      '-',
    ]);
  });

  it('should return an empty list for no policy', () => {
    expect(getSAMLNextSigningCertificates(undefined)).toEqual([]);
  });
});

describe('publishSAMLNextSigningCertificate', () => {
  it('should append to existing candidates and build a tenant-bound key ref when none is given', () => {
    const existing = ref({ kid: 'k1', keyRef: `tenant:${TENANT}:idp:k1`, certificate: 'c1' });
    const policy = publishSAMLNextSigningCertificate(
      { nextCandidates: [existing], metadataCertificatePublication: 'active_next_backup' },
      { tenantId: TENANT, role: 'idp', kid: 'k2', certificate: 'c2' }
    );
    expect(policy.next).toBeUndefined();
    expect(policy.nextCandidates).toHaveLength(2);
    expect(policy.nextCandidates?.[0]).toBe(existing);
    const added = policy.nextCandidates?.[1];
    if (!added) throw new Error('next candidate was not appended');
    expect(added).toMatchObject({
      slot: 'next',
      state: 'published_next',
      kid: 'k2',
      certificate: 'c2',
    });
    expect(typeof added.keyRef).toBe('string');
    expect(added.keyRef).toContain(TENANT);
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(policy.metadataCertificatePublication).toBe('active_next_backup'); // existing kept
  });

  it('should honour an explicit publication mode and reject an empty tenant', () => {
    const policy = publishSAMLNextSigningCertificate(undefined, {
      tenantId: TENANT,
      role: 'sp',
      certificate: 'c',
      metadataCertificatePublication: 'active_next_backup',
    });
    expect(policy.metadataCertificatePublication).toBe('active_next_backup');
    expect(() =>
      publishSAMLNextSigningCertificate(undefined, { tenantId: '', role: 'sp', certificate: 'c' })
    ).toThrow();
  });
});

describe('promoteSAMLNextSigningCertificate', () => {
  const next1 = ref({ kid: 'k1', certificate: 'c1' });
  const next2 = ref({ kid: 'k2', certificate: 'c2' });

  it('should reject promotion without a next certificate', () => {
    expect(() => promoteSAMLNextSigningCertificate({}, { tenantId: TENANT, role: 'idp' })).toThrow(
      new Error('Cannot promote SAML signing certificate without a next certificate')
    );
    expect(() =>
      promoteSAMLNextSigningCertificate(
        { nextCandidates: [next1] },
        { tenantId: TENANT, role: 'idp', targetKid: 'missing' }
      )
    ).toThrow(new Error('Cannot promote SAML signing certificate without a next certificate'));
  });

  it('should promote by keyRef, keep the other candidates and publish active+next+backup', () => {
    const byRef = ref({ keyRef: `tenant:${TENANT}:idp:r2`, certificate: 'c2' });
    const policy = promoteSAMLNextSigningCertificate(
      {
        active: ref({ slot: 'active', state: 'active', kid: 'k0', certificate: 'c0' }),
        nextCandidates: [next1, byRef],
      },
      { tenantId: TENANT, role: 'idp', targetKeyRef: byRef.keyRef, promotedAt: 1234 }
    );
    expect(policy.active).toMatchObject({
      slot: 'active',
      state: 'active',
      keyRef: byRef.keyRef,
      plannedActivationAt: 1234,
      metadataPublishFrom: undefined,
    });
    expect(policy.backup).toMatchObject({ kid: 'k0', slot: 'backup', state: 'overlap' });
    expect(policy.nextCandidates).toEqual([next1]);
    expect(policy.metadataCertificatePublication).toBe('active_next_backup');
  });

  it('should publish active+next when the previous active is dropped and candidates remain', () => {
    const policy = promoteSAMLNextSigningCertificate(
      {
        active: ref({ slot: 'active', state: 'active', kid: 'k0' }),
        nextCandidates: [next1, next2],
      },
      { tenantId: TENANT, role: 'idp', keepPreviousAsBackup: false }
    );
    expect(policy.active?.kid).toBe('k1');
    expect(policy.backup).toBeUndefined();
    expect(policy.nextCandidates).toEqual([next2]);
    expect(policy.metadataCertificatePublication).toBe('active_next');
  });

  it('should fall back to active-only when nothing remains and no backup exists', () => {
    const policy = promoteSAMLNextSigningCertificate(
      { nextCandidates: [next1] },
      { tenantId: TENANT, role: 'idp' }
    );
    expect(policy.active?.kid).toBe('k1');
    expect(policy.nextCandidates).toBeUndefined();
    expect(policy.backup).toBeUndefined();
    expect(policy.metadataCertificatePublication).toBe('active_only');
    expect(policy.active?.plannedActivationAt).toBeGreaterThan(0);
  });

  it('should keep an existing backup when there was no active certificate', () => {
    const backup = ref({ slot: 'backup', state: 'overlap', kid: 'kb' });
    const policy = promoteSAMLNextSigningCertificate(
      { backup, nextCandidates: [next1] },
      { tenantId: TENANT, role: 'idp' }
    );
    expect(policy.backup).toBe(backup);
    expect(policy.metadataCertificatePublication).toBe('active_next_backup');
  });

  it('should reject key refs bound to another tenant', () => {
    expect(() =>
      promoteSAMLNextSigningCertificate(
        { nextCandidates: [ref({ keyRef: 'tenant:other:idp:x', certificate: 'c' })] },
        { tenantId: TENANT, role: 'idp' }
      )
    ).toThrow();
    expect(() =>
      promoteSAMLNextSigningCertificate(
        {
          active: ref({ slot: 'active', state: 'active', keyRef: 'tenant:other:idp:a' }),
          nextCandidates: [next1],
        },
        { tenantId: TENANT, role: 'idp' }
      )
    ).toThrow();
  });

  it('should identify the promoted candidate by id or certificate when kid and keyRef are absent', () => {
    const byId = ref({ id: 'id-1', certificate: 'c-id' });
    const other = ref({ id: 'id-2', certificate: 'c-other' });
    const policy = promoteSAMLNextSigningCertificate(
      { nextCandidates: [byId, other] },
      { tenantId: TENANT, role: 'idp' }
    );
    expect(policy.nextCandidates).toEqual([other]);
    const byCert = ref({ certificate: 'only-cert' });
    const policy2 = promoteSAMLNextSigningCertificate(
      { nextCandidates: [byCert, ref({ certificate: 'another' })] },
      { tenantId: TENANT, role: 'idp' }
    );
    expect(policy2.nextCandidates?.map((c) => c.certificate)).toEqual(['another']);
  });
});

describe('deleteSAMLNextSigningCertificate / retireSAMLBackupSigningCertificate', () => {
  const next1 = ref({ kid: 'k1', keyRef: 'r1' });
  const next2 = ref({ kid: 'k2', keyRef: 'r2' });

  it('should delete by keyRef and keep publishing next when candidates remain', () => {
    const policy = deleteSAMLNextSigningCertificate(
      { nextCandidates: [next1, next2] },
      { targetKeyRef: 'r1' }
    );
    expect(policy.nextCandidates).toEqual([next2]);
    expect(policy.metadataCertificatePublication).toBe('active_next');
  });

  it('should delete the first candidate without a target and reflect the backup in the publication', () => {
    const backup = ref({ slot: 'backup', state: 'overlap', kid: 'kb' });
    expect(
      deleteSAMLNextSigningCertificate({ backup, nextCandidates: [next1, next2] })
    ).toMatchObject({
      nextCandidates: [next2],
      metadataCertificatePublication: 'active_next_backup',
    });
    expect(deleteSAMLNextSigningCertificate({ backup, nextCandidates: [next1] })).toMatchObject({
      nextCandidates: undefined,
      metadataCertificatePublication: 'active_next_backup',
    });
    expect(deleteSAMLNextSigningCertificate({ nextCandidates: [next1] })).toMatchObject({
      nextCandidates: undefined,
      metadataCertificatePublication: 'active_only',
    });
    expect(deleteSAMLNextSigningCertificate(undefined)).toMatchObject({
      next: undefined,
      nextCandidates: undefined,
      metadataCertificatePublication: 'active_only',
    });
  });

  it('should refuse to delete when the requested target does not exist', () => {
    expect(() =>
      deleteSAMLNextSigningCertificate({ nextCandidates: [next1] }, { targetKid: 'nope' })
    ).toThrow(
      new Error('Cannot delete SAML signing certificate without a matching next certificate')
    );
    expect(() =>
      deleteSAMLNextSigningCertificate({ nextCandidates: [next1] }, { targetKeyRef: 'nope' })
    ).toThrow(
      new Error('Cannot delete SAML signing certificate without a matching next certificate')
    );
  });

  it('should retire the backup and publish next only when candidates remain', () => {
    expect(
      retireSAMLBackupSigningCertificate({ backup: next1, nextCandidates: [next2] })
    ).toMatchObject({ backup: undefined, metadataCertificatePublication: 'active_next' });
    expect(retireSAMLBackupSigningCertificate({ backup: next1 })).toMatchObject({
      backup: undefined,
      metadataCertificatePublication: 'active_only',
    });
    expect(retireSAMLBackupSigningCertificate(undefined)).toMatchObject({
      backup: undefined,
      metadataCertificatePublication: 'active_only',
    });
  });
});
