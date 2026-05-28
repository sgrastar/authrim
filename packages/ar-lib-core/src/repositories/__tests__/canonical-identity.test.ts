import { beforeEach, describe, expect, it } from 'vitest';
import { CanonicalIdentityRepository } from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

const CANONICAL_TABLES = [
  'identity_subjects',
  'identity_accounts',
  'subject_account_links',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
  'contact_verifications',
  'identity_bindings',
  'identity_resolution_events',
  'identity_resolution_candidates',
  'assurance_evidence',
];

describe('CanonicalIdentityRepository', () => {
  let adapter: MockDatabaseAdapter;
  let repository: CanonicalIdentityRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    for (const tableName of CANONICAL_TABLES) {
      adapter.initTable(tableName, 'id');
    }
    repository = new CanonicalIdentityRepository(adapter, 'tenant-a');
  });

  it('creates a subject, account, primary link, and profile graph in canonical tables', async () => {
    const graph = await repository.createIdentityGraph({
      subject: {
        id: 'subject-1',
        display_label: 'Stored label',
        metadata: { source: 'dry-run' },
      },
      account: {
        id: 'account-1',
        legacy_user_id: 'legacy-user-1',
      },
      link: {
        id: 'link-1',
        source_ref: 'source/scim/acme',
      },
      profile: {
        id: 'profile-1',
        locale: 'ja-JP',
      },
    });

    expect(graph.subject.primary_account_id).toBe('account-1');
    expect(graph.account.primary_subject_id).toBe('subject-1');
    expect(graph.link.link_type).toBe('primary');
    expect(graph.profile?.subject_id).toBe('subject-1');

    expect(adapter.getById('identity_subjects', 'subject-1')?.primary_account_id).toBe('account-1');
    expect(adapter.getById('identity_accounts', 'account-1')?.legacy_user_id).toBe('legacy-user-1');
    expect(adapter.getById('subject_account_links', 'link-1')?.source_ref).toBe('source/scim/acme');
    expect(adapter.getById('profiles', 'profile-1')?.locale).toBe('ja-JP');
  });

  it('guards writes against cross-tenant input', async () => {
    await expect(
      repository.createSubject({
        id: 'subject-cross-tenant',
        tenant_id: 'tenant-b',
      })
    ).rejects.toThrow(/tenantId does not match repository tenant/);
  });

  it('filters inactive lifecycle rows unless explicitly requested', async () => {
    await repository.createSubject({
      id: 'subject-active',
      lifecycle_state: 'active',
    });
    await repository.createSubject({
      id: 'subject-suspended',
      lifecycle_state: 'suspended',
    });

    await expect(repository.findSubjectById('subject-active')).resolves.toMatchObject({
      id: 'subject-active',
    });
    await expect(repository.findSubjectById('subject-suspended')).resolves.toBeNull();
    await expect(
      repository.findSubjectById('subject-suspended', { includeInactive: true })
    ).resolves.toMatchObject({ id: 'subject-suspended' });
  });

  it('supports legacy user lookup without reading users_core', async () => {
    await repository.createAccount({
      id: 'account-legacy',
      legacy_user_id: 'legacy-user-2',
    });

    const account = await repository.findAccountByLegacyUserId('legacy-user-2');

    expect(account?.id).toBe('account-legacy');
    const queriedSql = adapter
      .getQueryLog()
      .map((entry) => entry.sql)
      .join('\n');
    expect(queriedSql).toContain('identity_accounts');
    expect(queriedSql).not.toContain('users_core');
    expect(queriedSql).not.toContain('linked_identities');
  });

  it('stores profile, structured, and contact values through storage refs and hashes', async () => {
    const profile = await repository.createProfile({
      id: 'profile-values',
      subject_id: 'subject-values',
    });
    const profileValue = await repository.createProfileAttributeValue({
      id: 'profile-value-1',
      profile_id: profile.id,
      catalog_entry_id: 'email',
      value_type: 'reference',
      value_storage_ref: 'pii://tenant-a/email/1',
      value_hash: 'blind-index-email',
      classification: 'sensitive',
      purpose: 'login',
      is_primary: true,
    });
    const structured = await repository.createStructuredAttributeValue({
      id: 'structured-value-1',
      owner_type: 'profile',
      owner_id: profile.id,
      catalog_entry_id: 'address',
      canonical: { country: 'JP' },
      projected_index: { country: 'JP' },
      classification: 'confidential',
    });
    const contact = await repository.createContactPoint({
      id: 'contact-1',
      subject_id: 'subject-values',
      contact_type: 'email',
      normalized_hash: 'blind-index-email',
      value_storage_ref: 'pii://tenant-a/email/1',
      is_primary: true,
    });

    expect(profileValue.value_json).toBeNull();
    expect(profileValue.value_storage_ref).toBe('pii://tenant-a/email/1');
    expect(profileValue.is_primary).toBe(1);
    expect(JSON.parse(structured.canonical_json)).toEqual({ country: 'JP' });
    await expect(repository.findContactPointByNormalizedHash('blind-index-email')).resolves.toEqual(
      contact
    );
  });

  it('rejects inline sensitive or regulated profile attribute values', async () => {
    await expect(
      repository.createProfileAttributeValue({
        id: 'profile-value-sensitive-inline',
        profile_id: 'profile-sensitive',
        catalog_entry_id: 'email',
        value_type: 'string',
        value: 'person@example.com',
        classification: 'sensitive',
      })
    ).rejects.toThrow(/must use value_storage_ref/);

    expect(
      adapter.getById('profile_attribute_values', 'profile-value-sensitive-inline')
    ).toBeUndefined();
  });

  it('records bindings, resolution traces, candidates, and assurance evidence', async () => {
    const binding = await repository.createIdentityBinding({
      id: 'binding-1',
      subject_id: 'subject-1',
      account_id: 'account-1',
      protocol: 'saml',
      source_id: 'idp-acme',
      provider_subject_key_hash: 'subject-hash-1',
      assurance_level: 'ial2',
      trust_context_snapshot_id: 'trust-context-1',
    });
    const event = await repository.recordResolutionEvent({
      id: 'resolution-event-1',
      subject_id: 'subject-1',
      account_id: 'account-1',
      binding_id: binding.id,
      source_id: 'idp-acme',
      resolution_method: 'jit_link',
      outcome: 'linked',
      reason_codes: ['hard_match'],
      trace_ref: 'trace://resolution/1',
    });
    const candidate = await repository.createResolutionCandidate({
      id: 'candidate-1',
      source_id: 'idp-acme',
      candidate_subject_id: 'subject-1',
      candidate_account_id: 'account-1',
      candidate_binding_id: binding.id,
      candidate_score: 0.92,
      risk_tier: 'medium',
      reason_codes: ['email_domain_match'],
    });
    const evidence = await repository.createAssuranceEvidence({
      id: 'evidence-1',
      subject_id: 'subject-1',
      binding_id: binding.id,
      evidence_type: 'saml_authn_context',
      assurance_level: 'ial2',
      evidence_ref: 'artifact://assertion/1',
    });

    await expect(
      repository.findBindingByProviderSubjectHash('saml', 'idp-acme', 'subject-hash-1')
    ).resolves.toEqual(binding);
    expect(JSON.parse(event.reason_codes_json ?? '[]')).toEqual(['hard_match']);
    expect(candidate.decision_state).toBe('pending');
    expect(evidence.evidence_ref).toBe('artifact://assertion/1');

    await expect(repository.transitionResolutionCandidate('candidate-1', 'approved')).resolves.toBe(
      true
    );
    expect(adapter.getById('identity_resolution_candidates', 'candidate-1')?.decision_state).toBe(
      'approved'
    );
  });

  it('transitions subject and account lifecycle without hard deleting rows', async () => {
    await repository.createSubject({ id: 'subject-delete' });
    await repository.createAccount({ id: 'account-delete' });

    await expect(repository.transitionSubjectLifecycle('subject-delete', 'deleted')).resolves.toBe(
      true
    );
    await expect(repository.transitionAccountLifecycle('account-delete', 'deleting')).resolves.toBe(
      true
    );

    expect(adapter.getById('identity_subjects', 'subject-delete')).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(adapter.getById('identity_subjects', 'subject-delete')?.deleted_at).toEqual(
      expect.any(Number)
    );
    expect(adapter.getById('identity_accounts', 'account-delete')).toMatchObject({
      lifecycle_state: 'deleting',
    });
  });
});
