import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

// The database boundary only (the binding, the Destination Profile consent filter): the mapping
// engine runs for real, so a validation rule really fails a mapping that lacks its source.
const { resolveBinding } = vi.hoisted(() => ({ resolveBinding: vi.fn() }));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: resolveBinding,
  assertRuntimeIdentityMappingReleaseSafety: vi.fn(),
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: async (input: { claims: Record<string, unknown> }) =>
    input.claims,
  loadDestinationProfileConsentDescriptor: vi.fn(async () => null),
}));

import { applyOIDCIdentityMapping, deriveOIDCSubject } from '../oidc-identity-mapping';

const adapter = {} as DatabaseAdapter;
const entry = (id: string, path: string) => ({
  id,
  namespace: 'oidc.claim',
  path,
  valueType: 'string',
  cardinality: 'single',
  classification: 'pii',
  targetType: 'destination-only',
});

/** A mapping with no edge at all: only a rule that preferred_username must be present. */
const validationOnlyBinding = {
  id: 'binding-1',
  tenantId: 'tenant-a',
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  mappingSnapshotHash: 'hash-1',
  catalog: {
    identity: {
      id: 'test.catalog',
      version: '1',
      contentHash: 'test-catalog',
      compatibilityRange: '^0.2.0',
    },
    entries: [entry('field.oidc.preferred_username', 'preferred_username')],
  },
  edges: [],
  transforms: [],
  validationRules: [
    {
      id: 'rule-username-required',
      kind: 'required',
      targetRef: { side: 'source', namespace: 'oidc.claim', path: 'preferred_username' },
      defaultSeverity: 'critical',
    },
  ],
  fieldMappingSet: {},
  activationScope: {},
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'profile-1',
  destinationProfileIds: ['profile-1'],
};

describe('a mapping whose only source reference is a validation rule', () => {
  beforeEach(() => {
    resolveBinding.mockResolvedValue(validationOnlyBinding);
  });

  const apply = (
    claims: Record<string, unknown>,
    sourceAttributes?: Record<string, unknown> | (() => Promise<Record<string, unknown> | null>)
  ) =>
    applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims,
      ...(sourceAttributes ? { sourceAttributes } : {}),
    });

  it('passes whatever the response carries, because the user attributes are its source', async () => {
    const attributes = { preferred_username: 'alice' };

    // The claims of an ID-only response carry the attribute, those of a code exchange do not, and
    // an attribute loader or record supplies it either way.
    await expect(
      apply({ sub: 'u', preferred_username: 'alice' }, attributes)
    ).resolves.toMatchObject({
      claims: { sub: 'u' },
    });
    await expect(apply({ sub: 'u' }, attributes)).resolves.toMatchObject({ claims: { sub: 'u' } });
    await expect(apply({ sub: 'u' }, async () => attributes)).resolves.toMatchObject({
      claims: { sub: 'u' },
    });
  });

  it('fails in the same way for a user who has no such attribute, whatever the response carries', async () => {
    await expect(apply({ sub: 'u' }, {})).rejects.toMatchObject({
      details: { code: 'policy.identity_mapping_failed' },
    });
    await expect(apply({ sub: 'u' }, async () => null)).rejects.toMatchObject({
      details: { code: 'policy.identity_mapping_failed' },
    });
  });

  it('derives the subject the same way', async () => {
    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'u' },
        sourceAttributes: { preferred_username: 'alice' },
      })
    ).resolves.toBe('u');
  });
});
