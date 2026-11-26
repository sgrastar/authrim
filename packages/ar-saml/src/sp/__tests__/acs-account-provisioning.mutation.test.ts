/**
 * SAML ACS provisioning of an account for a sign-in that matches no linked identity: the JIT and
 * sign-up refusals and the request made to the account provisioner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';

const ident = vi.hoisted(() => {
  const adapter = (queryOne: (sql: string) => unknown) => ({
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn(async (sql: string) => queryOne(sql)),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const state = {
    routeBySubject: true,
    routeByEmail: true,
    registration: 'ok' as string,
    usagePolicy: { loginEnabled: true, signupEnabled: true },
    usageKey: { providerId: 'idp-1', ids: ['saml:idp-1', 'idp-1'] } as {
      providerId: string;
      ids: string[];
    } | null,
    provisionedUserId: 'user-001',
    subjectLink: null as Record<string, unknown> | null,
    providerLink: null as Record<string, unknown> | null,
    byId: (_id: string): Record<string, unknown> | null => null,
    byEmail: (_email: string): Record<string, unknown> | null => null,
    coreDb: null as ReturnType<typeof adapter> | null,
    piiDb: null as ReturnType<typeof adapter> | null,
    reset() {
      this.routeBySubject = true;
      this.routeByEmail = true;
      this.registration = 'ok';
      this.usagePolicy = { loginEnabled: true, signupEnabled: true };
      this.usageKey = { providerId: 'idp-1', ids: ['saml:idp-1', 'idp-1'] };
      this.provisionedUserId = 'user-001';
      this.subjectLink = null;
      this.providerLink = null;
      this.byId = (id: string) => ({
        id,
        email: 'user@example.com',
        email_verified: 1,
        active: true,
        lifecycle_state: 'active',
      });
      this.byEmail = () => null;
      this.coreDb = adapter(() => null);
      this.piiDb = adapter((sql) =>
        sql.includes('user_id = ? AND provider_id = ?') ? this.providerLink : this.subjectLink
      );
    },
  };
  state.reset();
  return state;
});

const {
  mockSchedule,
  mockLogger,
  mockPublish,
  mockAudit,
  mockUIConfig,
  mockReauthPolicy,
  mockBinding,
} = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
  mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockPublish: vi.fn(),
  mockAudit: vi.fn(),
  mockUIConfig: vi.fn(),
  mockReauthPolicy: vi.fn(),
  mockBinding: vi.fn(),
}));

const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../../admin/providers', () => ({
  getIdPUsageKeyByEntityId: vi.fn(async () => ident.usageKey),
  getIdPConfigByEntityId: async (...args: unknown[]): Promise<unknown> => {
    const config: unknown = await mockGetIdPConfigByEntityId(...args);
    return config
      ? { ...(config as Record<string, unknown>), identityMapping: { fieldMappingSetId: 'set-1' } }
      : config;
  },
}));

// A signed reference may be swapped per test; by default it is the whole document, as signed.
const signed = vi.hoisted(() => ({ override: null as null | ((xml: string) => string) }));
vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  verifyXmlSignatureAndGetReferences: vi.fn((xml: string) => [
    { uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml: signed.override?.(xml) ?? xml },
  ]),
  hasSignature: vi.fn((xml: string) => xml.includes('<ds:Signature')),
}));

function mappingBinding() {
  const entry = (id: string, namespace: string, path: string, targetType: string) => ({
    id,
    namespace,
    path,
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    targetType,
  });
  return withExplicitMappingGraphs(
    {
      id: 'activation-1',
      tenantId: 'default',
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'set-1-v1',
      catalog: {
        identity: {
          id: 'catalog-1',
          version: '1',
          contentHash: 'catalog-1',
          compatibilityRange: '^0.3.0',
        },
        entries: [
          entry('field.saml.subject.nameId', 'saml.subject', 'nameId', 'source'),
          entry('field.profile.email', 'authrim.profile', 'email', 'canonical'),
        ],
      },
      edges: [
        {
          id: 'edge.nameId.email',
          sourceRef: { side: 'source', namespace: 'saml.subject', path: 'nameId' },
          targetRef: { side: 'destination', namespace: 'authrim.profile', path: 'email' },
          edgeKind: 'direct',
        },
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: 'set-1-v1', rules: [] },
    },
    true
  );
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({ module: () => mockLogger }),
    createLogger: () => ({ module: () => mockLogger }),
    publishEvent: mockPublish,
    createAuditLog: mockAudit,
    getUIConfig: mockUIConfig,
    scheduleSignInAttemptFailureRecord: mockSchedule,
    readExternalProviderReauthPolicy: mockReauthPolicy,
    readExternalProviderUsagePolicy: vi.fn(async () => ident.usagePolicy),
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveAccountDataContextByIdentifier: vi.fn(
      async (_env: unknown, request: { indexKind: string; expectedAccountId?: string }) => {
        if (
          request.indexKind === 'external_subject' &&
          !request.expectedAccountId &&
          !ident.routeBySubject
        ) {
          throw new Error('account_data_route_not_found');
        }
        if (request.indexKind === 'email_exact' && !ident.routeByEmail) {
          throw new Error('account_data_route_not_found');
        }
        return {
          coreDb: ident.coreDb,
          piiDb: ident.piiDb,
          accountId: 'acc-1',
          legacyUserId: ident.provisionedUserId,
        };
      }
    ),
    checkEmailRegistration: vi.fn(async () => ident.registration),
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async () => ({ schemaDb: {} })),
    validateCustomClaimWrite: vi.fn(async () => ({ ok: true })),
    persistCustomClaimWrite: vi.fn(async () => undefined),
    syncUserLifecycleState: vi.fn(async () => undefined),
    CanonicalRuntimeUserStore: class {
      async findById(id: string) {
        return ident.byId(id);
      }
      async findByEmail(email: string) {
        return ident.byEmail(email);
      }
    },
    resolveRuntimeIdentityMappingBinding: mockBinding,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    resolveSignInFlowProfileRefs: vi.fn(),
    readAuthenticationProfile: vi.fn(),
  };
});

import {
  callACS,
  buildEnv,
  IDP_ENTITY,
  NOW,
  type AcsEnv,
  type AcsEnvState,
} from './helpers/acs-harness';

const state: AcsEnvState = {
  relayState: 'https://ui.example.com/',
  assertionConsumeStatus: 200,
  assertionConsumeThrows: false,
};
let env: AcsEnv;
const pending: Promise<unknown>[] = [];
const publishRoute = vi.fn();
const provisionAccount = vi.fn();
const SUBJECT_KEY =
  'saml:urn%3Aoasis%3Anames%3Atc%3ASAML%3A1.1%3Anameid-format%3AemailAddress:user%40example.com';

function idp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.com/sso',
    certificate: 'mock-certificate',
    attributeMapping: { email: 'email' },
    ...overrides,
  };
}

async function run(headers: Record<string, string> = {}) {
  const response = await callACS(env, pending, { headers });
  await Promise.allSettled(pending.splice(0));
  return response;
}

function identityFailure(): Record<string, unknown> | undefined {
  const call = mockAudit.mock.calls.find(
    (entry: unknown[]) =>
      (entry[1] as { action: string }).action === 'saml.identity_resolution.failed'
  );
  return call
    ? (JSON.parse(String((call[1] as { metadata: string }).metadata)) as Record<string, unknown>)
    : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ident.reset();
  state.context = undefined;
  state.assertionConsumeStatus = 200;
  mockPublish.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockUIConfig.mockResolvedValue(null);
  mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
  mockBinding.mockResolvedValue(mappingBinding());
  mockGetIdPConfigByEntityId.mockResolvedValue(idp());
  publishRoute.mockImplementation(async (request: { operationId: string; accountId: string }) => ({
    operationId: request.operationId,
    accountId: request.accountId,
    status: 201,
  }));
  provisionAccount.mockResolvedValue({ status: 201, accountId: 'acc-1', userId: 'user-new' });
  env = buildEnv(state);
  (env as Record<string, unknown>).SAML_ACCOUNT_PROVISIONER = {
    publishExternalIdpRoute: publishRoute,
    provisionAuthAccount: provisionAccount,
  };
});

afterEach(() => {
  vi.useRealTimers();
  signed.override = null;
});

describe('no linked account', () => {
  beforeEach(() => {
    ident.routeBySubject = false;
    ident.routeByEmail = false;
  });

  it('refuses when JIT provisioning is disabled for the IdP', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue(idp({ jitEmailLinkingPolicy: 'disabled' }));

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toMatchObject({ failure_reason: 'jit_disabled' });
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it('refuses sign-up when the tenant turned it off for the IdP', async () => {
    ident.usagePolicy = {
      loginEnabled: true,
      signupEnabled: false,
    };

    const response = await run();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'signup_disabled' });
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it('refuses a deleted address the tenant blocks from re-registering, as a sign-up refusal', async () => {
    ident.registration = 'blocked';

    const response = await run();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'signup_disabled' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'SAML sign-up refused: re-registration of a deleted account is blocked',
      { issuer: IDP_ENTITY }
    );
    expect(provisionAccount).not.toHaveBeenCalled();
  });

  it('fails when the re-registration check cannot be made', async () => {
    ident.registration = 'unavailable';

    const response = await run();

    expect(response.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'ACS Error',
      {},
      expect.objectContaining({ message: 'saml_reregistration_check_unavailable' })
    );
  });

  it('fails when no account provisioner is bound', async () => {
    delete (env as Record<string, unknown>).SAML_ACCOUNT_PROVISIONER;

    const response = await run();

    expect(response.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'ACS Error',
      {},
      expect.objectContaining({ message: 'saml_account_provisioner_unavailable' })
    );
  });

  it('reports a provisioning that is still pending as a refusal', async () => {
    provisionAccount.mockResolvedValue({ status: 202, accountId: 'acc-1', userId: 'user-new' });

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toMatchObject({ failure_reason: 'account_provisioning_pending' });
  });

  it('asks the provisioner for a verified end-user account named by the IdP email', async () => {
    ident.provisionedUserId = 'user-new';

    await run();

    const request = provisionAccount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      flow: 'saml',
      email: 'user@example.com',
      externalSubject: { issuer: IDP_ENTITY, subject: SUBJECT_KEY },
      runtimeUser: {
        active: true,
        emailVerified: true,
        userType: 'end_user',
        sourceRef: 'auth:saml',
      },
    });
    expect(String(request.operationId)).toMatch(/^saml-account-[0-9a-f-]{36}$/);
    expect(String(request.idempotencyKey)).toMatch(/^saml-account:[0-9a-f]{64}$/);
    expect(String(request.candidateUserId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fails when the provisioned account does not map to the user the provisioner named', async () => {
    ident.provisionedUserId = 'someone-else';

    const response = await run();

    expect(response.status).toBe(500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'ACS Error',
      {},
      expect.objectContaining({ message: 'saml_account_provisioning_route_mismatch' })
    );
  });
});
