import { describe, expect, it } from 'vitest';
import { AttributeReleaseConsentRepository } from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

describe('AttributeReleaseConsentRepository', () => {
  it('stores granted attribute release consent without raw attribute values', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    const repository = new AttributeReleaseConsentRepository(adapter);

    const consent = await repository.grant({
      id: 'attribute-release-consent-1',
      tenant_id: 'tenant-a',
      subject_id: 'subject-1',
      destination_type: 'saml_sp',
      destination_id: 'https://sp.example.org/saml',
      attribute_set_hash: 'sha256-attribute-set',
      consent_mode: 'until_attributes_change',
      consent_record_id: 'user-consent-record-1',
    });

    expect(consent.consent_state).toBe('granted');
    await expect(
      repository.findGrantedConsent({
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-attribute-set',
      })
    ).resolves.toMatchObject({
      id: 'attribute-release-consent-1',
      consent_record_id: 'user-consent-record-1',
    });
    expect(JSON.stringify(adapter.getById('attribute_release_consents', consent.id))).not.toContain(
      'person@example.edu'
    );
  });

  it('does not return revoked attribute release consent as granted', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    adapter.seed('attribute_release_consents', [
      {
        id: 'attribute-release-consent-revoked',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-attribute-set',
        consent_mode: 'once',
        consent_state: 'revoked',
        consent_record_id: 'user-consent-record-1',
        first_granted_at: 1000,
        last_confirmed_at: 1000,
        expires_at: null,
        revoked_at: 1100,
        created_at: 1000,
        updated_at: 1100,
      },
    ]);
    const repository = new AttributeReleaseConsentRepository(adapter);

    await expect(
      repository.findGrantedConsent({
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-attribute-set',
      })
    ).resolves.toBeNull();
  });

  it('returns the persisted row when a consent grant updates an existing hash', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    adapter.seed('attribute_release_consents', [
      {
        id: 'existing-consent',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-attribute-set',
        consent_mode: 'once',
        consent_state: 'revoked',
        consent_record_id: null,
        first_granted_at: 1000,
        last_confirmed_at: 1000,
        expires_at: null,
        revoked_at: 1100,
        created_at: 1000,
        updated_at: 1100,
      },
    ]);
    const repository = new AttributeReleaseConsentRepository(adapter);

    const consent = await repository.grant({
      tenant_id: 'tenant-a',
      subject_id: 'subject-1',
      destination_type: 'saml_sp',
      destination_id: 'https://sp.example.org/saml',
      attribute_set_hash: 'sha256-attribute-set',
      consent_mode: 'once',
    });

    expect(consent.id).toBe('existing-consent');
    expect(
      adapter
        .getQueryLog()
        .map((entry) => entry.sql)
        .join('\n')
    ).not.toContain('ON CONFLICT');
    expect(adapter.getAll('attribute_release_consents')).toHaveLength(1);
    expect(adapter.getById('attribute_release_consents', 'existing-consent')).toMatchObject({
      consent_state: 'granted',
      revoked_at: null,
    });
  });

  it('finds the latest granted consent for once-per-destination release checks', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    adapter.seed('attribute_release_consents', [
      {
        id: 'older-consent',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        account_id: null,
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-old',
        consent_mode: 'once',
        consent_state: 'granted',
        consent_record_id: null,
        first_granted_at: 1000,
        last_confirmed_at: 1000,
        expires_at: null,
        revoked_at: null,
        created_at: 1000,
        updated_at: 1000,
      },
      {
        id: 'newer-consent',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        account_id: null,
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
        attribute_set_hash: 'sha256-new',
        consent_mode: 'once',
        consent_state: 'granted',
        consent_record_id: null,
        first_granted_at: 2000,
        last_confirmed_at: 2000,
        expires_at: null,
        revoked_at: null,
        created_at: 2000,
        updated_at: 2000,
      },
    ]);
    const repository = new AttributeReleaseConsentRepository(adapter);

    await expect(
      repository.findLatestGrantedConsentForDestination({
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        destination_type: 'saml_sp',
        destination_id: 'https://sp.example.org/saml',
      })
    ).resolves.toMatchObject({
      id: 'newer-consent',
      attribute_set_hash: 'sha256-new',
    });
  });
});
