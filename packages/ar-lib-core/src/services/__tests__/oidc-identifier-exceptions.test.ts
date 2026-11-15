import { withExplicitMappingGraphs } from './mapping-graph-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { computeIdentifier } from '../identifier-algorithms';

// The database boundary only: the mapping engine and the identifier preparation run for real.
const { resolveBinding } = vi.hoisted(() => ({ resolveBinding: vi.fn() }));
vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: vi.fn(),
  assertRuntimeIdentityMappingReleaseSafety: vi.fn(),
}));
vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: async () => ({
    selection: { kind: 'bound', tier: 'tenant_default', setId: 'set-1', chain: [] },
    binding: withExplicitMappingGraphs(await resolveBinding()),
  }),
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: async (input: { claims: Record<string, unknown> }) =>
    input.claims,
  loadDestinationProfileConsentDescriptor: vi.fn(async () => null),
}));

import { applyOIDCIdentityMapping, deriveOIDCSubject } from '../oidc-identity-mapping';

const adapter = {} as DatabaseAdapter;
/** The rows of the exceptions the test sets (the whole table: the SQL filter is not run). */
let exceptionRows: Array<{
  account_id: string;
  audience: string;
  action: string;
  salt_name: string | null;
}> = [];
let exceptionsFail = false;
const adminAdapter = {
  query: vi.fn(async (sql: string) => {
    if (!sql.includes('mapped_identifier_exceptions')) return [];
    if (exceptionsFail) throw new Error('admin database down');
    return exceptionRows;
  }),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
} as unknown as DatabaseAdapter;
const subRef = (side: 'source' | 'destination') => ({ side, namespace: 'oidc.claim', path: 'sub' });

/** A persistent identifier written to sub, as the console saves "make a persistent identifier". */
function binding(parameters: Record<string, unknown>) {
  return {
    id: 'binding-1',
    tenantId: 'tenant-a',
    fieldMappingSetId: 'set-1',
    fieldMappingVersionId: 'version-1',
    mappingSnapshotHash: 'hash-1',
    catalog: {
      identity: { id: 'c', version: '1', contentHash: 'c', compatibilityRange: '^0.2.0' },
      entries: [
        {
          id: 'field.oidc.sub',
          namespace: 'oidc.claim',
          path: 'sub',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
          targetType: 'destination-only',
        },
      ],
    },
    // The step takes no input edge: it is made from the account ID the runtime supplies.
    edges: [],
    transforms: [
      {
        id: 'step-pairwise',
        operation: 'persistent_identifier',
        inputEdgeIds: [],
        parameters,
        outputTargetRef: subRef('destination'),
      },
    ],
    validationRules: [],
    fieldMappingSet: {},
    activationScope: {},
    destinationNamespace: 'oidc.claim',
    destinationProfileId: 'profile-1',
    destinationProfileIds: ['profile-1'],
  };
}

const secretReads: string[] = [];
const keyManager = {
  idFromName: (name: string) => name,
  get: () => ({
    getOrCreateSecretRpc: async (ref: string) => {
      secretReads.push(ref);
      return { active: { value: 'tenant-salt' } };
    },
  }),
};

const input = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  subjectType: 'public' as const,
  adapter,
  env: { DB_ADMIN: adminAdapter as never, ...env },
  tenantId: 'tenant-a',
  clientId: 'client-a',
  claims: { sub: 'usr_1', email: 'a@example.test' },
  ...extra,
});

const claimRef = (path: string) => ({ side: 'destination', namespace: 'oidc.claim', path });
const entry = (path: string) => ({
  id: `field.oidc.${path}`,
  namespace: 'oidc.claim',
  path,
  valueType: 'string',
  cardinality: 'single',
  classification: 'internal',
  targetType: 'destination-only',
});
const row = (
  account_id: string,
  audience: string,
  action: 'salt' | 'block',
  salt_name: string | null = null
) => ({ account_id, audience, action, salt_name });

/** A sector-audience step writing `path`, reading the list `list-a`. */
function stepInto(path: string) {
  const mapping = binding({
    ...{ input: 'account', format: 'plain', algorithm: 'authrim_sha256', audience: 'sector' },
    exceptions: 'list-a',
  });
  mapping.transforms[0].outputTargetRef = claimRef(path) as never;
  if (path !== 'sub') mapping.catalog.entries.push(entry(path));
  return mapping;
}
const REDIRECTS = ['https://app.example/cb'];
const run = (extra: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) =>
  applyOIDCIdentityMapping(
    input(
      { KEY_MANAGER: keyManager },
      { redirectUris: REDIRECTS, claims: { sub: 'usr_1', ...claims }, ...extra }
    )
  );
const expectedFor = (salt: string) =>
  computeIdentifier({
    algorithm: 'authrim_sha256',
    value: 'usr_1',
    audience: 'app.example',
    salt: new TextEncoder().encode(salt),
  });

describe('exceptions to a persistent_identifier step (OIDC)', () => {
  beforeEach(() => {
    secretReads.length = 0;
    exceptionRows = [];
    exceptionsFail = false;
    resolveBinding.mockResolvedValue(stepInto('sub'));
  });

  it('makes the sub as usual when no exception applies', async () => {
    exceptionRows = [row('usr_2', 'app.example', 'block')];
    expect((await run()).claims.sub).toBe(await expectedFor('tenant-salt'));
  });

  it('makes it with the override salt of the account’s entry', async () => {
    exceptionRows = [row('usr_1', 'app.example', 'salt', 'old-idp')];
    const keys = {
      ...keyManager,
      get: () => ({
        getOrCreateSecretRpc: async () => ({ active: { value: 'tenant-salt' } }),
        getExistingSecretRpc: async (ref: string) =>
          ref === 'identifier-salt:import:old-idp' ? { active: { value: btoa('override') } } : null,
      }),
    };
    const mapped = await applyOIDCIdentityMapping(
      input({ KEY_MANAGER: keys }, { redirectUris: REDIRECTS })
    );
    expect(mapped.claims.sub).toBe(await expectedFor('override'));
  });

  it('fails when the override salt is not there (never the default salt, never suppressed)', async () => {
    exceptionRows = [row('usr_1', 'app.example', 'salt', 'gone')];
    await expect(run()).rejects.toMatchObject({
      details: { code: 'policy.persistent_identifier_unavailable' },
    });
  });

  it('fails the mapping when the sub is blocked (the sub is required), for the claims and the subject alone', async () => {
    exceptionRows = [row('*', '*', 'block')];
    const failure = { details: { code: 'policy.persistent_identifier_unavailable' } };
    await expect(run()).rejects.toMatchObject(failure);
    await expect(
      deriveOIDCSubject(input({ KEY_MANAGER: keyManager }, { redirectUris: REDIRECTS }))
    ).rejects.toMatchObject(failure);
    // A pairwise app whose sector step is blocked fails too: never the built-in value.
    await expect(run({ subjectType: 'pairwise' })).rejects.toMatchObject(failure);
  });

  it('fails when the exceptions cannot be read (never a suppression)', async () => {
    exceptionsFail = true;
    await expect(run()).rejects.toMatchObject({
      details: { code: 'policy.persistent_identifier_unavailable' },
    });
  });

  it('leaves an optional target out when blocked, even one the request began with', async () => {
    resolveBinding.mockResolvedValue(stepInto('employee_number'));
    exceptionRows = [row('usr_1', 'app.example', 'block')];
    const { claims } = await run({}, { employee_number: 'from-the-request' });
    expect(claims.sub).toBe('usr_1');
    expect(claims).not.toHaveProperty('employee_number');
    // Not blocked for another account: made.
    exceptionRows = [row('usr_2', 'app.example', 'block')];
    expect((await run()).claims.employee_number).toBe(await expectedFor('tenant-salt'));
  });

  it('fails a Destination Profile that requires a blocked target', async () => {
    resolveBinding.mockResolvedValue(stepInto('employee_number'));
    exceptionRows = [row('usr_1', 'app.example', 'block')];
    const { claims } = await run();
    // The real filter (the module is mocked above for the engine).
    const { filterOidcClaimsByDestinationConsent } = await vi.importActual<
      typeof import('../destination-profile-consent')
    >('../destination-profile-consent');
    const adapter = (row: unknown) =>
      ({ queryOne: vi.fn().mockResolvedValue(row), query: vi.fn() }) as unknown as DatabaseAdapter;
    await expect(
      filterOidcClaimsByDestinationConsent({
        coreAdapter: adapter(null),
        adminAdapter: adapter({
          profile_id: 'profile_oidc',
          destination_type: 'oidc',
          version_id: 'version_1',
          schema_json: JSON.stringify({
            claims: [
              { claimName: 'sub', required: true },
              { claimName: 'employee_number', required: true },
            ],
          }),
        }),
        tenantId: 'tenant-a',
        subjectId: 'usr_1',
        clientId: 'client-a',
        profileId: 'profile_oidc',
        claims,
      })
    ).rejects.toMatchObject({ code: 'required_field_missing' });
  });
});
