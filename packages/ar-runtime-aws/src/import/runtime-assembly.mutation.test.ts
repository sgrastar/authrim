/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLookupBlindIndex,
  generateVersion,
  passkeyCredentialLookupSubject,
  validateAccountRouteProjection,
} from '@authrim/ar-lib-core';
import { SAML_DR_RUNTIME_STATE_DATASET } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';

const mocks = vi.hoisted(() => ({
  data: Object.create(null) as Record<string, unknown[]>,
  readCalls: [] as string[],
  createTenant: vi.fn(),
  validateBundle: vi.fn(),
  decodeKeyManager: vi.fn(),
  compileRelease: vi.fn(),
  createAdmin: vi.fn(),
  adminClose: vi.fn(),
  readEmbedded: vi.fn(),
  buildSupplement: vi.fn(),
}));

vi.mock('./verified-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verified-rows')>();
  return {
    ...actual,
    readVerifiedRows: async (_backup: unknown, id: string) => {
      mocks.readCalls.push(id);
      return structuredClone(mocks.data[id] ?? []);
    },
  };
});
vi.mock('../bootstrap', () => ({ createAwsSamlTenant: mocks.createTenant }));
vi.mock('../../../ar-saml/src/admin/local-signing-dr-bundle', () => ({
  validateSAMLLocalSigningSecretDRBundle: mocks.validateBundle,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset', () => ({
  decodeKeyManagerTenantBackupRow: mocks.decodeKeyManager,
}));
vi.mock('../../../ar-saml/src/idp/runtime-identity-mapping', () => ({
  compileSAMLImportedSPRelease: mocks.compileRelease,
}));
vi.mock('./snapshot-admin-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshot-admin-db')>();
  return { ...actual, createSnapshotAdminAdapter: mocks.createAdmin };
});
vi.mock('./supplement-collector', () => ({
  readEmbeddedSamlDrCapture: mocks.readEmbedded,
  buildAwsSamlSupplementFromFrozenCapture: mocks.buildSupplement,
}));

import {
  assembleAwsSamlTenantFromBackup,
  assertCompleteDatasetCoverage,
  assertSourceSAMLSigningPolicy,
  verifyRestoredSourceLoginUi,
} from './runtime-assembly';
import { SNAPSHOT_ADMIN_MAPPING_TABLES } from './snapshot-admin-db';
import type { AssembleAwsSamlTenantInput } from './runtime-assembly-input';

const INVALID = 'aws_runtime_assembly_invalid';
const TENANT = 'tenant-a';
const ISSUER = 'https://tenant-a.example.test';
const NOW = 1_700_000_000_000;
const SHA = 'c'.repeat(64);

const cell = (v: string | number | null) =>
  v === null
    ? (['null', null] as const)
    : typeof v === 'number'
      ? (['integer', String(v)] as const)
      : (['text', v] as const);
const row = (values: Record<string, string | number | null>): PortableSqliteRow =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, cell(v)]));

const route = (core = 'CORE_1', pii = 'PII_1', generation = 3) => ({
  schemaVersion: 1,
  accountRouteGeneration: generation,
  residencyPolicyId: 'default',
  targets: [
    {
      dataRole: 'tenant_core/users',
      residencyPartition: 'global',
      shardId: 'core-1',
      bindingRef: core,
      requiredBindingRouteGeneration: 2,
    },
    {
      dataRole: 'tenant_pii',
      residencyPartition: 'global',
      shardId: 'pii-1',
      bindingRef: pii,
      requiredBindingRouteGeneration: 5,
    },
  ],
});
const settingDoc = (doc: Record<string, unknown>) => ({
  document_json: JSON.stringify(doc),
  version: generateVersion(doc),
});

const signingBundle = () => ({
  settings: { entityIdStyle: 'metadata_url', interactiveLoginUrlPolicy: 'tenant_host', marker: 1 },
  generated: { issuerUrl: ISSUER, idpEntityId: `${ISSUER}/saml/idp/metadata` },
});
const disabledUi = {
  components: { loginUi: false, adminUi: false },
  ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
};
const externalUi = {
  components: { loginUi: false, adminUi: false },
  ui: {
    login: {
      mode: 'external',
      baseUrl: 'https://login.example.test',
      clientId: 'ext-login',
      paths: { login: '/login', reauth: '/reauth' },
    },
    admin: { mode: 'disabled' },
  },
};

function reset(data: Record<string, unknown[]> = {}) {
  mocks.data = data;
  mocks.readCalls.length = 0;
}

function baseData(): Record<string, unknown[]> {
  return {
    'admin.tenant_settings_documents': [],
    'federation.saml_local_signing_state': [
      row({ tenant_id: TENANT, bundle_json: JSON.stringify(signingBundle()) }),
    ],
    'credentials.key_manager_tenant_state': [row({ tenant_id: TENANT })],
    'core.identity_providers': [
      row({
        tenant_id: TENANT,
        provider_type: 'saml_sp',
        enabled: 1,
        config_json: JSON.stringify({ entityId: 'https://sp.example.test' }),
      }),
    ],
    'core.identity_accounts': [
      row({
        tenant_id: TENANT,
        id: 'account:u1',
        account_type: 'user',
        legacy_user_id: 'u1',
        lifecycle_state: 'active',
        directory_publication_state: 'active',
        account_route_generation: 3,
      }),
    ],
    'core.passkeys': [],
    'admin.field_mapping_sets': [
      row({ id: 'set-1', tenant_id: TENANT, lifecycle_state: 'active' }),
    ],
    'admin.field_catalog_versions': [row({ id: 'catv-1', catalog_id: 'cat-1' })],
    'admin.field_catalogs': [row({ id: 'cat-1', tenant_id: TENANT, lifecycle_state: 'active' })],
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  const queryOne = vi.fn();
  const core = {
    status: 'committed_staging',
    family: 'core',
    tenantId: TENANT,
    bundleId: 'b'.repeat(32),
    snapshotId: 'snap',
    inventoryDigestSha256: 'd'.repeat(64),
  };
  const input = {
    backup: {
      manifest: {
        formatVersion: 1,
        bundleId: 'b'.repeat(32),
        source: { tenantId: TENANT, issuer: ISSUER, productVersion: '1.0.0' },
        snapshotId: 'snap',
        boundaryUnixMs: NOW,
        inventoryDigestSha256: 'd'.repeat(64),
        selection: { settings: true, users: true, admin: false, artifacts: false, logs: {} },
        datasets: [],
      },
      dataset: (id: string) => ({ rows: (mocks.data[id] ?? []).length }),
    },
    supplement: {
      receipt: {
        tenantId: TENANT,
        issuer: ISSUER,
        productVersion: '1.0.0',
        bundleId: 'b'.repeat(32),
        snapshotId: 'snap',
        inventoryDigestSha256: 'd'.repeat(64),
        supplementSha256: SHA,
      },
      sourceLoginUi: { mode: 'disabled' },
      sourceFlowRuntimeEnabled: true,
      consentIpSalt: 'salt'.repeat(10),
      platformSettings: {},
      platformDestinationProfiles: { profiles: [{ p: 1 }], versions: [{ v: 1 }] },
      accountRoutes: { 'account:u1': route() },
      state: {
        receipt: {
          tenantId: TENANT,
          issuer: ISSUER,
          productVersion: '1.0.0',
          bundleId: 'b'.repeat(32),
          snapshotId: 'snap',
          inventoryDigestSha256: 'd'.repeat(64),
          supplementSha256: 'e'.repeat(64),
        },
      },
    },
    restored: {
      metadataCoreDb: { queryOne },
      accountCoreByBindingRef: { CORE_1: { name: 'core' } },
      accountPiiByBindingRef: { PII_1: { name: 'pii' } },
      stateDb: { name: 'state' },
      authenticationState: { name: 'auth' },
      committed: {
        core,
        pii: { ...core, family: 'pii' },
        state: {
          tenantId: TENANT,
          source: { tenantId: TENANT, issuer: ISSUER, productVersion: '1.0.0' },
          bundleId: 'b'.repeat(32),
          snapshotId: 'snap',
          inventoryDigestSha256: 'd'.repeat(64),
          supplementSha256: 'e'.repeat(64),
        },
      },
    },
    environmentName: 'env-1',
    destinationUi: structuredClone(disabledUi),
    spEntityIds: ['https://sp.example.test'],
    allocationScope: 'tenant_exclusive',
    auditPorts: { audit: true },
    awsFlowRuntimeHmacSecret: 'f'.repeat(32),
    awsLookupReadKeys: [{ generation: 1, secret: 'k'.repeat(32) }],
    assertSnapshotReady: vi.fn(async () => undefined),
    ...overrides,
  };
  return { input: input as unknown as AssembleAwsSamlTenantInput, raw: input as any, queryOne };
}

beforeEach(() => {
  vi.clearAllMocks();
  reset(baseData());
  mocks.createTenant.mockResolvedValue({ runtime: true });
  mocks.validateBundle.mockImplementation(() => undefined);
  mocks.decodeKeyManager.mockResolvedValue({ rsa: { secrets: {} } });
  mocks.adminClose.mockResolvedValue(undefined);
  mocks.createAdmin.mockReturnValue({ close: mocks.adminClose, kind: 'admin' });
  mocks.compileRelease.mockResolvedValue({
    sourceBindingRef: { fieldMappingSetId: 'set-1' },
    binding: { catalog: { identity: { id: 'catv-1' } } },
  });
});

// With pairwise fallback supplied (no source secret) the baseline assembles.
function withFallback(raw: any, value = 'p'.repeat(32)) {
  raw.supplement.sourcePairwiseFallbackSecret = value;
}

async function assemble(raw?: (r: any) => void, data?: (d: Record<string, unknown[]>) => void) {
  const d = baseData();
  data?.(d);
  reset(d);
  const made = makeInput();
  withFallback(made.raw);
  raw?.(made.raw);
  let started: Promise<unknown> | undefined;
  const out = { ...made } as typeof made & { result: Promise<any> };
  Object.defineProperty(out, 'result', {
    get() {
      started ??= assembleAwsSamlTenantFromBackup(made.input);
      return started;
    },
  });
  return out;
}
const rejects = async (raw?: (r: any) => void, data?: (d: Record<string, unknown[]>) => void) => {
  const made = await assemble(raw, data);
  await expect(made.result).rejects.toThrow(new Error(INVALID));
  return made;
};

describe('assembleAwsSamlTenantFromBackup', () => {
  it('assembles the tenant with every collaborator receiving the verified values', async () => {
    const made = await assemble();
    await expect(made.result).resolves.toEqual({ runtime: true });
    expect(mocks.createTenant).toHaveBeenCalledTimes(1);
    const arg = mocks.createTenant.mock.calls[0][0];
    expect(arg).toMatchObject({
      tenantId: TENANT,
      origin: ISSUER,
      environmentName: 'env-1',
      destinationUi: disabledUi,
      spEntityIds: ['https://sp.example.test'],
      consentIpSalt: 'salt'.repeat(10),
      flowRuntimeHmacSecret: 'f'.repeat(32),
      stateDb: { name: 'state' },
      authenticationState: { name: 'auth' },
      auditPorts: { audit: true },
      signingBundle: signingBundle(),
      identityMappings: [
        expect.objectContaining({ sourceBindingRef: { fieldMappingSetId: 'set-1' } }),
      ],
    });
    expect(arg.inventory).toMatchObject({
      tenantId: TENANT,
      allocationScope: 'tenant_exclusive',
      accountCoreByBindingRef: { CORE_1: { name: 'core' } },
      accountPiiByBindingRef: { PII_1: { name: 'pii' } },
      coreAccountRouteGenerations: { 'account:u1': 3 },
      lookupReadKeys: [{ generation: 1, secret: 'k'.repeat(32) }],
    });
    expect(arg.inventory.metadataCoreDb).toBe(made.raw.restored.metadataCoreDb);
    expect(arg.pairwiseSecret).toEqual({
      tenantId: TENANT,
      secretRef: `tenant:${TENANT}:saml:pairwise-nameid`,
      active: { kid: 'source-pairwise-env-fallback', value: 'p'.repeat(32), createdAt: NOW },
      updatedAt: NOW,
    });
    expect(made.raw.assertSnapshotReady).toHaveBeenCalledTimes(1);
    await arg.assertSnapshotReady();
    expect(made.raw.assertSnapshotReady).toHaveBeenCalledTimes(2);
    expect(mocks.compileRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        idpEntityId: `${ISSUER}/saml/idp/metadata`,
        spConfig: { entityId: 'https://sp.example.test' },
        coreAdapter: made.raw.restored.metadataCoreDb,
        adminAdapter: expect.objectContaining({ kind: 'admin' }),
      })
    );
    expect(mocks.adminClose).toHaveBeenCalledTimes(1);
    expect(mocks.validateBundle).toHaveBeenCalledWith(signingBundle(), TENANT);
    expect(mocks.createAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        platformRows: {
          destination_profiles: [{ p: 1 }],
          destination_profile_versions: [{ v: 1 }],
        },
        rows: expect.objectContaining(
          Object.fromEntries(SNAPSHOT_ADMIN_MAPPING_TABLES.map((t) => [t, expect.any(Array)]))
        ),
      })
    );
  });

  it('exposes the flow flag through configuration and nothing else', async () => {
    for (const enabled of [true, false]) {
      const made = await assemble((r) => {
        r.supplement.sourceFlowRuntimeEnabled = enabled;
        r.destinationUi = structuredClone(disabledUi);
      });
      await made.result;
      const config = mocks.createTenant.mock.calls.at(-1)![0].configuration;
      expect(await config.get('flag:ENABLE_LOGIN_RUNTIME_FLOW')).toBe(String(enabled));
      expect(await config.get('flag:OTHER')).toBeNull();
    }
  });

  it('runs readiness before reading any signing state', async () => {
    const order: string[] = [];
    const made = await assemble((r) => {
      r.assertSnapshotReady = vi.fn(async () => {
        order.push(`ready:${mocks.readCalls.length}`);
      });
    });
    await made.result;
    expect(order[0]).toBe('ready:0');
  });

  it('propagates a failing readiness probe', async () => {
    const made = await assemble((r) => {
      r.assertSnapshotReady = vi.fn(async () => {
        throw new Error('not ready');
      });
    });
    await expect(made.result).rejects.toThrow('not ready');
    expect(mocks.createTenant).not.toHaveBeenCalled();
  });

  describe('manifest and receipt agreement', () => {
    const cases: Array<[string, (r: any) => void]> = [
      ['selection without settings', (r) => (r.backup.manifest.selection.settings = false)],
      ['selection without users', (r) => (r.backup.manifest.selection.users = false)],
      ['missing receipt', (r) => (r.supplement.receipt = undefined)],
      ['receipt tenant', (r) => (r.supplement.receipt.tenantId = 'x')],
      ['receipt issuer', (r) => (r.supplement.receipt.issuer = 'https://x.test')],
      ['receipt product', (r) => (r.supplement.receipt.productVersion = '9')],
      ['receipt bundle', (r) => (r.supplement.receipt.bundleId = 'x')],
      ['receipt snapshot', (r) => (r.supplement.receipt.snapshotId = 'x')],
      ['receipt inventory', (r) => (r.supplement.receipt.inventoryDigestSha256 = 'x')],
      ['receipt sha not hex', (r) => (r.supplement.receipt.supplementSha256 = 'Z'.repeat(64))],
      ['receipt sha short', (r) => (r.supplement.receipt.supplementSha256 = 'c'.repeat(63))],
      ['receipt sha long', (r) => (r.supplement.receipt.supplementSha256 = 'c'.repeat(65))],
      ['flow flag not boolean', (r) => (r.supplement.sourceFlowRuntimeEnabled = 'yes')],
      ['core status', (r) => (r.restored.committed.core.status = 'committed')],
      ['core family', (r) => (r.restored.committed.core.family = 'pii')],
      ['core tenant', (r) => (r.restored.committed.core.tenantId = 'x')],
      ['core bundle', (r) => (r.restored.committed.core.bundleId = 'x')],
      ['core snapshot', (r) => (r.restored.committed.core.snapshotId = 'x')],
      ['core inventory', (r) => (r.restored.committed.core.inventoryDigestSha256 = 'x')],
      ['pii status', (r) => (r.restored.committed.pii.status = 'committed')],
      ['pii family', (r) => (r.restored.committed.pii.family = 'core')],
      ['pii tenant', (r) => (r.restored.committed.pii.tenantId = 'x')],
      ['pii bundle', (r) => (r.restored.committed.pii.bundleId = 'x')],
      ['pii snapshot', (r) => (r.restored.committed.pii.snapshotId = 'x')],
      ['pii inventory', (r) => (r.restored.committed.pii.inventoryDigestSha256 = 'x')],
      ['state tenant', (r) => (r.restored.committed.state.tenantId = 'x')],
      ['state source tenant', (r) => (r.restored.committed.state.source.tenantId = 'x')],
      ['state source issuer', (r) => (r.restored.committed.state.source.issuer = 'https://x.test')],
      ['state source product', (r) => (r.restored.committed.state.source.productVersion = '9')],
      ['state bundle', (r) => (r.restored.committed.state.bundleId = 'x')],
      ['state snapshot', (r) => (r.restored.committed.state.snapshotId = 'x')],
      ['state inventory', (r) => (r.restored.committed.state.inventoryDigestSha256 = 'x')],
      ['state supplement sha', (r) => (r.restored.committed.state.supplementSha256 = 'x')],
      ['supplement state tenant', (r) => (r.supplement.state.receipt.tenantId = 'x')],
      ['supplement state issuer', (r) => (r.supplement.state.receipt.issuer = 'https://x.test')],
      ['supplement state product', (r) => (r.supplement.state.receipt.productVersion = '9')],
      ['supplement state bundle', (r) => (r.supplement.state.receipt.bundleId = 'x')],
      ['supplement state snapshot', (r) => (r.supplement.state.receipt.snapshotId = 'x')],
      [
        'supplement state inventory',
        (r) => (r.supplement.state.receipt.inventoryDigestSha256 = 'x'),
      ],
      ['no SP entity ids', (r) => (r.spEntityIds = [])],
      ['duplicate SP entity ids', (r) => (r.spEntityIds = ['a', 'a'])],
      ['no lookup keys', (r) => (r.awsLookupReadKeys = [])],
      [
        'three lookup keys',
        (r) =>
          (r.awsLookupReadKeys = [1, 2, 3].map((g) => ({ generation: g, secret: 'k'.repeat(32) }))),
      ],
      ['short flow secret', (r) => (r.awsFlowRuntimeHmacSecret = 'f'.repeat(31))],
      ['no snapshot probe', (r) => (r.assertSnapshotReady = undefined)],
      [
        'flow disabled with embedded UI',
        (r) => {
          r.destinationUi = undefined;
          r.supplement.sourceFlowRuntimeEnabled = false;
        },
      ],
      [
        'flow disabled with external UI',
        (r) => {
          r.destinationUi = structuredClone(externalUi);
          r.supplement.sourceFlowRuntimeEnabled = false;
        },
      ],
    ];
    it.each(cases)('rejects %s', async (_name, mutate) => {
      await rejects(mutate);
      expect(mocks.createTenant).not.toHaveBeenCalled();
    });
    it('accepts a disabled flow with disabled UI, two lookup keys and exactly 32-char secret', async () => {
      const made = await assemble((r) => {
        r.supplement.sourceFlowRuntimeEnabled = false;
        r.awsLookupReadKeys = [1, 2].map((g) => ({ generation: g, secret: 'k'.repeat(32) }));
      });
      await expect(made.result).resolves.toBeDefined();
    });
  });

  describe('embedded capture', () => {
    const withEmbedded = (r: any) => {
      r.backup.manifest.datasets = [SAML_DR_RUNTIME_STATE_DATASET];
    };
    it('requires the supplement to equal the embedded capture', async () => {
      const made = await assemble(withEmbedded);
      const { receipt, ...payload } = made.raw.supplement;
      mocks.readEmbedded.mockResolvedValue({ capture: true });
      mocks.buildSupplement.mockResolvedValue({ receipt, payload });
      await expect(made.result).resolves.toBeDefined();
      expect(mocks.buildSupplement).toHaveBeenCalledWith({
        backup: made.raw.backup,
        capture: { capture: true },
      });
    });
    it('rejects a differing embedded receipt or payload', async () => {
      for (const mode of ['receipt', 'payload'] as const) {
        const made = await assemble(withEmbedded);
        const { receipt, ...payload } = made.raw.supplement;
        mocks.readEmbedded.mockResolvedValue({});
        mocks.buildSupplement.mockResolvedValue({
          receipt: mode === 'receipt' ? { ...receipt, snapshotId: 'other' } : receipt,
          payload: mode === 'payload' ? { ...payload, consentIpSalt: 'x'.repeat(40) } : payload,
        });
        await expect(made.result).rejects.toThrow(new Error(INVALID));
      }
    });
    it('does not read the embedded capture when the dataset is absent', async () => {
      const made = await assemble();
      await made.result;
      expect(mocks.readEmbedded).not.toHaveBeenCalled();
    });
  });

  describe('signing bundle', () => {
    it.each<[string, (d: Record<string, unknown[]>) => void]>([
      ['no row', (d) => (d['federation.saml_local_signing_state'] = [])],
      [
        'two rows',
        (d) =>
          (d['federation.saml_local_signing_state'] = [
            ...d['federation.saml_local_signing_state'],
            ...d['federation.saml_local_signing_state'],
          ]),
      ],
      [
        'extra column',
        (d) =>
          (d['federation.saml_local_signing_state'] = [
            row({ tenant_id: TENANT, bundle_json: '{}', extra: 'x' }),
          ]),
      ],
      [
        'other tenant',
        (d) =>
          (d['federation.saml_local_signing_state'] = [
            row({ tenant_id: 'x', bundle_json: JSON.stringify(signingBundle()) }),
          ]),
      ],
      [
        'invalid json',
        (d) =>
          (d['federation.saml_local_signing_state'] = [
            row({ tenant_id: TENANT, bundle_json: '{' }),
          ]),
      ],
      [
        'issuer mismatch',
        (d) =>
          (d['federation.saml_local_signing_state'] = [
            row({
              tenant_id: TENANT,
              bundle_json: JSON.stringify({
                ...signingBundle(),
                generated: {
                  issuerUrl: 'https://x.test',
                  idpEntityId: 'https://x.test/saml/idp/metadata',
                },
              }),
            }),
          ]),
      ],
    ])('rejects %s', async (_n, data) => {
      await rejects(undefined, data);
    });
    it('rejects a bundle the validator refuses', async () => {
      mocks.validateBundle.mockImplementation(() => {
        throw new Error('bad bundle');
      });
      await rejects();
    });
  });

  describe('source SAML signing policy', () => {
    const bundle = (policy: string, style = 'metadata_url', entity?: string) => ({
      settings: { interactiveLoginUrlPolicy: policy, entityIdStyle: style },
      generated: {
        issuerUrl: ISSUER,
        idpEntityId:
          entity ??
          (style === 'metadata_url' ? `${ISSUER}/saml/idp/metadata` : `${ISSUER}/saml/idp`),
      },
    });
    const check =
      (b: any, ui?: unknown, issuer = ISSUER) =>
      () =>
        assertSourceSAMLSigningPolicy(b, issuer, ui as never);
    it('requires ui_base_url for external, tenant_host for embedded and nothing for disabled', () => {
      expect(check(bundle('ui_base_url'), externalUi)).not.toThrow();
      expect(check(bundle('tenant_host'), externalUi)).toThrow(INVALID);
      expect(check(bundle('tenant_host'))).not.toThrow();
      expect(check(bundle('ui_base_url'))).toThrow(INVALID);
      expect(
        check(bundle('ui_base_url'), {
          ...disabledUi,
          ui: { ...disabledUi.ui, login: { mode: 'embedded-rehearsal' } },
        })
      ).toThrow(INVALID);
      expect(check(bundle('anything'), disabledUi)).not.toThrow();
    });
    it('derives the expected IdP entity id from the style', () => {
      expect(check(bundle('tenant_host', 'issuer_url'), undefined)).not.toThrow();
      expect(
        check(bundle('tenant_host', 'issuer_url', `${ISSUER}/saml/idp/metadata`), undefined)
      ).toThrow(INVALID);
      expect(check(bundle('tenant_host', 'metadata_url', `${ISSUER}/saml/idp`), undefined)).toThrow(
        INVALID
      );
    });
    it('rejects a different issuer URL', () => {
      expect(check(bundle('tenant_host'), undefined, 'https://other.example.test')).toThrow(
        INVALID
      );
    });
  });

  describe('settings', () => {
    const tenantRow = (
      category: string,
      doc: Record<string, unknown>,
      extra: Record<string, string> = {}
    ) =>
      row({
        tenant_id: TENANT,
        scope_type: 'tenant',
        scope_id: TENANT,
        category,
        ...settingDoc(doc),
        ...extra,
      });
    const read = async (data: (d: Record<string, unknown[]>) => void, raw?: (r: any) => void) => {
      const made = await assemble(raw, data);
      await made.result;
      return mocks.createTenant.mock.calls.at(-1)![0].settings as {
        get(key: string): Promise<string | null>;
      };
    };
    it('serves tenant, client and platform documents under their storage keys', async () => {
      const settings = await read(
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            tenantRow('login', { a: 1 }),
            row({
              tenant_id: TENANT,
              scope_type: 'client',
              scope_id: 'client-1',
              category: 'oidc',
              ...settingDoc({ c: 2 }),
            }),
          ]),
        (r) =>
          (r.supplement.platformSettings = {
            branding: { documentJson: '{"p":3}', version: generateVersion({ p: 3 }) },
          })
      );
      expect(await settings.get(`settings:tenant:${TENANT}:login`)).toBe('{"a":1}');
      expect(await settings.get(`settings:client:${TENANT}:client-1:oidc`)).toBe('{"c":2}');
      expect(await settings.get('settings:platform:branding')).toBe('{"p":3}');
      expect(await settings.get('settings:platform:missing')).toBeNull();
      expect(JSON.parse((await settings.get(`settings:tenant:${TENANT}:saml`))!)).toEqual(
        signingBundle().settings
      );
    });
    it('keeps an agreeing stored SAML document but replaces it with the bundle settings', async () => {
      const settings = await read(
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            tenantRow('saml', { entityIdStyle: 'metadata_url', unrelated: 'x' }),
          ])
      );
      expect(await settings.get(`settings:tenant:${TENANT}:saml`)).toBe(
        JSON.stringify(signingBundle().settings)
      );
    });
    it('rejects a stored SAML document that disagrees with the bundle', async () => {
      await rejects(
        undefined,
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            tenantRow('saml', { entityIdStyle: 'issuer_url' }),
          ])
      );
    });
    it('compares object-valued policy fields structurally', async () => {
      mocks.data = baseData();
      const bundle = {
        ...signingBundle(),
        settings: { ...signingBundle().settings, nested: { a: [1, 2] } },
      };
      await rejects(undefined, (d) => {
        d['federation.saml_local_signing_state'] = [
          row({ tenant_id: TENANT, bundle_json: JSON.stringify(bundle) }),
        ];
        d['admin.tenant_settings_documents'] = [tenantRow('saml', { nested: { a: [2, 1] } })];
      });
      const made = await assemble(undefined, (d) => {
        d['federation.saml_local_signing_state'] = [
          row({ tenant_id: TENANT, bundle_json: JSON.stringify(bundle) }),
        ];
        d['admin.tenant_settings_documents'] = [tenantRow('saml', { nested: { a: [1, 2] } })];
      });
      await expect(made.result).resolves.toBeDefined();
    });
    it.each<[string, (d: Record<string, unknown[]>) => void]>([
      [
        'other tenant row',
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            row({
              tenant_id: 'x',
              scope_type: 'tenant',
              scope_id: 'x',
              category: 'a',
              ...settingDoc({}),
            }),
          ]),
      ],
      [
        'unknown scope',
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            row({
              tenant_id: TENANT,
              scope_type: 'platform',
              scope_id: TENANT,
              category: 'a',
              ...settingDoc({}),
            }),
          ]),
      ],
      [
        'tenant scope for another tenant',
        (d) =>
          (d['admin.tenant_settings_documents'] = [
            row({
              tenant_id: TENANT,
              scope_type: 'tenant',
              scope_id: 'other',
              category: 'a',
              ...settingDoc({}),
            }),
          ]),
      ],
      [
        'duplicate document',
        (d) => (d['admin.tenant_settings_documents'] = [tenantRow('a', {}), tenantRow('a', {})]),
      ],
      [
        'version mismatch',
        (d) =>
          (d['admin.tenant_settings_documents'] = [tenantRow('a', {}, { version: 'sha256:0' })]),
      ],
      [
        'invalid json',
        (d) =>
          (d['admin.tenant_settings_documents'] = [tenantRow('a', {}, { document_json: '{' })]),
      ],
      [
        'null document',
        (d) =>
          (d['admin.tenant_settings_documents'] = [tenantRow('a', {}, { document_json: 'null' })]),
      ],
      [
        'array document',
        (d) =>
          (d['admin.tenant_settings_documents'] = [tenantRow('a', {}, { document_json: '[]' })]),
      ],
      [
        'scalar document',
        (d) =>
          (d['admin.tenant_settings_documents'] = [tenantRow('a', {}, { document_json: '5' })]),
      ],
    ])('rejects %s', async (_n, data) => {
      await rejects(undefined, data);
    });
    it.each<[string, (r: any) => void]>([
      [
        'bad platform category',
        (r) =>
          (r.supplement.platformSettings = {
            'a b': { documentJson: '{}', version: generateVersion({}) },
          }),
      ],
      [
        'empty platform category',
        (r) =>
          (r.supplement.platformSettings = {
            '': { documentJson: '{}', version: generateVersion({}) },
          }),
      ],
      [
        'long platform category',
        (r) =>
          (r.supplement.platformSettings = {
            ['a'.repeat(129)]: { documentJson: '{}', version: generateVersion({}) },
          }),
      ],
      [
        'bad platform version',
        (r) => (r.supplement.platformSettings = { a: { documentJson: '{}', version: 'x' } }),
      ],
    ])('rejects %s', async (_n, mutate) => {
      await rejects(mutate);
    });
    it('accepts a 128-char platform category', async () => {
      const category = 'a'.repeat(128);
      const made = await assemble(
        (r) =>
          (r.supplement.platformSettings = {
            [category]: { documentJson: '{}', version: generateVersion({}) },
          })
      );
      await expect(made.result).resolves.toBeDefined();
    });
  });

  describe('pairwise secret', () => {
    const secretRef = `tenant:${TENANT}:saml:pairwise-nameid`;
    const source = {
      secretRef,
      active: { kid: 'k1', value: 'v'.repeat(32), createdAt: 5 },
      updatedAt: 6,
    };
    it('uses the source secret and passes the row through the key manager decoder', async () => {
      mocks.decodeKeyManager.mockResolvedValue({ rsa: { secrets: { [secretRef]: source } } });
      const made = await assemble((r) => delete r.supplement.sourcePairwiseFallbackSecret);
      await made.result;
      expect(mocks.createTenant.mock.calls[0][0].pairwiseSecret).toEqual({
        tenantId: TENANT,
        ...source,
      });
      expect(mocks.decodeKeyManager).toHaveBeenCalledWith(
        JSON.stringify(row({ tenant_id: TENANT })),
        TENANT
      );
    });
    it('rejects both a source secret and a fallback', async () => {
      mocks.decodeKeyManager.mockResolvedValue({ rsa: { secrets: { [secretRef]: source } } });
      await rejects();
    });
    it('rejects a source secret with another reference', async () => {
      mocks.decodeKeyManager.mockResolvedValue({
        rsa: { secrets: { [secretRef]: { ...source, secretRef: 'x' } } },
      });
      await rejects((r) => delete r.supplement.sourcePairwiseFallbackSecret);
    });
    it('rejects missing, short or non-string fallbacks and wrong row counts', async () => {
      await rejects((r) => delete r.supplement.sourcePairwiseFallbackSecret);
      await rejects((r) => (r.supplement.sourcePairwiseFallbackSecret = 'p'.repeat(31)));
      await rejects((r) => (r.supplement.sourcePairwiseFallbackSecret = 5));
      await rejects(undefined, (d) => (d['credentials.key_manager_tenant_state'] = []));
      await rejects(
        undefined,
        (d) => (d['credentials.key_manager_tenant_state'] = [row({ a: 'x' }), row({ a: 'y' })])
      );
    });
    it('accepts a fallback of exactly 32 characters', async () => {
      const made = await assemble(
        (r) => (r.supplement.sourcePairwiseFallbackSecret = 'p'.repeat(32))
      );
      await expect(made.result).resolves.toBeDefined();
    });
  });

  describe('SP releases', () => {
    const idp = (config: unknown, extra: Record<string, string | number> = {}) =>
      row({
        tenant_id: TENANT,
        provider_type: 'saml_sp',
        enabled: 1,
        config_json: typeof config === 'string' ? config : JSON.stringify(config),
        ...extra,
      });
    it.each<[string, (d: Record<string, unknown[]>) => void]>([
      ['no matching provider', (d) => (d['core.identity_providers'] = [])],
      [
        'two matching providers',
        (d) =>
          (d['core.identity_providers'] = [
            idp({ entityId: 'https://sp.example.test' }),
            idp({ entityId: 'https://sp.example.test' }),
          ]),
      ],
      [
        'disabled provider',
        (d) =>
          (d['core.identity_providers'] = [
            idp({ entityId: 'https://sp.example.test' }, { enabled: 0 }),
          ]),
      ],
      ['provider config invalid json', (d) => (d['core.identity_providers'] = [idp('{')])],
      ['no field mapping set', (d) => (d['admin.field_mapping_sets'] = [])],
      [
        'set owned by other tenant',
        (d) =>
          (d['admin.field_mapping_sets'] = [
            row({ id: 'set-1', tenant_id: 'x', lifecycle_state: 'active' }),
          ]),
      ],
      [
        'inactive set',
        (d) =>
          (d['admin.field_mapping_sets'] = [
            row({ id: 'set-1', tenant_id: TENANT, lifecycle_state: 'archived' }),
          ]),
      ],
      [
        'duplicate set',
        (d) =>
          (d['admin.field_mapping_sets'] = [
            ...d['admin.field_mapping_sets'],
            ...d['admin.field_mapping_sets'],
          ]),
      ],
      ['catalog without row', (d) => (d['admin.field_catalogs'] = [])],
      [
        'catalog of other tenant',
        (d) =>
          (d['admin.field_catalogs'] = [
            row({ id: 'cat-1', tenant_id: 'x', lifecycle_state: 'active' }),
          ]),
      ],
      [
        'inactive catalog',
        (d) =>
          (d['admin.field_catalogs'] = [
            row({ id: 'cat-1', tenant_id: TENANT, lifecycle_state: 'archived' }),
          ]),
      ],
      [
        'duplicate catalog',
        (d) =>
          (d['admin.field_catalogs'] = [
            ...d['admin.field_catalogs'],
            ...d['admin.field_catalogs'],
          ]),
      ],
    ])('rejects %s and still closes the admin adapter', async (_n, data) => {
      await rejects(undefined, data);
      expect(mocks.adminClose).toHaveBeenCalledTimes(1);
    });
    it('skips providers of another tenant or type', async () => {
      const made = await assemble(undefined, (d) => {
        d['core.identity_providers'] = [
          idp({ entityId: 'https://sp.example.test' }),
          row({
            tenant_id: 'other',
            provider_type: 'saml_sp',
            enabled: 1,
            config_json: '{"entityId":"https://sp.example.test"}',
          }),
          row({
            tenant_id: TENANT,
            provider_type: 'oidc',
            enabled: 1,
            config_json: '{"entityId":"https://sp.example.test"}',
          }),
        ];
      });
      await expect(made.result).resolves.toBeDefined();
    });
    it('rejects a missing catalog identity', async () => {
      mocks.compileRelease.mockResolvedValue({
        sourceBindingRef: { fieldMappingSetId: 'set-1' },
        binding: {},
      });
      await rejects();
      mocks.compileRelease.mockResolvedValue({
        sourceBindingRef: { fieldMappingSetId: 'set-1' },
        binding: { catalog: { identity: { id: 5 } } },
      });
      await rejects();
    });
    it.each([
      ['system_default_canonical_catalog_schema_v1', true],
      ['system_default_canonical_catalog_schema_v12', true],
      ['system_default_canonical_catalog_schema_v', false],
      ['system_default_canonical_catalog_schema_vx', false],
      ['system_default_canonical_catalog_schema_v1x', false],
      ['xsystem_default_canonical_catalog_schema_v1', false],
      ['other', false],
    ])('handles unregistered catalog version %s', async (id, ok) => {
      mocks.compileRelease.mockResolvedValue({
        sourceBindingRef: { fieldMappingSetId: 'set-1' },
        binding: { catalog: { identity: { id } } },
      });
      const made = await assemble(undefined, (d) => (d['admin.field_catalog_versions'] = []));
      if (ok) await expect(made.result).resolves.toBeDefined();
      else await expect(made.result).rejects.toThrow(INVALID);
    });
    it('compiles one release per requested SP in order', async () => {
      mocks.compileRelease
        .mockResolvedValueOnce({
          sourceBindingRef: { fieldMappingSetId: 'set-1' },
          binding: { catalog: { identity: { id: 'catv-1' } } },
          n: 1,
        })
        .mockResolvedValueOnce({
          sourceBindingRef: { fieldMappingSetId: 'set-1' },
          binding: { catalog: { identity: { id: 'catv-1' } } },
          n: 2,
        });
      const made = await assemble(
        (r) => (r.spEntityIds = ['https://sp.example.test', 'https://sp2.example.test']),
        (d) =>
          (d['core.identity_providers'] = [
            idp({ entityId: 'https://sp.example.test' }),
            idp({ entityId: 'https://sp2.example.test' }),
          ])
      );
      await made.result;
      expect(mocks.createTenant.mock.calls[0][0].identityMappings.map((m: any) => m.n)).toEqual([
        1, 2,
      ]);
    });
  });

  describe('lookup rebuild', () => {
    const passkey = (values: Record<string, string | null> = {}) =>
      row({
        tenant_id: TENANT,
        credential_id: 'cred-1',
        user_id: 'u1',
        rp_id: 'tenant-a.example.test',
        ...values,
      });
    it('rejects route/account disagreements', async () => {
      await rejects((r) => (r.supplement.accountRoutes = {}));
      await rejects(
        (r) => (r.supplement.accountRoutes = { 'account:u1': route(), 'account:zzz': route() })
      );
      await rejects((r) => (r.supplement.accountRoutes = { 'account:u2': route() }));
      await rejects(
        (r) => (r.supplement.accountRoutes = { 'account:u1': route('CORE_1', 'PII_1', 4) })
      );
      const popped = await assemble((r) => r.supplement.accountRoutes['account:u1'].targets.pop());
      await expect(popped.result).rejects.toThrow();
      await expect(
        (
          await assemble(
            (r) =>
              (r.supplement.accountRoutes['account:u1'].targets[1].dataRole = 'tenant_core/users')
          )
        ).result
      ).rejects.toThrow();
      await expect(
        (
          await assemble(
            (r) => (r.supplement.accountRoutes['account:u1'].targets[0].dataRole = 'tenant_pii')
          )
        ).result
      ).rejects.toThrow();
      await rejects((r) => (r.supplement.accountRoutes['account:u1'] = route('UNKNOWN', 'PII_1')));
      await rejects((r) => (r.supplement.accountRoutes['account:u1'] = route('CORE_1', 'UNKNOWN')));
      await rejects((r) => (r.restored.accountCoreByBindingRef = {}));
      await rejects((r) => (r.restored.accountPiiByBindingRef = {}));
    });
    it('does not accept binding refs inherited from Object.prototype', async () => {
      await rejects((r) => (r.supplement.accountRoutes['account:u1'] = route('toString', 'PII_1')));
    });
    it('indexes account ids with every read key', async () => {
      const keys = [
        { generation: 1, secret: 'a'.repeat(32) },
        { generation: 2, secret: 'b'.repeat(32) },
      ];
      const made = await assemble((r) => (r.awsLookupReadKeys = keys));
      await made.result;
      const rows = mocks.createTenant.mock.calls[0][0].inventory.lookupRows;
      expect(rows).toHaveLength(2);
      for (const [i, key] of keys.entries()) {
        const index = await createLookupBlindIndex('account_id', 'account:u1', key);
        expect(rows[i]).toEqual({
          virtual_bucket: index.virtualBucket,
          index_kind: index.indexKind,
          normalization_version: index.normalizationVersion,
          hmac_key_generation: index.hmacKeyGeneration,
          identifier_blind_digest: index.digest,
          tenant_id: TENANT,
          account_id: 'account:u1',
          route_schema_version: 1,
          account_route_generation: 3,
          required_binding_route_generation: 5,
          residency_policy_id: 'default',
          route_projection_json: JSON.stringify(validateAccountRouteProjection(route() as never)),
          tenant_lifecycle_state: 'active',
          runtime_route_status: 'active',
          lifecycle_state: 'active',
        });
      }
    });
    it('adds passkey credentials enrolled for the destination RP host only', async () => {
      const made = await assemble(
        undefined,
        (d) =>
          (d['core.passkeys'] = [
            passkey(),
            passkey({ credential_id: 'cred-other-rp', rp_id: 'elsewhere.example.test' }),
            passkey({ credential_id: 'cred-null-rp', rp_id: null }),
            passkey({ credential_id: 'cred-no-account', user_id: 'ghost' }),
          ])
      );
      await made.result;
      const rows = mocks.createTenant.mock.calls[0][0].inventory.lookupRows;
      expect(rows).toHaveLength(2);
      const expected = await createLookupBlindIndex(
        'external_subject',
        passkeyCredentialLookupSubject({ rpId: 'tenant-a.example.test', credentialId: 'cred-1' }),
        { generation: 1, secret: 'k'.repeat(32) }
      );
      expect(rows[1]).toMatchObject({
        identifier_blind_digest: expected.digest,
        index_kind: 'external_subject',
        account_id: 'account:u1',
      });
    });
    it('uses the external UI host as RP id', async () => {
      const bundle = {
        ...signingBundle(),
        settings: { ...signingBundle().settings, interactiveLoginUrlPolicy: 'ui_base_url' },
      };
      const made = await assemble(
        (r) => {
          r.destinationUi = structuredClone(externalUi);
          r.supplement.sourceLoginUi = {
            client: row({
              tenant_id: TENANT,
              client_id: 'ext-login',
              application_type: 'web',
              client_secret_hash: null,
              logout_webhook_secret_encrypted: null,
              allowed_channels: '["browser"]',
            }),
            origins: [
              row({
                tenant_id: TENANT,
                client_id: 'ext-login',
                origin: 'https://login.example.test',
                handoff_allowed: 1,
                is_active: 1,
              }),
            ],
          };
          r.restored.metadataCoreDb.queryOne = vi.fn(async (sql: string) =>
            sql.includes('oauth_clients')
              ? {
                  tenant_id: TENANT,
                  client_id: 'ext-login',
                  application_type: 'web',
                  allowed_channels: '["browser"]',
                  client_secret_hash: null,
                  enabled: 1,
                }
              : {
                  tenant_id: TENANT,
                  client_id: 'ext-login',
                  origin: 'https://login.example.test',
                  handoff_allowed: 1,
                  is_active: 1,
                }
          );
        },
        (d) => {
          d['federation.saml_local_signing_state'] = [
            row({ tenant_id: TENANT, bundle_json: JSON.stringify(bundle) }),
          ];
          d['core.passkeys'] = [
            passkey({ rp_id: 'login.example.test' }),
            passkey({ credential_id: 'c2', rp_id: 'tenant-a.example.test' }),
          ];
        }
      );
      await made.result;
      const rows = mocks.createTenant.mock.calls[0][0].inventory.lookupRows;
      expect(rows).toHaveLength(2);
      const expected = await createLookupBlindIndex(
        'external_subject',
        passkeyCredentialLookupSubject({ rpId: 'login.example.test', credentialId: 'cred-1' }),
        { generation: 1, secret: 'k'.repeat(32) }
      );
      expect(rows[1].identifier_blind_digest).toBe(expected.digest);
    });
    it('rejects passkeys of another tenant, duplicate credentials, and missing lookup rows', async () => {
      await rejects(undefined, (d) => (d['core.passkeys'] = [passkey({ tenant_id: 'x' })]));
      await rejects(undefined, (d) => (d['core.passkeys'] = [passkey(), passkey()]));
      await rejects(undefined, (d) => (d['core.identity_accounts'] = []));
    });
  });
});

describe('assertCompleteDatasetCoverage', () => {
  const dataset = (over: Record<string, unknown>, rows: number) => ({
    id: 'x.y',
    module: 'm',
    kind: 'settings',
    store: 'kv',
    schemaVersion: 1,
    disposition: 'include',
    ...over,
    rows,
  });
  const backupOf = (items: ReturnType<typeof dataset>[]) =>
    ({
      manifest: { datasets: items.map(({ rows: _r, ...d }) => d) },
      dataset: vi.fn((id: string) => ({ rows: items.find((d) => d.id === id)?.rows ?? 0 })),
    }) as never;
  it('accepts empty unsupported datasets of every kind', () => {
    expect(() =>
      assertCompleteDatasetCoverage({
        backup: backupOf([
          dataset({ disposition: 'rebuild' }, 0),
          dataset({ id: 'integrations.other', store: 'kv' }, 0),
          dataset({ id: 'admin.other', store: 'database' }, 0),
        ]),
      })
    ).not.toThrow();
  });
  it('accepts every consumed dataset and core/pii database families with rows', () => {
    const consumed = [
      ['federation.saml_local_signing_state', 'durable_object'],
      ['credentials.key_manager_tenant_state', 'durable_object'],
      [SAML_DR_RUNTIME_STATE_DATASET.id, 'durable_object'],
      ['admin.tenant_settings_documents', 'database'],
      ['core.anything', 'database'],
      ['pii.anything', 'database'],
      ...SNAPSHOT_ADMIN_MAPPING_TABLES.map((t) => [`admin.${t}`, 'database']),
    ];
    expect(() =>
      assertCompleteDatasetCoverage({
        backup: backupOf(consumed.map(([id, store]) => dataset({ id, store }, 3))),
      })
    ).not.toThrow();
  });
  it('rejects non-empty datasets that are not consumed', () => {
    for (const d of [
      dataset({ disposition: 'rebuild' }, 1),
      dataset({ disposition: 'exclude' }, 1),
      dataset({ id: 'other.kv', store: 'kv' }, 1),
      dataset({ id: 'other.db', store: 'database' }, 1),
      dataset({ id: 'admin.admin_policies', store: 'database' }, 1),
      dataset({ id: 'federation.saml_local_signing_state', store: 'database' }, 1),
      dataset({ id: 'core', store: 'database' }, 1),
      dataset({ id: 'xcore.users', store: 'database' }, 1),
      dataset({ id: 'admin.tenant_settings_documents', store: 'kv' }, 1),
    ]) {
      expect(() => assertCompleteDatasetCoverage({ backup: backupOf([d]) })).toThrow(INVALID);
    }
  });
  it('only reads row counts for the datasets that need them', () => {
    const backup = backupOf([dataset({ id: 'core.users', store: 'database' }, 9)]);
    assertCompleteDatasetCoverage({ backup });
    expect((backup as any).dataset).not.toHaveBeenCalled();
  });
});

describe('verifyRestoredSourceLoginUi', () => {
  const client = {
    tenant_id: TENANT,
    client_id: 'ext-login',
    application_type: 'web',
    allowed_channels: '["browser"]',
    client_secret_hash: null,
    enabled: 1,
  };
  const origin = {
    tenant_id: TENANT,
    client_id: 'ext-login',
    origin: 'https://login.example.test',
    handoff_allowed: 1,
    is_active: 1,
  };
  function ui(mutate?: (v: any) => void) {
    const state: any = {
      sourceClient: { ...client, logout_webhook_secret_encrypted: null },
      sourceOrigin: { ...origin },
      client: { ...client },
      origin: { ...origin },
    };
    mutate?.(state);
    const queryOne = vi.fn(async (sql: string) =>
      sql.includes('oauth_clients') ? state.client : state.origin
    );
    const input = {
      backup: { manifest: { source: { tenantId: TENANT, issuer: ISSUER } } },
      supplement: {
        sourceLoginUi: { client: row(state.sourceClient), origins: [row(state.sourceOrigin)] },
      },
      restored: { metadataCoreDb: { queryOne } },
      destinationUi: structuredClone(externalUi),
    } as unknown as AssembleAwsSamlTenantInput;
    return { input, queryOne };
  }
  it('accepts a matching external client', async () => {
    await expect(verifyRestoredSourceLoginUi(ui().input)).resolves.toBeUndefined();
  });
  it.each<[string, (s: any) => void]>([
    ['restored client missing', (s) => (s.client = null)],
    ['restored client disabled', (s) => (s.client.enabled = 0)],
    ['restored client tenant', (s) => (s.client.tenant_id = 'x')],
    ['restored client id', (s) => (s.client.client_id = 'x')],
    ['restored application type', (s) => (s.client.application_type = 'native')],
    ['restored channels', (s) => (s.client.allowed_channels = '["browser","api"]')],
    ['restored client secret', (s) => (s.client.client_secret_hash = 'h')],
    ['restored origin missing', (s) => (s.origin = null)],
    ['restored origin tenant', (s) => (s.origin.tenant_id = 'x')],
    ['restored origin client', (s) => (s.origin.client_id = 'x')],
    ['restored origin value', (s) => (s.origin.origin = 'https://x.test')],
    ['restored handoff', (s) => (s.origin.handoff_allowed = 0)],
    ['restored inactive', (s) => (s.origin.is_active = 0)],
    [
      'source client id differs from external UI',
      (s) => {
        s.sourceClient.client_id = 'other';
        s.sourceOrigin.client_id = 'other';
      },
    ],
    [
      'source origin differs from external UI',
      (s) => (s.sourceOrigin.origin = 'https://other.example.test'),
    ],
    ['source client tenant', (s) => (s.sourceClient.tenant_id = 'x')],
    ['source application type', (s) => (s.sourceClient.application_type = 'native')],
    ['source client secret', (s) => (s.sourceClient.client_secret_hash = 'h')],
    ['source logout secret', (s) => (s.sourceClient.logout_webhook_secret_encrypted = 'h')],
    ['source origin tenant', (s) => (s.sourceOrigin.tenant_id = 'x')],
    ['source origin handoff', (s) => (s.sourceOrigin.handoff_allowed = 0)],
    ['source origin inactive', (s) => (s.sourceOrigin.is_active = 0)],
    ['channels invalid json', (s) => (s.sourceClient.allowed_channels = '[')],
    ['channels not array', (s) => (s.sourceClient.allowed_channels = '{"browser":1}')],
    ['channels without browser', (s) => (s.sourceClient.allowed_channels = '["api"]')],
  ])('rejects %s', async (_n, mutate) => {
    await expect(verifyRestoredSourceLoginUi(ui(mutate).input)).rejects.toThrow(new Error(INVALID));
  });
  it('requires the embedded client id and issuer origin for embedded rehearsal', async () => {
    const embedded = (clientId: string, originValue: string) => {
      const { input } = ui((s) => {
        s.sourceClient.client_id = clientId;
        s.sourceOrigin.client_id = clientId;
        s.sourceOrigin.origin = originValue;
        s.client.client_id = clientId;
        s.origin = { ...s.origin, client_id: clientId, origin: originValue };
      });
      (input as any).destinationUi = undefined;
      return input;
    };
    await expect(
      verifyRestoredSourceLoginUi(embedded('login-ui', ISSUER))
    ).resolves.toBeUndefined();
    await expect(verifyRestoredSourceLoginUi(embedded('other', ISSUER))).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(embedded('login-ui', 'https://x.example.test'))
    ).rejects.toThrow(INVALID);
  });
  it('requires a disabled destination for a disabled source and vice versa', async () => {
    const make = (source: unknown, destination: unknown) =>
      ({
        backup: { manifest: { source: { tenantId: TENANT, issuer: ISSUER } } },
        supplement: { sourceLoginUi: source },
        restored: { metadataCoreDb: { queryOne: vi.fn() } },
        destinationUi: destination,
      }) as unknown as AssembleAwsSamlTenantInput;
    await expect(
      verifyRestoredSourceLoginUi(make({ mode: 'disabled' }, disabledUi))
    ).resolves.toBeUndefined();
    await expect(
      verifyRestoredSourceLoginUi(make({ mode: 'disabled' }, externalUi))
    ).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(make({ mode: 'disabled' }, undefined))
    ).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(make({ mode: 'enabled' }, disabledUi))
    ).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(make({ mode: 'disabled', extra: 1 }, disabledUi))
    ).rejects.toThrow(INVALID);
    await expect(verifyRestoredSourceLoginUi(make(undefined, disabledUi))).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(make({ client: {}, origins: [] }, externalUi))
    ).rejects.toThrow(INVALID);
    await expect(
      verifyRestoredSourceLoginUi(make({ client: {}, origins: 'x' }, externalUi))
    ).rejects.toThrow(INVALID);
  });
});
