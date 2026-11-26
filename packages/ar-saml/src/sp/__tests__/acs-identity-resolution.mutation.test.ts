/**
 * SAML ACS account resolution: sign-in through an existing linked identity, linking by email,
 * and every refusal (disabled policies, inactive or unverified accounts, conflicts), observed
 * through the failure audit, the attempt record and the linked-identity writes.
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

function pii() {
  if (!ident.piiDb) throw new Error('pii adapter missing');
  return ident.piiDb;
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

describe('an existing linked identity', () => {
  beforeEach(() => {
    ident.subjectLink = { id: 'li-1', user_id: 'user-001', provider_user_id: SUBJECT_KEY };
  });

  it('signs the linked user in and records the use of the link', async () => {
    const response = await run();

    expect(response.status).toBe(302);
    const update = pii().execute.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('UPDATE linked_identities')
    );
    expect(update?.[0]).toBe(
      'UPDATE linked_identities SET last_used_at = ? WHERE tenant_id = ? AND id = ?'
    );
    expect(update?.[1]).toEqual([NOW, 'tenant-a', 'li-1']);
    const lookup = pii().queryOne.mock.calls[0] as unknown[] | undefined;
    expect(lookup?.[1]).toEqual(['tenant-a', IDP_ENTITY, SUBJECT_KEY]);
    expect(mockAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ action: 'user.login', userId: 'user-001' })
    );
    const loginAudit = mockAudit.mock.calls.find(
      (call: unknown[]) => (call[1] as { action: string }).action === 'user.login'
    );
    expect(JSON.parse(String((loginAudit?.[1] as { metadata: string }).metadata))).toMatchObject({
      method: 'saml',
      idp_entity_id: IDP_ENTITY,
      federated_identity_resolution: 'existing_link',
      linked_identity_id: 'li-1',
    });
  });

  it('refuses a link that points to an inactive user', async () => {
    ident.byId = () => null;

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toEqual({
      protocol: 'saml',
      failure_reason: 'linked_identity_inactive_user',
      linked_identity_id: 'li-1',
    });
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'provisioning_failed' });
  });

  it('refuses a link whose email now belongs to another local user', async () => {
    ident.byEmail = () => ({ id: 'someone-else' });

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toEqual({
      protocol: 'saml',
      failure_reason: 'linked_identity_email_conflict',
      linked_identity_id: 'li-1',
    });
    expect(pii().execute).not.toHaveBeenCalled();
  });

  it('accepts a link whose email belongs to the same user', async () => {
    ident.byEmail = () => ({ id: 'user-001' });

    expect((await run()).status).toBe(302);
  });

  it('refuses the sign-in when the tenant turned sign-in off for the IdP', async () => {
    ident.usagePolicy = {
      loginEnabled: false,
      signupEnabled: true,
    };

    const response = await run();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'method_disabled' });
    expect(pii().execute).not.toHaveBeenCalled();
  });
});

describe('linking by email', () => {
  beforeEach(() => {
    ident.byEmail = () => ({ id: 'user-001' });
  });

  it('links the existing verified account to the IdP subject and publishes the route', async () => {
    const response = await run();

    expect(response.status).toBe(302);
    const insert = pii().execute.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('INSERT INTO linked_identities')
    );
    expect(insert?.[1]).toEqual([
      expect.any(String),
      'tenant-a',
      'user-001',
      IDP_ENTITY,
      SUBJECT_KEY,
      'user@example.com',
      null,
      expect.any(String),
      NOW,
      NOW,
    ]);
    const raw = JSON.parse(String((insert?.[1] as unknown[])[7])) as Record<string, unknown>;
    expect(raw).toMatchObject({
      source: 'saml_sp_acs',
      nameId: 'user@example.com',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
    const request = publishRoute.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      accountId: 'acc-1',
      userId: 'user-001',
      providerId: IDP_ENTITY,
      providerUserId: SUBJECT_KEY,
    });
    expect(String(request.operationId)).toMatch(/^saml-route-[0-9a-f]{32}$/);
    expect(String(request.idempotencyKey)).toMatch(/^saml-route:[0-9a-f]{64}$/);
    expect(String(request.operationId).slice('saml-route-'.length)).toBe(
      String(request.idempotencyKey).slice('saml-route:'.length, 'saml-route:'.length + 32)
    );
  });

  it('fails when the route publication answer does not match the request', async () => {
    publishRoute.mockResolvedValue({ operationId: 'other', accountId: 'acc-1', status: 201 });
    expect((await run()).status).toBe(500);

    publishRoute.mockImplementation(async (r: { operationId: string }) => ({
      operationId: r.operationId,
      accountId: 'other-account',
      status: 201,
    }));
    expect((await run()).status).toBe(500);

    publishRoute.mockImplementation(async (r: { operationId: string; accountId: string }) => ({
      operationId: r.operationId,
      accountId: r.accountId,
      status: 200,
    }));
    expect((await run()).status).toBe(500);
  });

  it.each([201, 202])('accepts a route publication answered with %i', async (status) => {
    publishRoute.mockImplementation(async (r: { operationId: string; accountId: string }) => ({
      operationId: r.operationId,
      accountId: r.accountId,
      status,
    }));

    expect((await run()).status).toBe(302);
  });

  it('refuses email linking when the IdP policy does not allow it', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue(idp({ jitEmailLinkingPolicy: 'jit_create_only' }));

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toEqual({
      protocol: 'saml',
      failure_reason: 'email_linking_disabled',
      policy: 'jit_create_only',
    });
  });

  it('refuses an email match whose account is inactive', async () => {
    ident.byId = () => null;

    await run();

    expect(identityFailure()).toMatchObject({ failure_reason: 'email_match_inactive_user' });
  });

  it.each([
    ['0', 0],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
  ])('refuses an account whose email_verified is %s', async (_label, flag) => {
    ident.byId = (id: string) => ({ id, email_verified: flag, active: true });

    await run();

    expect(identityFailure()).toMatchObject({
      failure_reason: 'email_match_unverified_local_email',
    });
    expect(pii().execute).not.toHaveBeenCalled();
  });

  it.each([true, 1, '1'])('accepts an account whose email_verified is %s', async (flag) => {
    ident.byId = (id: string) => ({ id, email_verified: flag, active: true });

    expect((await run()).status).toBe(302);
  });

  it('refuses an account already linked to another subject of this IdP', async () => {
    ident.providerLink = { id: 'li-9', user_id: 'user-001', provider_user_id: 'saml:other' };

    const response = await run();

    expect(response.status).toBe(400);
    expect(identityFailure()).toEqual({
      protocol: 'saml',
      failure_reason: 'email_match_provider_subject_conflict',
      linked_identity_id: 'li-9',
    });
  });

  it('reuses an existing link to the same subject without inserting', async () => {
    ident.providerLink = { id: 'li-9', user_id: 'user-001', provider_user_id: SUBJECT_KEY };

    const response = await run();

    expect(response.status).toBe(302);
    expect(
      pii().execute.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT'))
    ).toBe(false);
    expect(
      pii().execute.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('UPDATE linked_identities')
      )
    ).toBe(true);
    expect(publishRoute).not.toHaveBeenCalled();
  });

  it.each([['another user owning the subject', 'user-other', 'linked_identity_subject_conflict']])(
    'refuses when the insert races with %s',
    async (_label, owner, reason) => {
      let raced = false;
      pii().execute.mockImplementationOnce(async () => {
        raced = true;
        throw new Error('unique');
      });
      pii().queryOne.mockImplementation(async (sql: string) =>
        raced && sql.includes('provider_user_id = ?') && !sql.includes('user_id = ? AND')
          ? { id: 'li-x', user_id: owner }
          : null
      );

      const response = await run();

      expect(response.status).toBe(400);
      expect(identityFailure()).toMatchObject({ failure_reason: reason });
    }
  );

  it('keeps going when the insert raced with the same user, reusing the winning link', async () => {
    let raced = false;
    pii().execute.mockImplementationOnce(async () => {
      raced = true;
      throw new Error('unique');
    });
    pii().queryOne.mockImplementation(async (sql: string) =>
      raced && sql.includes('provider_user_id = ?') && !sql.includes('user_id = ? AND')
        ? { id: 'li-x', user_id: 'user-001' }
        : null
    );

    expect((await run()).status).toBe(302);
    expect(publishRoute.mock.calls[0]?.[0]).toMatchObject({ linkedIdentityId: 'li-x' });
  });

  it('fails an insert error that no other link explains', async () => {
    pii().execute.mockRejectedValueOnce(new Error('disk full'));

    expect((await run()).status).toBe(500);
  });
});
