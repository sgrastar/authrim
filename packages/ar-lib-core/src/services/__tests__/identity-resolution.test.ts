import { beforeEach, describe, expect, it } from 'vitest';
import { CanonicalIdentityRepository } from '../../repositories/identity';
import { MockDatabaseAdapter } from '../../repositories/__tests__/mock-adapter';
import { createSamlIdentityBindingKey } from '../identity-identifier-bridge';
import { IDENTITY_RESOLUTION_REASON_CODES, resolveIdentityBinding } from '../identity-resolution';

const TABLES = [
  'identity_bindings',
  'identity_resolution_events',
  'identity_resolution_candidates',
];

describe('resolveIdentityBinding', () => {
  let adapter: MockDatabaseAdapter;
  let repository: CanonicalIdentityRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    for (const table of TABLES) {
      adapter.initTable(table, 'id');
    }
    repository = new CanonicalIdentityRepository(adapter, 'tenant-a');
  });

  it('resolves an existing binding by hard match and records an event', async () => {
    const bindingKey = await createSamlIdentityBindingKey({
      issuer: 'https://idp.example.edu',
      nameId: 'opaque-nameid',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      spNameQualifier: 'https://sp.example.org',
    });
    const binding = await repository.createIdentityBinding({
      id: 'binding-1',
      subject_id: 'subject-1',
      account_id: 'account-1',
      protocol: bindingKey.protocol,
      source_id: bindingKey.sourceId,
      provider_subject_key_hash: bindingKey.providerSubjectKeyHash,
      metadata: bindingKey.metadata,
    });

    const result = await resolveIdentityBinding(repository, {
      bindingKey,
      metadata: { reason: 'saml-sso' },
    });

    expect(result).toMatchObject({
      outcome: 'matched',
      binding,
      candidates: [],
    });
    expect(adapter.getAll('identity_resolution_events')).toHaveLength(1);
    expect(JSON.parse(result.event.reason_codes_json ?? '[]')).toEqual([
      IDENTITY_RESOLUTION_REASON_CODES.hardMatch,
    ]);
  });

  it('rejects unmatched identities by default without creating candidates', async () => {
    const bindingKey = await createSamlIdentityBindingKey({
      issuer: 'https://idp.example.edu',
      nameId: 'new-nameid',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    });

    const result = await resolveIdentityBinding(repository, { bindingKey });

    expect(result).toMatchObject({
      outcome: 'rejected',
      binding: null,
      candidates: [],
    });
    expect(adapter.getAll('identity_resolution_candidates')).toHaveLength(0);
    expect(JSON.parse(result.event.reason_codes_json ?? '[]')).toEqual([
      IDENTITY_RESOLUTION_REASON_CODES.hardMatchMissing,
      IDENTITY_RESOLUTION_REASON_CODES.candidateGenerationDisabled,
    ]);
  });

  it('creates review candidates only when candidate generation is explicitly enabled', async () => {
    const bindingKey = await createSamlIdentityBindingKey({
      issuer: 'https://idp.example.edu',
      nameId: 'new-nameid',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    });

    const result = await resolveIdentityBinding(repository, {
      bindingKey,
      resolutionPolicy: 'candidate_generation',
      candidateEvidence: [
        {
          candidateSubjectId: 'subject-1',
          score: 88,
          riskTier: 'medium',
          reasonCodes: ['verified_email_anchor'],
        },
      ],
    });

    expect(result).toMatchObject({
      outcome: 'review_required',
      binding: null,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      candidate_subject_id: 'subject-1',
      decision_state: 'pending',
    });
  });
});
