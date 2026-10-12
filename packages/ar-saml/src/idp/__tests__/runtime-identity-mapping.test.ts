/**
 * The identity mapping of an SP as a deployed tenant has it: only the Field Mapping Set is named,
 * and the runtime catalog (the compiled snapshot's virtual canonical catalog) has no entry for the
 * SAML attributes released to. The mapping runtime drops a value whose destination has no catalog
 * entry, so resolving the mapping adds one per field of the SP's release policy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';
import {
  emptyCoreAdapter,
  OID_EDU_PERSON_ASSURANCE,
  OID_ENTITLEMENT,
  OID_MAIL,
  OID_SURNAME,
  PRODUCTION_DESTINATION_SCHEMA,
  PRODUCTION_SP_ENTITY_ID,
  productionAdminAdapter,
  productionBinding,
  PRODUCTION_EDGES,
  PRODUCTION_INPUT_EDGES,
  PRODUCTION_SAML_INPUT_EDGE,
  PRODUCTION_SAML_INPUT_REQUIRED_RULE,
  productionSpConfig,
  seededCanonicalEntries,
} from '../__fixtures__/production-shaped-mapping';

const mocks = vi.hoisted(() => ({
  binding: null as unknown,
  admin: null as unknown,
  core: null as unknown,
  resolveBinding: vi.fn(),
  assuranceSettings: {} as Record<string, unknown>,
  evidenceAdapter: null as unknown,
  getAdapter: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    resolveRuntimeIdentityMappingBinding: mocks.resolveBinding,
    resolveEffectiveSettings: vi.fn(async () => mocks.assuranceSettings),
  };
});
vi.mock('../../common/user-store', () => ({ getSamlUserCoreAdapter: mocks.getAdapter }));

import { filterSamlAttributesByDestinationConsentWithStatus } from '@authrim/ar-lib-core';
import {
  buildSAMLAttributesForSPWithDiagnostics,
  resolveSAMLIdentityMappingFieldMappingBinding,
} from '../attributes';
import { withSAMLAssuranceAttributes } from '../identity-assurance';
import {
  destinationCatalogEntries,
  findRenamedAttributeDescriptors,
  resolveSAMLRuntimeIdentityMapping,
} from '../runtime-identity-mapping';

const destinationEntries = (
  mapping: { catalog?: { entries: Array<{ namespace: string; path: string }> } } | undefined
) => (mapping?.catalog?.entries ?? []).filter((entry) => entry.namespace === 'saml.attribute');

const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';
const env = {} as never;

describe('destinationCatalogEntries', () => {
  const fields = [
    { key: 'a', classification: 'pii', valueMultiplicity: 'single' as const },
    { key: 'b', classification: 'public', valueMultiplicity: 'multi' as const },
    { key: 'c', classification: 'weird', valueMultiplicity: null },
  ];

  it('adds a destination-only entry for each policy key the profile lists', () => {
    const added = destinationCatalogEntries({
      namespace: 'saml.attribute',
      policyKeys: ['a', 'b', 'c'],
      profileFields: fields,
      existing: [],
    });
    expect(added).toEqual([
      expect.objectContaining({
        id: 'dest.saml.a',
        namespace: 'saml.attribute',
        path: 'a',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'destination-only',
      }),
      expect.objectContaining({
        id: 'dest.saml.b',
        cardinality: 'multi',
        classification: 'public',
      }),
      // A classification the catalog does not know is the plain internal one.
      expect.objectContaining({
        id: 'dest.saml.c',
        cardinality: 'single',
        classification: 'internal',
      }),
    ]);
  });

  it('adds nothing for a key the profile does not list, or that has an entry already', () => {
    const existing = [
      {
        id: 'x',
        namespace: 'saml.attribute',
        path: 'a',
        valueType: 'string',
        cardinality: 'single' as const,
        classification: 'pii' as const,
        targetType: 'destination-only' as const,
      },
    ];
    const added = destinationCatalogEntries({
      namespace: 'saml.attribute',
      policyKeys: ['a', 'unlisted', 'b', 'b'],
      profileFields: fields,
      existing,
    });
    expect(added.map((entry) => entry.path)).toEqual(['b']);
  });

  it('uses the namespace it is given, so the entry matches the edge it serves', () => {
    const added = destinationCatalogEntries({
      namespace: 'vendor.saml',
      policyKeys: ['a'],
      profileFields: fields,
      existing: [],
    });
    expect(added[0]?.namespace).toBe('vendor.saml');
  });
});

describe('the identity mapping of an SP in a deployed tenant', () => {
  let evidence: EvidenceDb;

  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });
  afterAll(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    mocks.binding = productionBinding();
    mocks.admin = productionAdminAdapter();
    mocks.core = emptyCoreAdapter();
    mocks.resolveBinding.mockImplementation(async () => mocks.binding);
    mocks.evidenceAdapter = evidence.adapter;
    mocks.getAdapter.mockImplementation(async () => mocks.evidenceAdapter);
    mocks.assuranceSettings = {
      'assurance.enabled': true,
      'assurance.ial_assurance_values': JSON.stringify({
        IAL1: [IAL1_URI],
        IAL2: [IAL2_URI, IAL1_URI],
      }),
    };
  });

  const resolve = (spConfig = productionSpConfig()) =>
    resolveSAMLRuntimeIdentityMapping(
      env,
      'tenant-a',
      'https://idp.example.test',
      spConfig as never
    );

  /** What the SSO endpoints do from the resolved mapping to the attributes released. */
  async function release(
    spConfig = productionSpConfig(),
    user = {
      id: 'user-a',
      email: 'user@example.test',
      family_name: 'Example',
      unlisted: 'private-value',
    }
  ) {
    const identityMapping = await resolve(spConfig);
    const subject = await withSAMLAssuranceAttributes(user, {
      requestScope: {},
      env,
      tenantId: 'tenant-a',
      userId: 'user-a',
      identityMapping,
      mappingContext: {
        role: 'idp',
        tenantId: 'tenant-a',
        localEntityId: 'https://idp.example.test',
        partnerEntityId: PRODUCTION_SP_ENTITY_ID,
      },
      onError: vi.fn(),
    });
    const built = buildSAMLAttributesForSPWithDiagnostics(subject, {
      ...spConfig,
      tenantId: 'tenant-a',
      localEntityId: 'https://idp.example.test',
      identityMapping,
    } as never);
    const filtered = await filterSamlAttributesByDestinationConsentWithStatus({
      coreAdapter: emptyCoreAdapter() as never,
      adminAdapter: mocks.admin as never,
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      samlSpId: PRODUCTION_SP_ENTITY_ID,
      profileId: identityMapping!.destinationProfileId!,
      fieldPolicies: identityMapping!.destinationFieldPolicies,
      releaseSafetyBinding: resolveSAMLIdentityMappingFieldMappingBinding(identityMapping!, {
        role: 'idp',
        tenantId: 'tenant-a',
        localEntityId: 'https://idp.example.test',
        partnerEntityId: PRODUCTION_SP_ENTITY_ID,
      }),
      attributes: built.attributes,
    });
    return filtered.attributes;
  }

  it('releases mail and the assurance values over the stored default canonical catalog', async () => {
    evidence.addEvidence('ev-1', 'IAL2');

    const attributes = await release();

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: OID_MAIL, values: ['user@example.test'] }),
        expect.objectContaining({
          name: OID_EDU_PERSON_ASSURANCE,
          values: [IAL1_URI, IAL2_URI],
        }),
      ])
    );
  });

  it('asks for the canonical catalog’s entries, which the release judges its sources by', async () => {
    await resolve();
    expect(mocks.resolveBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolveCanonicalCatalog: true })
    );
  });

  it('adds the destination entries to the catalog of the mapping, one per profile field of the policy', async () => {
    const mapping = await resolve();
    expect(
      destinationEntries(mapping)
        .map((entry) => entry.path)
        .sort()
    ).toEqual([OID_MAIL, OID_SURNAME, OID_EDU_PERSON_ASSURANCE, OID_ENTITLEMENT].sort());
    const assurance = mapping?.catalog?.entries.find(
      (entry) => entry.path === OID_EDU_PERSON_ASSURANCE
    );
    expect(assurance).toMatchObject({
      namespace: 'saml.attribute',
      cardinality: 'multi',
      classification: 'public',
      targetType: 'destination-only',
    });
  });

  it('drops an attribute the SP’s policy makes optional when the person has selected nothing, as before', async () => {
    evidence.addEvidence('ev-1', 'IAL2');
    const names = (await release()).map((attribute) => attribute.name);
    expect(names).not.toContain(OID_SURNAME);
  });

  it('does not release a hidden attribute, and does not read the evidence for a hidden assurance field', async () => {
    evidence.addEvidence('ev-1', 'IAL2');
    const attributes = await release(
      productionSpConfig({
        [OID_MAIL]: 'hidden',
        [OID_SURNAME]: 'optional',
        [OID_EDU_PERSON_ASSURANCE]: 'hidden',
        [OID_ENTITLEMENT]: 'optional',
      })
    );
    expect(attributes).toEqual([]);
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('keeps a required attribute without a value a failure', async () => {
    evidence.addEvidence('ev-1', 'IAL2');
    // The person has no email: mail is required, so nothing may be released without it.
    await expect(release(productionSpConfig(), { id: 'user-a' } as never)).rejects.toMatchObject({
      name: 'MissingRequiredSAMLAttributeError',
    });
  });

  it('keeps a required assurance attribute a failure while no values are configured', async () => {
    mocks.assuranceSettings = { 'assurance.enabled': true, 'assurance.ial_assurance_values': '{}' };
    await expect(release()).rejects.toMatchObject({ name: 'MissingRequiredSAMLAttributeError' });
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('changes nothing for an SP without a release policy: no profile read, no entries added', async () => {
    const admin = productionAdminAdapter();
    const queryOne = vi.fn(admin.queryOne);
    mocks.admin = { ...admin, queryOne };
    const spConfig = productionSpConfig({}) as { identityMapping: Record<string, unknown> };
    delete spConfig.identityMapping.destinationFieldPolicies;
    const mapping = await resolve(spConfig as never);
    expect(queryOne).not.toHaveBeenCalled();
    expect(mapping?.catalog?.entries).toEqual(seededCanonicalEntries());
  });

  it('adds nothing when the destination profile cannot be read, leaving the release to fail as before', async () => {
    mocks.admin = { ...productionAdminAdapter(), queryOne: async () => null };
    const mapping = await resolve();
    expect(destinationEntries(mapping)).toEqual([]);
  });

  it('adds nothing for a policy field the profile does not list', async () => {
    mocks.admin = productionAdminAdapter({
      ...PRODUCTION_DESTINATION_SCHEMA,
      attributes: PRODUCTION_DESTINATION_SCHEMA.attributes.filter(
        (attribute) => attribute.name === OID_MAIL
      ),
    });
    const mapping = await resolve();
    expect(destinationEntries(mapping).map((entry) => entry.path)).toEqual([OID_MAIL]);
  });

  describe('a set that holds the rules of both directions (the shape the Admin UI saves)', () => {
    const outputOf = (attributes: Array<{ name: string; values: string[] }>) =>
      attributes.map((attribute) => [attribute.name, attribute.values]);

    it('releases the same attributes whether or not it also holds the rules that bring a source profile in', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = productionBinding({ withInputEdges: false });
      const withoutInput = outputOf(await release());
      mocks.binding = productionBinding({ withInputEdges: true });
      const withInput = outputOf(await release());

      expect(withInput).toEqual(withoutInput);
      expect(withInput).toEqual(
        expect.arrayContaining([
          [OID_MAIL, ['user@example.test']],
          [OID_EDU_PERSON_ASSURANCE, [IAL1_URI, IAL2_URI]],
        ])
      );
    });

    it('runs only the edges that release: the source profile’s rules are not part of the mapping', async () => {
      mocks.binding = productionBinding({ withInputEdges: true });
      const mapping = await resolve();
      expect(mapping?.edges?.map((edge) => edge.id)).toEqual(
        PRODUCTION_EDGES.map((edge) => edge.id)
      );
    });

    it('is not stopped by an input rule whose source the canonical catalog does not describe', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = productionBinding({ withInputEdges: true });
      await expect(release()).resolves.toBeDefined();
    });

    it('still refuses an edge that releases from a source it cannot classify', async () => {
      mocks.binding = {
        ...productionBinding({ withInputEdges: true }),
        edges: [
          ...PRODUCTION_INPUT_EDGES,
          {
            id: 'edge_unlisted',
            sourceRef: { side: 'source', namespace: 'authrim.claim', path: 'unlisted' },
            targetRef: {
              side: 'destination',
              namespace: 'saml.attribute',
              path: OID_EDU_PERSON_ASSURANCE,
            },
          },
        ],
      };
      await expect(
        release(
          productionSpConfig({
            [OID_MAIL]: 'optional',
            [OID_SURNAME]: 'optional',
            [OID_EDU_PERSON_ASSURANCE]: 'required',
            [OID_ENTITLEMENT]: 'optional',
          })
        )
      ).rejects.toMatchObject({ reason: 'source_classification_unknown' });
    });

    it('still refuses one catalog entry id for two reads among the edges that release', async () => {
      mocks.binding = {
        ...productionBinding({ withInputEdges: true }),
        edges: [
          ...PRODUCTION_INPUT_EDGES,
          {
            id: 'e1',
            sourceRef: {
              side: 'source',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.locale',
            },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'urn:oid:x' },
          },
          {
            id: 'e2',
            sourceRef: {
              side: 'source',
              namespace: 'authrim.profile',
              path: 'locale',
              catalogEntryId: 'field.canonical.locale',
            },
            targetRef: {
              side: 'destination',
              namespace: 'saml.attribute',
              path: OID_EDU_PERSON_ASSURANCE,
            },
          },
        ],
      };
      await expect(
        release(productionSpConfig(), { id: 'user-a', email: 'a@b.c', locale: 'ja' } as never)
      ).rejects.toMatchObject({ name: 'SAMLIdentityMappingRuntimeError' });
    });
  });

  describe('validation rules of a set that holds both directions', () => {
    const requiredCritical = (field: Record<string, unknown>) => ({
      id: `validation_${String(field.path)}`,
      kind: 'required',
      targetRef: field,
      defaultSeverity: 'critical',
    });
    const inputSideRequired = requiredCritical({
      side: 'source',
      namespace: 'scim.attribute',
      path: 'userName',
    });
    const outputSideRequired = requiredCritical({
      side: 'source',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.canonical.email',
    });

    it('does not apply a required rule on the source profile’s field to the SAML release', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = productionBinding({ validationRules: [inputSideRequired] });
      // The subject has no userName: the rule is about what the source profile brings in.
      const attributes = await release();
      expect(attributes.map((attribute) => attribute.name)).toEqual(
        expect.arrayContaining([OID_MAIL, OID_EDU_PERSON_ASSURANCE])
      );
      expect((await resolve())?.validationRules).toEqual([]);
    });

    it('still applies a required rule on a field the release reads: a missing value is refused', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = productionBinding({
        validationRules: [outputSideRequired, inputSideRequired],
      });
      expect((await resolve())?.validationRules).toEqual([outputSideRequired]);
      await expect(release(productionSpConfig(), { id: 'user-a' } as never)).rejects.toMatchObject({
        name: 'SAMLIdentityMappingRuntimeError',
      });
      await expect(release()).resolves.toBeDefined();
    });

    it('does not mistake the destination attribute for the source attribute of the same name: the input rule’s validation stays out', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = {
        ...productionBinding({ validationRules: [PRODUCTION_SAML_INPUT_REQUIRED_RULE] }),
        edges: [PRODUCTION_SAML_INPUT_EDGE, ...PRODUCTION_EDGES],
      };
      expect((await resolve())?.validationRules).toEqual([]);
      // The subject has the email (and no saml.attribute source): the attribute is released.
      const attributes = await release();
      expect(attributes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: OID_MAIL, values: ['user@example.test'] }),
        ])
      );
    });

    it('keeps a rule that names a field no edge uses', async () => {
      const unknown = requiredCritical({ side: 'source', namespace: 'somewhere.else', path: 'x' });
      mocks.binding = productionBinding({ validationRules: [unknown] });
      expect((await resolve())?.validationRules).toEqual([unknown]);
    });
  });

  describe('fields named like members of Object.prototype', () => {
    const odd = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((path) => ({
      id: `field.canonical.${path}`,
      namespace: 'authrim.canonical',
      path,
      valueType: 'string',
      cardinality: 'single' as const,
      classification: 'internal' as const,
      targetType: 'canonical' as const,
    }));

    it('in the catalog, unused, do not stop a release that uses other fields', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.binding = {
        ...productionBinding(),
        catalog: {
          ...productionBinding().catalog,
          entries: [...seededCanonicalEntries(), ...odd],
        },
      };
      await expect(release()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: OID_MAIL })])
      );
    });

    it('as a destination field are named as they are, and are not taken for a renaming', async () => {
      const identityMapping = {
        role: 'idp' as const,
        tenantId: 'tenant-a',
        localEntityId: 'https://idp.example.test',
        partnerEntityId: PRODUCTION_SP_ENTITY_ID,
        catalog: {
          identity: { id: 'c', version: '1', contentHash: 'h', compatibilityRange: '*' },
          entries: [
            {
              id: 'dest.constructor',
              namespace: 'saml.attribute',
              path: 'constructor',
              valueType: 'string',
              cardinality: 'single' as const,
              classification: 'internal' as const,
              targetType: 'destination-only' as const,
            },
          ],
        },
        edges: [
          {
            id: 'e',
            sourceRef: { side: 'source' as const, namespace: 'authrim.profile', path: 'email' },
            targetRef: {
              side: 'destination' as const,
              namespace: 'saml.attribute',
              path: 'constructor',
            },
          },
        ],
        attributeDescriptors: { [OID_MAIL]: { friendlyName: 'mail' } },
      };
      const { attributes } = buildSAMLAttributesForSPWithDiagnostics(
        { id: 'user-a', email: 'a@b.c' } as never,
        {
          attributeMapping: {},
          ...identityMapping,
          entityId: PRODUCTION_SP_ENTITY_ID,
          identityMapping,
        } as never
      );
      expect(attributes.map((attribute) => attribute.name)).toEqual(['constructor']);
      expect(
        findRenamedAttributeDescriptors(
          [{ namespace: 'saml.attribute', path: 'constructor' }],
          identityMapping.attributeDescriptors
        )
      ).toEqual([]);
    });

    it('are not read from the subject’s prototype', async () => {
      const read = (path: string) =>
        buildSAMLAttributesForSPWithDiagnostics(
          { id: 'user-a' } as never,
          {
            attributeMapping: {},
            tenantId: 'tenant-a',
            localEntityId: 'https://idp.example.test',
            entityId: PRODUCTION_SP_ENTITY_ID,
            identityMapping: {
              role: 'idp',
              tenantId: 'tenant-a',
              localEntityId: 'https://idp.example.test',
              partnerEntityId: PRODUCTION_SP_ENTITY_ID,
              catalog: {
                identity: { id: 'c', version: '1', contentHash: 'h', compatibilityRange: '*' },
                entries: [
                  {
                    id: 'dest.x',
                    namespace: 'saml.attribute',
                    path: 'x',
                    valueType: 'string',
                    cardinality: 'single',
                    classification: 'internal',
                    targetType: 'destination-only',
                  },
                ],
              },
              edges: [
                {
                  id: 'e',
                  sourceRef: { side: 'source', namespace: 'authrim.profile', path },
                  targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'x' },
                },
              ],
            },
          } as never
        ).attributes;
      for (const path of ['constructor', '__proto__.polluted', 'toString', 'constructor.name']) {
        expect(read(path)).toEqual([]);
      }
    });
  });

  describe('two spellings of one place', () => {
    const custom = (id: string, namespace: string, path: string, classification: string) => ({
      id,
      namespace,
      path,
      valueType: 'string',
      cardinality: 'single' as const,
      classification,
      targetType: 'custom' as const,
    });

    it('are one place: custom_claims.x under the profile is customClaims.x, and its classification is the stricter entry’s', async () => {
      mocks.binding = {
        ...productionBinding(),
        catalog: {
          ...productionBinding().catalog,
          entries: [
            ...seededCanonicalEntries(),
            custom('entry.public', 'authrim.profile', 'custom_claims.entitlement', 'public'),
            custom('entry.secret', 'authrim.custom_claims', 'entitlement', 'secret'),
          ],
        },
        edges: [
          {
            id: 'e',
            sourceRef: {
              side: 'source',
              namespace: 'authrim.profile',
              path: 'custom_claims.entitlement',
              catalogEntryId: 'entry.public',
            },
            targetRef: {
              side: 'destination',
              namespace: 'saml.attribute',
              path: OID_EDU_PERSON_ASSURANCE,
            },
          },
        ],
      };
      // The value released is customClaims.entitlement (the secret one).
      const user = { id: 'user-a', customClaims: { entitlement: 'confidential' } } as never;
      await expect(
        release(
          productionSpConfig({
            [OID_MAIL]: 'optional',
            [OID_SURNAME]: 'optional',
            [OID_EDU_PERSON_ASSURANCE]: 'required',
            [OID_ENTITLEMENT]: 'optional',
          }),
          user
        )
      ).rejects.toMatchObject({
        name: 'RuntimeIdentityMappingReleaseSafetyError',
        reason: 'classification_lowered',
      });
    });

    it('are read as one value: custom_claims.x, customClaims.x and the sub / user_id aliases', async () => {
      const read = async (path: string, user: Record<string, unknown>) => {
        const identityMapping = {
          role: 'idp' as const,
          tenantId: 'tenant-a',
          localEntityId: 'https://idp.example.test',
          partnerEntityId: PRODUCTION_SP_ENTITY_ID,
          catalog: {
            identity: { id: 'c', version: '1', contentHash: 'h', compatibilityRange: '*' },
            entries: [
              {
                id: 'dest.x',
                namespace: 'saml.attribute',
                path: 'x',
                valueType: 'string',
                cardinality: 'single' as const,
                classification: 'internal' as const,
                targetType: 'destination-only' as const,
              },
            ],
          },
          edges: [
            {
              id: 'e',
              sourceRef: { side: 'source' as const, namespace: 'authrim.profile', path },
              targetRef: { side: 'destination' as const, namespace: 'saml.attribute', path: 'x' },
            },
          ],
        };
        return buildSAMLAttributesForSPWithDiagnostics(
          user as never,
          {
            attributeMapping: {},
            ...identityMapping,
            entityId: PRODUCTION_SP_ENTITY_ID,
            identityMapping,
          } as never
        ).attributes.map((attribute) => attribute.values);
      };
      const user = { id: 'user-a', customClaims: { x: 'one' }, customFields: { y: 'two' } };
      expect(await read('custom_claims.x', user)).toEqual([['one']]);
      expect(await read('customClaims.x', user)).toEqual([['one']]);
      expect(await read('custom_fields.y', user)).toEqual([['two']]);
      expect(await read('sub', user)).toEqual([['user-a']]);
      expect(await read('user_id', user)).toEqual([['user-a']]);
    });
  });

  describe('what a mapping may release, and from what', () => {
    const edgeFrom = (source: Record<string, unknown>, target: string) => ({
      id: `edge_${target}`,
      sourceRef: { side: 'source', ...source },
      targetRef: { side: 'destination', namespace: 'saml.attribute', path: target },
    });
    const useEdges = (...edges: ReturnType<typeof edgeFrom>[]) => {
      mocks.binding = { ...productionBinding(), edges };
    };
    const required = (...keys: string[]) =>
      productionSpConfig(
        Object.fromEntries(
          [OID_MAIL, OID_SURNAME, OID_EDU_PERSON_ASSURANCE, OID_ENTITLEMENT].map((key) => [
            key,
            keys.includes(key) ? 'required' : 'optional',
          ])
        ) as never
      );
    const unknownSource = {
      name: 'RuntimeIdentityMappingReleaseSafetyError',
      reason: 'source_classification_unknown',
    };

    describe('an attribute descriptor that renames the attribute', () => {
      it('is refused: the release policy and classification are by profile field', async () => {
        const spConfig = productionSpConfig(undefined, {
          identityMapping: {
            ...productionSpConfig().identityMapping,
            attributeDescriptors: { [OID_MAIL]: { name: OID_ENTITLEMENT } },
          },
        });
        await expect(resolve(spConfig)).rejects.toMatchObject({
          name: 'SAMLIdentityMappingRuntimeError',
          reasons: [expect.objectContaining({ code: 'policy.attribute_descriptor_renames_field' })],
        });
      });

      it('is refused whichever key names it', async () => {
        for (const key of ['saml.attribute:' + OID_MAIL, OID_MAIL]) {
          const spConfig = productionSpConfig(undefined, {
            identityMapping: {
              ...productionSpConfig().identityMapping,
              attributeDescriptors: { [key]: { name: 'something-else' } },
            },
          });
          await expect(resolve(spConfig)).rejects.toMatchObject({
            name: 'SAMLIdentityMappingRuntimeError',
          });
        }
      });

      it('may restate the name, and may set the friendly name and format', async () => {
        const spConfig = productionSpConfig(undefined, {
          identityMapping: {
            ...productionSpConfig().identityMapping,
            attributeDescriptors: {
              [OID_MAIL]: { name: OID_MAIL, friendlyName: 'mail' },
              [OID_SURNAME]: { friendlyName: 'sn' },
            },
          },
        });
        await expect(resolve(spConfig)).resolves.toBeDefined();
      });
    });

    describe('a source whose classification cannot be told', () => {
      it.each([
        ['a place no catalog entry describes', { namespace: 'authrim.claim', path: 'unlisted' }],
        [
          'an entry that describes another path than the one it reads',
          {
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.canonical.locale',
          },
        ],
        [
          'an entry the catalog does not have',
          {
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.canonical.nothing',
          },
        ],
        [
          'a runtime-defined source that reads another path',
          {
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'system.identity.edu_person_assurance',
          },
        ],
        [
          'an invented system.identity source',
          {
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'system.identity.invented',
          },
        ],
      ])('is refused, however public the attribute it goes to: %s', async (_name, source) => {
        useEdges(edgeFrom(source, OID_EDU_PERSON_ASSURANCE));
        await expect(release(required(OID_EDU_PERSON_ASSURANCE))).rejects.toMatchObject(
          unknownSource
        );
      });

      it('is refused when nothing is stored for the catalog, whatever the source says', async () => {
        mocks.binding = productionBinding({ catalog: 'empty' });
        await expect(release()).rejects.toMatchObject(unknownSource);
      });

      it('is found by what it reads: another namespace for the same place is the same source', async () => {
        useEdges(edgeFrom({ namespace: 'authrim.claim', path: 'email' }, OID_EDU_PERSON_ASSURANCE));
        // email is personal data, wherever the namespace says it is read from.
        await expect(release(required(OID_EDU_PERSON_ASSURANCE))).rejects.toMatchObject({
          reason: 'classification_lowered',
        });
      });

      it('is refused for an attribute the profile does not list, too: its value could be matched to another edge', async () => {
        useEdges(
          edgeFrom({ namespace: 'authrim.claim', path: 'unlisted' }, 'urn:oid:not-in-profile')
        );
        await expect(release(required())).rejects.toMatchObject(unknownSource);
      });

      it('is not skipped because its sides are swapped: a reference that says it is a destination is refused', async () => {
        useEdges(
          edgeFrom(
            {
              side: 'destination',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.locale',
            },
            OID_EDU_PERSON_ASSURANCE
          )
        );
        await expect(release(required(OID_EDU_PERSON_ASSURANCE))).rejects.toMatchObject({
          name: 'RuntimeIdentityMappingReleaseSafetyError',
          reason: 'edge_reference_invalid',
        });
      });

      it('is not another place’s: the same path under another namespace is judged by the namespace it reads', async () => {
        mocks.binding = {
          ...productionBinding(),
          catalog: {
            ...productionBinding().catalog,
            entries: [
              ...seededCanonicalEntries(),
              {
                id: 'entry.profile.entitlement',
                namespace: 'authrim.profile',
                path: 'entitlement',
                valueType: 'string',
                cardinality: 'single',
                classification: 'public',
                targetType: 'canonical',
              },
              {
                id: 'entry.custom.entitlement',
                namespace: 'authrim.custom_claims',
                path: 'entitlement',
                valueType: 'string',
                cardinality: 'single',
                classification: 'secret',
                targetType: 'custom',
              },
            ],
          },
          edges: [
            // Reads customClaims.entitlement (secret), names the public profile entitlement entry.
            edgeFrom(
              {
                namespace: 'authrim.custom_claims',
                path: 'entitlement',
                catalogEntryId: 'entry.profile.entitlement',
              },
              OID_EDU_PERSON_ASSURANCE
            ),
          ],
        };
        const user = { id: 'user-a', customClaims: { entitlement: 'confidential' } } as never;
        await expect(release(required(OID_EDU_PERSON_ASSURANCE), user)).rejects.toMatchObject(
          unknownSource
        );

        // Without the wrong id the secret entry is the one found, and it may not go to a public field.
        mocks.binding = {
          ...(mocks.binding as object),
          edges: [
            edgeFrom(
              { namespace: 'authrim.custom_claims', path: 'entitlement' },
              OID_EDU_PERSON_ASSURANCE
            ),
          ],
        };
        await expect(release(required(OID_EDU_PERSON_ASSURANCE), user)).rejects.toMatchObject({
          reason: 'classification_lowered',
        });
      });

      it('is not mixed with another edge’s: one catalog entry id may not stand for two reads', async () => {
        useEdges(
          // email, under the id of the public locale entry, to a field the profile does not list;
          edgeFrom(
            {
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.locale',
            },
            'urn:oid:intermediate'
          ),
          // and locale, under that same id, to a public required attribute.
          edgeFrom(
            {
              namespace: 'authrim.profile',
              path: 'locale',
              catalogEntryId: 'field.canonical.locale',
            },
            OID_EDU_PERSON_ASSURANCE
          )
        );
        const user = { id: 'user-a', email: 'user@example.test', locale: 'ja' } as never;
        await expect(release(required(OID_EDU_PERSON_ASSURANCE), user)).rejects.toMatchObject({
          name: 'SAMLIdentityMappingRuntimeError',
          reasons: [expect.objectContaining({ code: 'policy.mapping_source_reference_conflict' })],
        });
      });
    });

    describe('a source the tenant defines itself', () => {
      const schema = (isPii: number) => ({
        id: 'schema-1',
        field_key: 'employeeNumber',
        active_field_key: null,
        field_type: 'string',
        cardinality: 'single',
        is_pii: isPii,
      });
      const employeeEdge = () =>
        edgeFrom(
          {
            namespace: 'authrim.profile',
            path: 'employeeNumber',
            catalogEntryId: 'field.canonical.employeeNumber',
          },
          OID_ENTITLEMENT
        );
      const employee = { id: 'user-a', employeeNumber: 'E-1' } as never;

      it('is read from the tenant’s field schemas, so it can be released to a profile field that fits', async () => {
        mocks.core = emptyCoreAdapter([schema(0)]);
        useEdges(employeeEdge());
        await expect(release(required(OID_ENTITLEMENT), employee)).resolves.toEqual([
          expect.objectContaining({ name: OID_ENTITLEMENT, values: ['E-1'] }),
        ]);
      });

      it('is held to its schema’s classification: personal data may not go to an internal field', async () => {
        mocks.core = emptyCoreAdapter([schema(1)]);
        useEdges(employeeEdge());
        await expect(release(required(OID_ENTITLEMENT), employee)).rejects.toMatchObject({
          name: 'RuntimeIdentityMappingReleaseSafetyError',
          reason: 'classification_lowered',
        });
      });

      it('is unknown without its schema', async () => {
        useEdges(employeeEdge());
        await expect(release(required(OID_ENTITLEMENT), employee)).rejects.toMatchObject(
          unknownSource
        );
      });
    });

    describe('classifications above personal data', () => {
      it.each(['key_material', 'secret', 'credential', 'token', 'regulated'])(
        'keep a %s source from a public or internal attribute',
        async (classification) => {
          mocks.binding = {
            ...productionBinding(),
            catalog: {
              ...productionBinding().catalog,
              entries: [
                ...seededCanonicalEntries(),
                {
                  id: 'field.canonical.vault',
                  namespace: 'authrim.canonical',
                  path: 'vault',
                  valueType: 'string',
                  cardinality: 'single',
                  classification,
                  targetType: 'custom',
                },
              ],
            },
            edges: [
              edgeFrom(
                {
                  namespace: 'authrim.profile',
                  path: 'vault',
                  catalogEntryId: 'field.canonical.vault',
                },
                OID_EDU_PERSON_ASSURANCE
              ),
            ],
          };
          await expect(
            release(required(OID_EDU_PERSON_ASSURANCE), { id: 'user-a', vault: 'x' } as never)
          ).rejects.toMatchObject({
            name: 'RuntimeIdentityMappingReleaseSafetyError',
            reason: 'classification_lowered',
          });
        }
      );
    });
  });

  it('returns a catalog an SP carries itself untouched', async () => {
    const own = {
      catalog: { identity: { id: 'c' }, entries: [] },
      edges: [],
    };
    const spConfig = productionSpConfig(undefined, { identityMapping: own });
    expect(await resolve(spConfig)).toBe(own);
    expect(mocks.resolveBinding).not.toHaveBeenCalled();
  });

  it('still refuses an SP whose set has no active binding', async () => {
    mocks.binding = null;
    await expect(resolve()).rejects.toMatchObject({ name: 'SAMLIdentityMappingRuntimeError' });
  });
});
