import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mapping: undefined as Record<string, unknown> | undefined,
  targetedIdMade: 0,
}));
vi.mock('../runtime-identity-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime-identity-mapping')>()),
  resolveSAMLRuntimeIdentityMapping: async () => state.mapping,
}));
vi.mock('../subject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../subject')>()),
  resolveSAMLPairwiseSecretForRef: async () => 'tenant-identifier-salt',
  resolveSAMLPairwiseSecret: async () => 'tenant-pairwise-salt',
  // The old transform's identifier, which writes the NameID registry.
  resolveSAMLEduPersonTargetedIDOpaque: async () => {
    state.targetedIdMade++;
    return 'old-opaque';
  },
}));

import { computeIdentifier } from '@authrim/ar-lib-core';
import { computeSAMLAttributeRelease, resolveSAMLMappedNameID } from '../release-items';

const SP = 'https://sp.example.org/shibboleth';
const IDP = 'https://idp.example.org';
const uid = { side: 'source', namespace: 'authrim.system', path: 'uid' };
const nameid = { side: 'destination', namespace: 'saml.nameid', path: 'persistent' };
const step = (parameters: Record<string, unknown>, id = 'step-nameid') => ({
  id,
  operation: 'persistent_identifier',
  inputEdgeIds: ['edge-uid'],
  parameters,
  outputTargetRef: nameid,
});
const mapping = (transforms: unknown[], extra: Record<string, unknown> = {}) => ({
  catalog: { entries: [] },
  edges: [],
  transforms: [],
  nameId: {
    edges: [{ id: 'edge-uid', sourceRef: uid, targetRef: nameid }],
    transforms,
    validationRules: [],
  },
  ...extra,
});
const resolve = () =>
  resolveSAMLMappedNameID({
    env: {} as never,
    tenantId: 'tenant-a',
    idpEntityId: IDP,
    spConfig: { entityId: SP } as never,
    userInfo: { id: 'user-a', email: 'a@example.test' },
  });

describe('a persistent NameID the mapping makes', () => {
  beforeEach(() => {
    state.mapping = undefined;
  });

  it('is none when the mapping makes no NameID', async () => {
    state.mapping = { catalog: { entries: [] }, edges: [], transforms: [] };
    await expect(resolve()).resolves.toBeUndefined();
  });

  it('is made from the account ID with the tenant salt', async () => {
    state.mapping = mapping([step({ format: 'plain', algorithm: 'shibboleth' })]);
    const make = await resolve();
    await expect(make?.()).resolves.toEqual({
      value: await computeIdentifier({
        algorithm: 'shibboleth',
        value: 'user-a',
        audience: SP,
        salt: new TextEncoder().encode('tenant-identifier-salt'),
      }),
      kept: false,
    });
  });

  it('refuses two steps, other formats, or the old eduPersonTargetedID beside it', async () => {
    for (const refused of [
      mapping([
        step({ format: 'plain', algorithm: 'shibboleth' }),
        step({ format: 'plain', algorithm: 'shibboleth' }, 'second'),
      ]),
      mapping([step({ format: 'saml_targeted_id', algorithm: 'shibboleth' })]),
      mapping([step({ format: 'plain', algorithm: 'shibboleth' })], {
        transforms: [{ operation: 'saml_edu_person_targeted_id' }],
      }),
    ]) {
      state.mapping = refused;
      // Refused as soon as it is asked for: before any registry is read.
      await expect(resolve()).rejects.toThrow('persistent_identifier_unavailable');
    }
  });

  it('refuses when the mapping checks on its input fail', async () => {
    state.mapping = mapping([step({ format: 'plain', algorithm: 'shibboleth' })]);
    (state.mapping.nameId as { validationRules: unknown[] }).validationRules = [
      {
        id: 'rule',
        kind: 'required',
        targetRef: { ...uid, path: 'employee_number' },
        defaultSeverity: 'critical',
      },
    ];
    const make = await resolve();
    await expect(make?.()).rejects.toThrow('persistent_identifier_unavailable');
  });

  it('refuses the release itself, before the old transform writes the NameID registry', async () => {
    state.targetedIdMade = 0;
    state.mapping = mapping([step({ format: 'plain', algorithm: 'shibboleth' })], {
      transforms: [{ id: 'old', operation: 'saml_edu_person_targeted_id', inputEdgeIds: [] }],
    });
    for (const identifiers of ['deferred', 'made'] as const) {
      await expect(
        computeSAMLAttributeRelease({
          env: {} as never,
          tenantId: 'tenant-a',
          idpEntityId: IDP,
          spConfig: { entityId: SP } as never,
          userInfo: { id: 'user-a', email: 'a@example.test' },
          userId: 'user-a',
          requestScope: {},
          identifiers,
          onError: () => undefined,
        })
      ).rejects.toThrow('persistent_identifier_unavailable');
    }
    expect(state.targetedIdMade).toBe(0);
  });
});
