import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mapping: undefined as Record<string, unknown> | undefined,
  exceptionRows: [] as Array<Record<string, unknown>>,
  exceptionsFail: false,
  institutionSettings: new Map<string, unknown>(),
  settingsReads: 0,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveEffectiveSettings: async () => {
    state.settingsReads += 1;
    return Object.fromEntries(state.institutionSettings);
  },
  // The Admin database: only the exceptions are read here.
  requireAdminDatabaseAdapter: () => ({
    query: async (sql: string) => {
      if (!sql.includes('mapped_identifier_exceptions')) return [];
      if (state.exceptionsFail) throw new Error('admin database down');
      return state.exceptionRows;
    },
    queryOne: async () => null,
  }),
}));
vi.mock('../runtime-identity-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime-identity-mapping')>()),
  resolveSAMLRuntimeIdentityMapping: async () => state.mapping,
}));
vi.mock('../subject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../subject')>()),
  resolveSAMLPairwiseSecretForRef: async () => 'tenant-identifier-salt',
}));

import { computeIdentifier } from '@authrim/ar-lib-core';
import { resolveSAMLMappedNameID } from '../release-items';

const SP = 'https://sp.example.org/shibboleth';
const IDP = 'https://idp.example.org';
const uid = { side: 'source', namespace: 'authrim.system', path: 'uid' };
const nameid = { side: 'destination', namespace: 'saml.nameid', path: 'persistent' };
const step = (parameters: Record<string, unknown>, id = 'step-nameid') => ({
  id,
  operation: 'persistent_identifier',
  // No input edge: made from the account ID, which the runtime supplies.
  inputEdgeIds: [],
  parameters: { input: 'account', ...parameters },
  outputTargetRef: nameid,
});
const mapping = (transforms: unknown[], extra: Record<string, unknown> = {}) => ({
  catalog: { entries: [] },
  edges: [],
  transforms: [],
  nameId: withExplicitMappingGraphs({
    edges: [],
    transforms,
    validationRules: [],
  }),
  ...extra,
});
const keyManager = (salts: Record<string, string> = {}) => ({
  idFromName: (name: string) => name,
  get: () => ({
    getExistingSecretRpc: async (ref: string) => {
      const name = ref.replace('identifier-salt:import:', '');
      return ref.startsWith('identifier-salt:import:') && salts[name]
        ? { active: { value: btoa(salts[name]) } }
        : null;
    },
  }),
});
const resolve = (salts: Record<string, string> = {}) =>
  resolveSAMLMappedNameID({
    env: { KEY_MANAGER: keyManager(salts) } as never,
    tenantId: 'tenant-a',
    idpEntityId: IDP,
    spConfig: { entityId: SP } as never,
    userInfo: { id: 'user-a', email: 'a@example.test' },
  });

describe('a persistent NameID the mapping makes', () => {
  beforeEach(() => {
    state.mapping = undefined;
    state.exceptionRows = [];
    state.exceptionsFail = false;
    state.institutionSettings.clear();
    state.settingsReads = 0;
  });

  it('enriches a plain NameID copy from institution settings only after approval', async () => {
    state.institutionSettings.set('institution.scopes', 'example.ac.jp');
    const sourceRef = {
      side: 'source',
      namespace: 'authrim.profile',
      path: 'schac_home_organization',
    };
    state.mapping = mapping([], {
      catalog: {
        identity: {
          id: 'institution',
          version: '1',
          contentHash: 'institution',
          compatibilityRange: '*',
        },
        entries: [
          {
            id: 'institution.home',
            namespace: sourceRef.namespace,
            path: sourceRef.path,
            valueType: 'string',
            cardinality: 'single',
            classification: 'internal',
          },
          {
            id: 'destination.nameid',
            namespace: nameid.namespace,
            path: nameid.path,
            valueType: 'string',
            cardinality: 'single',
            classification: 'internal',
            targetType: 'destination-only',
          },
        ],
      },
      nameId: withExplicitMappingGraphs({
        edges: [{ id: 'copy-institution', sourceRef, targetRef: nameid }],
        transforms: [],
        validationRules: [],
      }),
    });
    const make = await resolve();
    expect(state.settingsReads).toBe(0);
    await expect(make?.()).resolves.toEqual({ value: 'example.ac.jp', kept: false });
    expect(state.settingsReads).toBeGreaterThan(0);
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

  it('refuses two steps or other formats', async () => {
    for (const refused of [
      mapping([
        step({ format: 'plain', algorithm: 'shibboleth' }),
        step({ format: 'plain', algorithm: 'shibboleth' }, 'second'),
      ]),
      mapping([step({ format: 'saml_targeted_id', algorithm: 'shibboleth' })]),
    ]) {
      state.mapping = refused;
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

  describe('with a list of exceptions', () => {
    const withList = () =>
      mapping([step({ format: 'plain', algorithm: 'shibboleth', exceptions: 'list-a' })]);
    const nameIdWith = (salt: string) =>
      computeIdentifier({
        algorithm: 'shibboleth',
        value: 'user-a',
        audience: SP,
        salt: new TextEncoder().encode(salt),
      });

    it('is made with the salt an exception names (the recipient is the SP’s entity ID)', async () => {
      state.mapping = withList();
      state.exceptionRows = [
        { account_id: 'user-a', audience: SP, action: 'salt', salt_name: 'old-idp' },
      ];
      const make = await resolve({ 'old-idp': 'override-salt' });
      await expect(make?.()).resolves.toEqual({
        value: await nameIdWith('override-salt'),
        kept: false,
      });
    });

    it('is the default one when nothing applies', async () => {
      state.mapping = withList();
      state.exceptionRows = [
        { account_id: 'user-b', audience: SP, action: 'block', salt_name: null },
      ];
      const make = await resolve();
      await expect(make?.()).resolves.toEqual({
        value: await nameIdWith('tenant-identifier-salt'),
        kept: false,
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ['a block (the NameID is required)', { action: 'block', salt_name: null }],
      ['an override salt that is not there', { action: 'salt', salt_name: 'gone' }],
    ])('is refused on %s', async (_name, entry) => {
      state.mapping = withList();
      state.exceptionRows = [{ account_id: '*', audience: '*', ...entry }];
      const make = await resolve();
      await expect(make?.()).rejects.toThrow(
        entry.action === 'block' ? 'identifier_suppressed' : 'persistent_identifier_unavailable'
      );
    });

    it('is refused (not suppressed) when the exceptions cannot be read', async () => {
      state.mapping = withList();
      state.exceptionsFail = true;
      const make = await resolve();
      await expect(make?.()).rejects.toThrow('persistent_identifier_unavailable');
    });
  });
});
