import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldCatalogBundle } from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  createEvidenceDb,
  EVIDENCE_TENANT,
  EVIDENCE_USER,
  type EvidenceDb,
} from './helpers/evidence-db';

const mocks = vi.hoisted(() => ({
  adapter: null as unknown,
  adapterError: null as Error | null,
  getAdapter: vi.fn(),
  settings: {} as Record<string, unknown>,
  settingsError: null as Error | null,
  loadSettings: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, resolveEffectiveSettings: mocks.loadSettings };
});

vi.mock('../../common/user-store', () => ({ getSamlUserCoreAdapter: mocks.getAdapter }));

import {
  buildSAMLAttributesForSPWithDiagnostics,
  type SAMLAttributeSubject,
  type SAMLIdentityMappingReleaseConfig,
} from '../attributes';
import { checkSAMLIdentityAssurance, withSAMLAssuranceAttributes } from '../identity-assurance';

const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';
const IAL3_URI = 'https://example.org/assurance/IAL3';
const EDU_PERSON_ASSURANCE = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.11';

const ENABLED_WITH_VALUES = {
  'assurance.enabled': true,
  'assurance.ial_assurance_values': JSON.stringify({
    IAL1: [IAL1_URI],
    IAL2: [IAL2_URI, IAL1_URI],
    IAL3: [IAL3_URI],
  }),
};

function catalog(): FieldCatalogBundle {
  return {
    identity: { id: 'catalog', version: '1', contentHash: 'hash', compatibilityRange: '^0.3.0' },
    entries: [
      {
        id: 'field.saml.eduPersonAssurance',
        namespace: 'saml.attribute',
        path: EDU_PERSON_ASSURANCE,
        valueType: 'string',
        cardinality: 'multi',
        classification: 'public',
        targetType: 'destination-only',
      },
      {
        id: 'field.saml.ial',
        namespace: 'saml.attribute',
        path: 'urn:example:ial',
        valueType: 'string',
        cardinality: 'single',
        classification: 'internal',
        targetType: 'destination-only',
      },
      {
        id: 'field.saml.mail',
        namespace: 'saml.attribute',
        path: 'mail',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'destination-only',
      },
    ],
  };
}

function edge(
  source: { namespace: string; path: string; catalogEntryId?: string },
  target: { catalogEntryId: string; path: string }
) {
  return {
    id: `edge.${source.namespace}.${source.path}.${target.path}`,
    sourceRef: { side: 'source' as const, ...source },
    targetRef: {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      ...target,
    },
  };
}

const EDU_EDGE = edge(
  {
    namespace: 'authrim.profile',
    path: 'edu_person_assurance',
    catalogEntryId: 'system.identity.edu_person_assurance',
  },
  { catalogEntryId: 'field.saml.eduPersonAssurance', path: EDU_PERSON_ASSURANCE }
);
const IAL_EDGE = edge(
  {
    namespace: 'authrim.profile',
    path: 'assurance_ial',
    catalogEntryId: 'system.identity.assurance_ial',
  },
  { catalogEntryId: 'field.saml.ial', path: 'urn:example:ial' }
);
const MAIL_EDGE = edge(
  { namespace: 'authrim.profile', path: 'email' },
  { catalogEntryId: 'field.saml.mail', path: 'mail' }
);

function mapping(
  edges: ReturnType<typeof edge>[],
  extra: Partial<SAMLIdentityMappingReleaseConfig> = {}
): SAMLIdentityMappingReleaseConfig {
  return {
    role: 'idp',
    tenantId: EVIDENCE_TENANT,
    localEntityId: 'https://idp.example.test',
    catalog: catalog(),
    edges,
    ...extra,
  };
}

const MAPPING_CONTEXT = {
  role: 'idp' as const,
  tenantId: EVIDENCE_TENANT,
  localEntityId: 'https://idp.example.test',
  partnerEntityId: 'https://sp.example.test',
};

describe('SAML identity assurance', () => {
  let evidence: EvidenceDb;
  const env = {} as never;

  beforeAll(async () => {
    evidence = await createEvidenceDb();
  });
  afterAll(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    mocks.adapter = evidence.adapter;
    mocks.adapterError = null;
    mocks.settings = { ...ENABLED_WITH_VALUES };
    mocks.settingsError = null;
    mocks.getAdapter.mockImplementation(async () => {
      if (mocks.adapterError) throw mocks.adapterError;
      return mocks.adapter as DatabaseAdapter;
    });
    mocks.loadSettings.mockImplementation(async () => {
      if (mocks.settingsError) throw mocks.settingsError;
      return mocks.settings;
    });
  });

  describe('an SP minimum IAL', () => {
    const check = (spConfig: { minimumIal?: never } | { minimumIal?: string }, scope = {}) =>
      checkSAMLIdentityAssurance(scope, {
        env,
        tenantId: EVIDENCE_TENANT,
        userId: EVIDENCE_USER,
        spConfig: spConfig as never,
      });

    it('reads no evidence and asks for no store when the SP has no minimum', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await check({})).toEqual({ outcome: 'allowed' });
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(mocks.loadSettings).not.toHaveBeenCalled();
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('lets through a person at or above the minimum', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await check({ minimumIal: 'IAL2' })).toEqual({ outcome: 'allowed' });
      expect(await check({ minimumIal: 'IAL1' })).toEqual({ outcome: 'allowed' });
    });

    it('refuses a person below it, and says what they hold and what is required', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await check({ minimumIal: 'IAL3' })).toEqual({
        outcome: 'insufficient',
        required: 'IAL3',
        actual: 'IAL2',
      });
    });

    it('takes a person with no evidence for IAL1, which is below IAL2 (a read that worked)', async () => {
      expect(await check({ minimumIal: 'IAL2' })).toEqual({
        outcome: 'insufficient',
        required: 'IAL2',
        actual: 'IAL1',
      });
      expect(evidence.evidenceReads()).toBe(1);
    });

    it.each([
      ['revoked', { revoked_at: Date.now() - 1_000 }],
      ['expired', { expires_at: Date.now() - 1_000 }],
      ['not yet verified', { verified_at: null }],
      ['verified in the future', { verified_at: Date.now() + 86_400_000 }],
      ['of another framework', { framework: 'other' }],
    ])('does not count evidence that is %s', async (_name, overrides) => {
      evidence.addEvidence('ev-1', 'IAL2', overrides);
      expect(await check({ minimumIal: 'IAL2' })).toMatchObject({
        outcome: 'insufficient',
        actual: 'IAL1',
      });
    });

    it('applies whether or not tenant-wide assurance is on', async () => {
      mocks.settings = { 'assurance.enabled': false };
      evidence.addEvidence('ev-1', 'IAL1');
      expect(await check({ minimumIal: 'IAL2' })).toMatchObject({ outcome: 'insufficient' });
    });

    it('stops with the next request once the evidence is revoked', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await check({ minimumIal: 'IAL2' })).toEqual({ outcome: 'allowed' });
      evidence.db
        .prepare('UPDATE assurance_evidence SET revoked_at = ? WHERE id = ?')
        .run(Date.now() - 1, 'ev-1');
      expect(await check({ minimumIal: 'IAL2' })).toMatchObject({ outcome: 'insufficient' });
    });

    it('is not taken for IAL1 when the evidence cannot be read', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const query = evidence.adapter.query.bind(evidence.adapter);
      evidence.adapter.query = (async () => {
        throw new Error('d1 unavailable');
      }) as never;
      const result = await check({ minimumIal: 'IAL2' });
      evidence.adapter.query = query;
      expect(result).toMatchObject({ outcome: 'unavailable', required: 'IAL2' });
    });

    it('is not taken for IAL1 when the store of the account cannot be resolved', async () => {
      mocks.adapterError = new Error('account_data_route_not_found');
      expect(await check({ minimumIal: 'IAL2' })).toMatchObject({ outcome: 'unavailable' });
    });

    it('takes a stored minimum that is not a level for the highest one, never for none', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await check({ minimumIal: 'bogus' })).toEqual({
        outcome: 'insufficient',
        required: 'IAL3',
        actual: 'IAL2',
      });
      expect(await check({ minimumIal: '' })).toMatchObject({ outcome: 'insufficient' });
    });

    it('shares one read of the evidence with the assurance attributes of the same request', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const request = {};
      await check({ minimumIal: 'IAL2' }, request);
      const subject = await withSAMLAssuranceAttributes(
        { id: EVIDENCE_USER },
        {
          requestScope: request,
          env,
          tenantId: EVIDENCE_TENANT,
          userId: EVIDENCE_USER,
          identityMapping: mapping([EDU_EDGE]),
          mappingContext: MAPPING_CONTEXT,
          onError: vi.fn(),
        }
      );
      expect(subject.edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidence.evidenceReads()).toBe(1);
    });
  });

  describe('the assurance attributes of a mapping', () => {
    const resolve = (
      identityMapping: SAMLIdentityMappingReleaseConfig | undefined,
      subject: SAMLAttributeSubject = { id: EVIDENCE_USER },
      onError = vi.fn()
    ) =>
      withSAMLAssuranceAttributes(subject, {
        requestScope: {},
        env,
        tenantId: EVIDENCE_TENANT,
        userId: EVIDENCE_USER,
        identityMapping,
        mappingContext: MAPPING_CONTEXT,
        onError,
      });

    it('releases the values of every IAL up to the person’s and the IAL itself', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]));
      expect(subject.edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(subject.assurance_ial).toBe('IAL2');
      expect(evidence.evidenceReads()).toBe(1);
    });

    it('releases only the person’s own level: IAL3 values need IAL3 evidence', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect((await resolve(mapping([EDU_EDGE]))).edu_person_assurance).not.toContain(IAL3_URI);
      evidence.addEvidence('ev-2', 'IAL3');
      expect((await resolve(mapping([EDU_EDGE]))).edu_person_assurance).toEqual([
        IAL1_URI,
        IAL2_URI,
        IAL3_URI,
      ]);
    });

    it('gives a person without evidence the IAL1 values (a read that worked)', async () => {
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]));
      expect(subject.edu_person_assurance).toEqual([IAL1_URI]);
      expect(subject.assurance_ial).toBe('IAL1');
    });

    it('reads nothing and releases nothing while assurance levels are off', async () => {
      mocks.settings = { ...ENABLED_WITH_VALUES, 'assurance.enabled': false };
      evidence.addEvidence('ev-1', 'IAL2');
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]));
      expect(subject).toEqual({ id: EVIDENCE_USER });
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('reads nothing for the values when none are configured', async () => {
      mocks.settings = { 'assurance.enabled': true, 'assurance.ial_assurance_values': '{}' };
      evidence.addEvidence('ev-1', 'IAL2');
      const subject = await resolve(mapping([EDU_EDGE]));
      expect(subject).toEqual({ id: EVIDENCE_USER });
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('still releases the IAL itself when no values are configured', async () => {
      mocks.settings = { 'assurance.enabled': true };
      evidence.addEvidence('ev-1', 'IAL2');
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]));
      expect(subject.assurance_ial).toBe('IAL2');
      expect(subject).not.toHaveProperty('edu_person_assurance');
    });

    it('releases nothing for a level that has no values', async () => {
      mocks.settings = {
        'assurance.enabled': true,
        'assurance.ial_assurance_values': JSON.stringify({ IAL2: [IAL2_URI] }),
      };
      expect(await resolve(mapping([EDU_EDGE]))).toEqual({ id: EVIDENCE_USER });
    });

    it('reads no settings and no evidence when no edge of the mapping reads an assurance source', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await resolve(mapping([MAIL_EDGE]))).toEqual({ id: EVIDENCE_USER });
      expect(await resolve(undefined)).toEqual({ id: EVIDENCE_USER });
      expect(mocks.loadSettings).not.toHaveBeenCalled();
      expect(mocks.getAdapter).not.toHaveBeenCalled();
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('reads nothing for a source of another namespace with the same name', async () => {
      const lookalike = edge(
        { namespace: 'authrim.custom_fields', path: 'edu_person_assurance' },
        { catalogEntryId: 'field.saml.eduPersonAssurance', path: EDU_PERSON_ASSURANCE }
      );
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await resolve(mapping([lookalike]))).toEqual({ id: EVIDENCE_USER });
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('reads nothing for a field the SP’s release policy hides', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const hidden = mapping([EDU_EDGE], {
        destinationFieldPolicies: { [EDU_PERSON_ASSURANCE]: 'hidden' },
      });
      expect(await resolve(hidden)).toEqual({ id: EVIDENCE_USER });
      expect(evidence.evidenceReads()).toBe(0);
      const optional = mapping([EDU_EDGE], {
        destinationFieldPolicies: { [EDU_PERSON_ASSURANCE]: 'optional' },
      });
      expect((await resolve(optional)).edu_person_assurance).toBeDefined();
    });

    it('reads nothing when the mapping has no binding for this SP', async () => {
      const other = mapping([EDU_EDGE], { partnerEntityId: 'https://other.example.test' });
      evidence.addEvidence('ev-1', 'IAL2');
      expect(await resolve(other)).toEqual({ id: EVIDENCE_USER });
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('releases neither, and reports it, when the evidence cannot be read: never as IAL1', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const query = evidence.adapter.query.bind(evidence.adapter);
      evidence.adapter.query = (async () => {
        throw new Error('d1 unavailable');
      }) as never;
      const onError = vi.fn();
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]), { id: EVIDENCE_USER }, onError);
      evidence.adapter.query = query;
      expect(subject).toEqual({ id: EVIDENCE_USER });
      expect(onError).toHaveBeenCalledOnce();
    });

    it('releases neither when the settings cannot be read', async () => {
      mocks.settingsError = new Error('kv unavailable');
      const onError = vi.fn();
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]), { id: EVIDENCE_USER }, onError);
      expect(subject).toEqual({ id: EVIDENCE_USER });
      expect(onError).toHaveBeenCalledOnce();
    });

    it('releases neither when the store of the account cannot be resolved', async () => {
      mocks.adapterError = new Error('account_data_route_not_found');
      const onError = vi.fn();
      expect(await resolve(mapping([EDU_EDGE]), { id: EVIDENCE_USER }, onError)).toEqual({
        id: EVIDENCE_USER,
      });
      expect(onError).toHaveBeenCalledOnce();
    });

    it('never takes the values from the subject: what it carried is dropped or replaced', async () => {
      const carried: SAMLAttributeSubject = {
        id: EVIDENCE_USER,
        assurance_ial: 'IAL3',
        edu_person_assurance: [IAL3_URI],
      };
      // Not released at all: the carried values go too.
      mocks.settings = { 'assurance.enabled': false };
      expect(await resolve(mapping([EDU_EDGE, IAL_EDGE]), carried)).toEqual({ id: EVIDENCE_USER });
      expect(await resolve(mapping([MAIL_EDGE]), carried)).toEqual({ id: EVIDENCE_USER });
      // Released: the evidence decides.
      mocks.settings = { ...ENABLED_WITH_VALUES };
      evidence.addEvidence('ev-1', 'IAL2');
      const subject = await resolve(mapping([EDU_EDGE, IAL_EDGE]), carried);
      expect(subject.assurance_ial).toBe('IAL2');
      expect(subject.edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
    });

    it('does not let an ordinary user field stand in for the sources', async () => {
      evidence.addEvidence('ev-1', 'IAL1');
      const subject = await resolve(mapping([EDU_EDGE]), {
        id: EVIDENCE_USER,
        customFields: { edu_person_assurance: [IAL3_URI], assurance_ial: 'IAL3' },
        customClaims: { edu_person_assurance: [IAL3_URI] },
        claims: { edu_person_assurance: [IAL3_URI] },
        attributes: { edu_person_assurance: [IAL3_URI] },
      });
      expect(subject.edu_person_assurance).toEqual([IAL1_URI]);
      expect(subject).not.toHaveProperty('assurance_ial');
    });

    describe('through the mapping runtime', () => {
      it('releases eduPersonAssurance as a multi-valued attribute and the IAL as a single one', async () => {
        evidence.addEvidence('ev-1', 'IAL2');
        const identityMapping = mapping([EDU_EDGE, IAL_EDGE, MAIL_EDGE]);
        const subject = await resolve(identityMapping, {
          id: EVIDENCE_USER,
          email: 'user@example.test',
        });
        const result = buildSAMLAttributesForSPWithDiagnostics(subject, {
          attributeMapping: {},
          ...MAPPING_CONTEXT,
          entityId: MAPPING_CONTEXT.partnerEntityId,
          identityMapping,
        });
        expect(result.attributes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: EDU_PERSON_ASSURANCE,
              values: [IAL1_URI, IAL2_URI],
            }),
            expect.objectContaining({ name: 'urn:example:ial', values: ['IAL2'] }),
            expect.objectContaining({ name: 'mail', values: ['user@example.test'] }),
          ])
        );
      });

      it('releases no attribute when nothing was resolved for the subject', () => {
        const identityMapping = mapping([EDU_EDGE, IAL_EDGE]);
        const result = buildSAMLAttributesForSPWithDiagnostics(
          { id: EVIDENCE_USER },
          {
            attributeMapping: {},
            ...MAPPING_CONTEXT,
            entityId: MAPPING_CONTEXT.partnerEntityId,
            identityMapping,
          }
        );
        expect(result.attributes).toEqual([]);
      });
    });
  });
});
