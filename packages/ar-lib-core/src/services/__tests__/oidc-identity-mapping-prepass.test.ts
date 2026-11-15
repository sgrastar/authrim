import { describe, expect, it, vi } from 'vitest';
import { TEST_CATALOG } from '@authrim/ar-lib-field-mapping/test-support';
import type { FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '../../db/adapter';
import type { RuntimeIdentityMappingBinding } from '../identity-mapping-runtime-resolver';

const { resolveBinding, prepareIdentifiers } = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  prepareIdentifiers: vi.fn(),
}));

vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: resolveBinding,
}));
vi.mock('../mapped-identifiers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mapped-identifiers')>()),
  prepareMappedIdentifiers: prepareIdentifiers,
}));
vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: () => adapter,
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  loadDestinationProfileConsentDescriptor: async () => null,
}));

import { applyOIDCIdentityMapping } from '../oidc-identity-mapping';

function unexpectedDatabaseRead(): never {
  throw new Error('No database access is needed for this identifier pre-pass');
}
const adapter: DatabaseAdapter = {
  query: unexpectedDatabaseRead,
  queryOne: unexpectedDatabaseRead,
  execute: unexpectedDatabaseRead,
  transaction: unexpectedDatabaseRead,
  batch: unexpectedDatabaseRead,
  isHealthy: unexpectedDatabaseRead,
  getType: () => 'mock',
  close: async () => {},
};
const targetRef: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };

function bindingWithIdentifier(graph: boolean): RuntimeIdentityMappingBinding {
  const binding: RuntimeIdentityMappingBinding = {
    id: 'binding',
    tenantId: 'tenant',
    fieldMappingSetId: 'set',
    fieldMappingVersionId: 'version',
    mappingSnapshotHash: 'hash',
    catalog: {
      ...TEST_CATALOG,
      entries: [
        {
          ...TEST_CATALOG.entries[1],
          id: 'sub',
          namespace: 'oidc.claim',
          path: 'sub',
        },
      ],
    },
    edges: [],
    transforms: [],
    validationRules: [],
    fieldMappingSet: {},
    activationScope: {},
    destinationProfileId: 'profile',
    destinationProfileIds: ['profile'],
  };
  replaceIdentifier(binding, graph, 'authrim_sha256');
  return binding;
}

function replaceIdentifier(
  binding: RuntimeIdentityMappingBinding,
  graph: boolean,
  algorithm: string
) {
  const step = {
    id: 'identifier',
    operation: 'persistent_identifier',
    parameters: { input: 'account', format: 'plain', algorithm },
  };
  if (graph) {
    binding.graphRules = [
      {
        id: 'rule',
        targetRef,
        edges: [],
        transforms: [{ ...step, operation: 'persistent_identifier', inputs: [] }],
        output: { stepIndex: 0 },
      },
    ];
  } else {
    binding.transforms = [
      { ...step, operation: 'persistent_identifier', inputEdgeIds: [], outputTargetRef: targetRef },
    ];
  }
}

describe('OIDC validation after the asynchronous identifier pre-pass', () => {
  it.each([
    { graph: false, subjectOnly: false },
    { graph: false, subjectOnly: true },
    { graph: true, subjectOnly: false },
    { graph: true, subjectOnly: true },
  ])('refuses replaced invalid settings ($graph/$subjectOnly)', async ({ graph, subjectOnly }) => {
    const binding = bindingWithIdentifier(graph);
    resolveBinding.mockResolvedValue({ selection: { kind: 'bound' }, binding });
    prepareIdentifiers.mockImplementationOnce(async () => {
      await Promise.resolve();
      replaceIdentifier(binding, graph, 'no_such_algorithm');
      return { identifiers: { identifier: 'prepared' }, suppressed: {}, failures: {}, kept: {} };
    });
    await expect(
      applyOIDCIdentityMapping({
        adapter,
        env: {},
        tenantId: 'tenant',
        clientId: 'client',
        subjectType: 'public',
        subjectOnly,
        claims: { sub: 'account-stand-in' },
      })
    ).rejects.toMatchObject({ details: { code: 'policy.persistent_identifier_unavailable' } });
  });
});
