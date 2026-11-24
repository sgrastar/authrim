import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { throwValue } from './matchers';
import type { HandleIdentityParams, UpstreamProvider, UserInfo, TokenResponse } from '../../types';

/** Test doubles for what identity-stitching reads from ar-lib-core and the stores. */
export const m = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  byIdentifier: vi.fn(),
  accountCtx: vi.fn(),
  metadataCtx: vi.fn(),
  userSources: vi.fn(),
  customSources: vi.fn(),
  validateClaims: vi.fn(),
  persist: vi.fn(),
  sync: vi.fn(),
  join: vi.fn(),
  assign: vi.fn(),
  ensureDb: vi.fn(),
  audit: vi.fn(),
  ruleEvaluate: vi.fn(),
  createRuleEvaluator: vi.fn(),
  orgByDomain: vi.fn(),
  allOrgsByDomain: vi.fn(),
  hashConfig: vi.fn(),
  hashFor: vi.fn(),
  registration: vi.fn(),
  settings: vi.fn(),
  updateProfile: vi.fn(),
  findByEmail: vi.fn(),
  storeOptions: [] as unknown[],
  readProfile: vi.fn(),
  findLinked: vi.fn(),
  createLinked: vi.fn(),
  updateLinked: vi.fn(),
  findPending: vi.fn(),
  activate: vi.fn(),
  gate: vi.fn(),
  provision: vi.fn(),
  publish: vi.fn(),
};

export function libCoreMock(actual: typeof import('@authrim/ar-lib-core')) {
  class StoreDouble {
    constructor(options: unknown) {
      m.storeOptions.push(options);
    }
    findByEmail(email: string) {
      return m.findByEmail(email) as unknown;
    }
  }
  return {
    ...actual,
    createLogger: () => ({ module: () => m.log }),
    createAuditLog: m.audit,
    ensureDatabaseAdapter: m.ensureDb,
    CanonicalRuntimeUserStore: StoreDouble,
    resolveAccountDataContext: m.accountCtx,
    resolveAccountDataContextByIdentifier: m.byIdentifier,
    resolveTenantMetadataContext: m.metadataCtx,
    resolveTenantUserStoreSourcesFromEnv: m.userSources,
    resolveCustomClaimRuntimeSourcesFromEnv: m.customSources,
    validateCustomClaimWrite: m.validateClaims,
    persistCustomClaimWrite: m.persist,
    syncUserLifecycleState: m.sync,
    joinOrganization: m.join,
    assignScopedRoleToUser: m.assign,
    createRuleEvaluator: m.createRuleEvaluator,
    resolveOrgByDomainHash: m.orgByDomain,
    resolveAllOrgsByDomainHash: m.allOrgsByDomain,
    getEmailDomainHashConfig: m.hashConfig,
    generateEmailDomainHashWithVersion: m.hashFor,
    checkEmailRegistration: m.registration,
    resolveEffectiveSettings: m.settings,
    updateProfileOnLogin: m.updateProfile,
    readAuthenticationProfile: m.readProfile,
  };
}

export const KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
export const NOW = 1_700_000_000_000;
export const CORE_DB = { db: 'core' };
export const PII_DB = { db: 'pii' };
export const DEFAULT_PII_DB = { db: 'default-pii' };
export const DEFAULT_CORE_DB = { db: 'default-core' };

export function account(extra: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    legacyUserId: 'user-a',
    coreDb: CORE_DB,
    piiDb: PII_DB,
    ...extra,
  };
}

export const provider = (extra: Partial<UpstreamProvider> = {}): UpstreamProvider => ({
  id: 'prov-1',
  slug: 'corp',
  tenantId: 'tenant-a',
  name: 'Corp',
  providerType: 'oidc',
  enabled: true,
  priority: 0,
  issuer: 'https://idp.example',
  clientId: 'cid',
  clientSecretEncrypted: 'x',
  scopes: 'openid',
  attributeMapping: {},
  autoLinkEmail: true,
  jitProvisioning: true,
  requireEmailVerified: true,
  providerQuirks: {},
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

export const userInfo = (extra: Partial<UserInfo> = {}): UserInfo => ({
  sub: 'sub-1',
  email: 'Person@Example.com',
  email_verified: true,
  name: 'Person',
  given_name: 'Per',
  family_name: 'Son',
  picture: 'https://example.com/p.png',
  locale: 'en',
  ...extra,
});

export const tokens = (extra: Partial<TokenResponse> = {}): TokenResponse => ({
  access_token: 'access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  ...extra,
});

export function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    RP_TOKEN_ENCRYPTION_KEY: KEY,
    SETTINGS: {
      get: vi.fn(async () => null),
    },
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: {
      provisionExternalIdpAccount: m.provision,
      publishExternalIdpRoute: m.publish,
    },
    ...extra,
  } as unknown as Env;
}

export function params(extra: Partial<HandleIdentityParams> = {}): HandleIdentityParams {
  return {
    provider: provider(),
    userInfo: userInfo(),
    tokens: tokens(),
    tenantId: 'tenant-a',
    ...extra,
  };
}

const NOT_FOUND = () => new Error('account_data_route_not_found');

/** Route answers by index kind, consumed in order (the last one repeats). */
export function routes(answers: { external?: unknown[]; email?: unknown[] }) {
  const queues: Record<string, unknown[]> = {
    external_subject: [...(answers.external ?? ['notfound'])],
    email_exact: [...(answers.email ?? ['notfound'])],
  };
  m.byIdentifier.mockImplementation(async (_env: unknown, input: { indexKind: string }) => {
    const queue = queues[input.indexKind] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === 'notfound') throw NOT_FOUND();
    if (next instanceof Error || typeof next === 'string') throwValue(next);
    return next;
  });
}

export function resetIdentityMocks() {
  vi.clearAllMocks();
  m.storeOptions.length = 0;
  m.byIdentifier.mockReset();
  routes({});
  m.accountCtx.mockReset().mockResolvedValue(account());
  m.metadataCtx.mockReset().mockResolvedValue({ coreDb: { db: 'meta' } });
  m.userSources.mockReset().mockResolvedValue({ coreDb: DEFAULT_CORE_DB, piiDb: DEFAULT_PII_DB });
  m.customSources.mockReset().mockResolvedValue({ schemaDb: { db: 'schema' } });
  m.validateClaims.mockReset().mockResolvedValue({
    ok: true,
    schemas: [],
    nonPiiValues: {},
    piiValues: {},
    nonPiiKeysToDelete: [],
    piiKeysToDelete: [],
  });
  m.persist.mockReset().mockResolvedValue(undefined);
  m.sync.mockReset().mockResolvedValue(undefined);
  m.join.mockReset().mockResolvedValue({ success: true });
  m.assign.mockReset().mockResolvedValue({ success: true });
  m.ensureDb
    .mockReset()
    .mockImplementation((db: unknown, label: string) => ({ adapterOf: db, label }));
  m.audit.mockReset().mockResolvedValue(undefined);
  m.ruleEvaluate.mockReset().mockResolvedValue({
    denied: false,
    matched_rules: [],
    roles_to_assign: [],
    orgs_to_join: [],
    attributes_to_set: [],
  });
  m.createRuleEvaluator.mockReset().mockImplementation(() => ({ evaluate: m.ruleEvaluate }));
  m.orgByDomain.mockReset().mockResolvedValue(null);
  m.allOrgsByDomain.mockReset().mockResolvedValue([]);
  m.hashConfig.mockReset().mockResolvedValue({ cfg: 1 });
  m.hashFor.mockReset().mockResolvedValue({ hash: 'domain-hash', version: 3 });
  m.registration.mockReset().mockResolvedValue('allowed');
  m.settings.mockReset();
  m.updateProfile.mockReset().mockResolvedValue(undefined);
  m.findByEmail.mockReset().mockResolvedValue(null);
  m.readProfile.mockReset();
  m.findLinked.mockReset().mockResolvedValue(null);
  m.createLinked.mockReset().mockResolvedValue('new-link');
  m.updateLinked.mockReset().mockResolvedValue(true);
  m.findPending.mockReset().mockResolvedValue(null);
  m.activate.mockReset().mockResolvedValue(undefined);
  m.gate.mockReset().mockResolvedValue(undefined);
  m.provision
    .mockReset()
    .mockImplementation(async (request: { operationId: string; candidateUserId: string }) => ({
      status: 202,
      operationId: request.operationId,
      accountId: `account:${request.candidateUserId}`,
      userId: request.candidateUserId,
    }));
  m.publish
    .mockReset()
    .mockImplementation(async (request: { operationId: string; accountId: string }) => ({
      status: 201,
      operationId: request.operationId,
      accountId: request.accountId,
    }));
}
