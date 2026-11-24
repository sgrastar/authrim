import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_IDP_DEFAULTS } from '@authrim/ar-lib-core';
import { ExternalIdPError, ExternalIdPErrorCode, type HandleIdentityParams } from '../types';
import { decrypt } from '../utils/crypto';
import { argRec, callArg, rec } from './helpers/mock-args';
import { containing } from './helpers/matchers';
import {
  DEFAULT_CORE_DB,
  DEFAULT_PII_DB,
  KEY,
  NOW,
  account,
  m,
  makeEnv,
  params,
  provider,
  resetIdentityMocks,
  routes,
  tokens,
  userInfo,
} from './helpers/identity-mocks';

vi.mock('@authrim/ar-lib-core', async (original) =>
  (await import('./helpers/identity-mocks')).libCoreMock(
    await original<typeof import('@authrim/ar-lib-core')>()
  )
);
vi.mock('../services/linked-identity-store', async () => {
  const { m: mocks } = await import('./helpers/identity-mocks');
  return {
    findLinkedIdentity: mocks.findLinked,
    createLinkedIdentity: mocks.createLinked,
    updateLinkedIdentity: mocks.updateLinked,
    findPendingLinkedIdentityProvisioning: mocks.findPending,
    activatePendingLinkedIdentity: mocks.activate,
  };
});
vi.mock('../services/external-usage-gate', async () => ({
  assertExternalProviderUsageAllowed: (await import('./helpers/identity-mocks')).m.gate,
}));

import { handleIdentity } from '../services/identity-stitching';

const ENV = makeEnv();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const jit = (extra: Record<string, unknown> = {}) => ({
  ...EXTERNAL_IDP_DEFAULTS,
  'external_idp.jit_provisioning_enabled': true,
  'external_idp.jit_require_verified_email': false,
  'external_idp.jit_allowed_provider_ids': '',
  'external_idp.jit_default_role_id': '',
  'external_idp.jit_join_all_matching_orgs': false,
  'external_idp.jit_allow_user_without_org': true,
  'external_idp.jit_allow_unverified_domain_mappings': false,
  ...extra,
});
const run = (extra: Partial<HandleIdentityParams> = {}, env = ENV) =>
  handleIdentity(env, params(extra));
const request = () => argRec(m.provision);
const sent = () => request() as Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetIdentityMocks();
  m.settings.mockResolvedValue(jit());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the account provisioning request', () => {
  const DIGEST = sha256('tenant-a\u0000prov-1\u0000sub-1');

  it('names the account, the subject and the identity it should create', async () => {
    const result = await run();
    const req = request();
    expect(req).toMatchObject({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      flow: 'external_idp',
      email: 'person@example.com',
      externalSubject: { issuer: 'prov-1', subject: 'sub-1' },
    });
    expect(req.operationId).toMatch(/^account-create-[0-9a-f-]{36}$/);
    expect(req.candidateUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.idempotencyKey).toMatch(/^auth-account:[0-9a-f]{64}$/);
    expect(result).toEqual({
      status: 'pending',
      userId: req.candidateUserId,
      isNewUser: true,
      stitchedFromExisting: false,
      accountId: `account:${String(req.candidateUserId)}`,
      operationId: req.operationId,
      providerId: 'prov-1',
      providerUserId: 'sub-1',
    });
  });

  it('describes the identity, with tokens encrypted for storage', async () => {
    await run({
      tokens: tokens({ refresh_token: 'refresh-token' }),
      upstreamClaims: userInfo({ name: 'Up' }),
    });
    const identity = sent().externalIdentity as Record<string, string | number | boolean | null>;
    expect(identity.id).toBe(`external-link-${DIGEST.slice(0, 32)}`);
    expect(identity).toMatchObject({
      providerId: 'prov-1',
      providerUserId: 'sub-1',
      providerEmail: 'person@example.com',
      emailVerified: true,
      tokenExpiresAt: NOW + 3_600_000,
      rawClaimsJson: JSON.stringify(userInfo({ name: 'Up' })),
    });
    await expect(decrypt(String(identity.accessTokenEncrypted), KEY)).resolves.toBe('access-token');
    await expect(decrypt(String(identity.refreshTokenEncrypted), KEY)).resolves.toBe(
      'refresh-token'
    );
  });

  it('stores no refresh token or expiry the provider did not give', async () => {
    await run({ tokens: tokens({ expires_in: undefined }) });
    const identity = sent().externalIdentity;
    expect(identity.refreshTokenEncrypted).toBeNull();
    expect(identity.tokenExpiresAt).toBeNull();
    m.provision.mockClear();
    await run({ tokens: tokens({ expires_in: 0 }) });
    expect(sent().externalIdentity.tokenExpiresAt).toBeNull();
  });

  it('seals the plan the pending account will be finished with', async () => {
    await run();
    const sealed = String(sent().externalIdentity.profileDataEncrypted);
    const planText = await decrypt(sealed, KEY);
    expect(JSON.parse(planText)).toEqual({
      schemaVersion: 1,
      customClaimValidation: {
        ok: true,
        schemas: [],
        nonPiiValues: {},
        piiValues: {},
        nonPiiKeysToDelete: [],
        piiKeysToDelete: [],
      },
      organizationIds: [],
      roleAssignments: [],
      defaultRoleId: null,
      matchedRules: [],
      attributesSet: [],
    });
    // keys are written in a fixed (sorted) order so the same plan always gives the same text
    expect(planText.startsWith('{"attributesSet":[],"customClaimValidation":{')).toBe(true);
  });

  it('describes the runtime user from the provider claims', async () => {
    await run();
    expect(sent().runtimeUser).toEqual({
      active: true,
      emailVerified: true,
      userType: 'end_user',
      displayName: 'Person',
      sourceRef: 'auth:external_idp',
      piiFields: { email: true, given_name: true, family_name: true, picture: true, locale: true },
      sensitiveValues: {
        email: 'person@example.com',
        given_name: 'Per',
        family_name: 'Son',
        picture: 'https://example.com/p.png',
        locale: 'en',
      },
      inlineProfileFields: { email_domain_hash: 'domain-hash', email_domain_hash_version: 3 },
    });
  });

  it('leaves out the claims the provider did not send', async () => {
    await run(
      {
        userInfo: userInfo({
          name: undefined,
          given_name: undefined,
          family_name: undefined,
          picture: undefined,
          locale: undefined,
          email_verified: undefined,
        }),
        provider: provider({ requireEmailVerified: false }),
      },
      makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
    );
    const user = sent().runtimeUser;
    expect(user.displayName).toBeNull();
    expect(user.emailVerified).toBe(false);
    expect(user.piiFields).toEqual({
      email: true,
      given_name: false,
      family_name: false,
      picture: false,
      locale: false,
    });
    expect(user.sensitiveValues).toEqual({
      email: 'person@example.com',
      given_name: null,
      family_name: null,
      picture: null,
      locale: null,
    });
  });

  it('gives an account without an email a placeholder address and no domain hash', async () => {
    await run({ userInfo: userInfo({ email: undefined, email_verified: false }) });
    const placeholder = `${DIGEST}@external.authrim.local`;
    expect(request().email).toBe(placeholder);
    expect(sent().externalIdentity.providerEmail).toBeNull();
    expect(sent().runtimeUser).toMatchObject({
      sensitiveValues: containing({ email: placeholder }),
      inlineProfileFields: {},
    });
    expect(m.hashFor).not.toHaveBeenCalled();
    expect(callArg(m.ruleEvaluate, 0, 0)).toMatchObject({
      email_domain_hash: undefined,
      email_domain_hash_version: undefined,
    });
  });

  it('ignores an address without a domain, and a hash version of zero', async () => {
    await run({ userInfo: userInfo({ email: 'no-domain' }) });
    expect(m.hashFor).not.toHaveBeenCalled();
    m.hashFor.mockResolvedValue({ hash: 'h', version: 0 });
    m.provision.mockClear();
    await run();
    expect(sent().runtimeUser.inlineProfileFields).toEqual({ email_domain_hash: 'h' });
  });

  it('derives the same idempotency key for the same sign-up, and another for a different one', async () => {
    await run();
    const first = request();
    m.provision.mockClear();
    await run();
    const second = request();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.operationId).not.toBe(first.operationId);
    expect(second.candidateUserId).not.toBe(first.candidateUserId);
    m.provision.mockClear();
    await run({ userInfo: userInfo({ name: 'Other Name' }) });
    expect(request().idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('cannot run without the account provisioner', async () => {
    await expect(
      handleIdentity(makeEnv({ EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined }), params())
    ).rejects.toThrow('external_idp_account_provisioner_unavailable');
  });

  it('needs the token encryption key', async () => {
    await expect(
      handleIdentity(makeEnv({ RP_TOKEN_ENCRYPTION_KEY: undefined }), params())
    ).rejects.toThrow();
    expect(m.provision).not.toHaveBeenCalled();
  });
});

describe('rules, organizations and roles', () => {
  const planOf = async () =>
    JSON.parse(await decrypt(String(sent().externalIdentity.profileDataEncrypted), KEY)) as Record<
      string,
      unknown
    >;

  const rules = (extra: Record<string, unknown>) =>
    m.ruleEvaluate.mockResolvedValue({
      denied: false,
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: [],
      attributes_to_set: [],
      ...extra,
    });

  it('evaluates the tenant rules for the new user, with the hashed domain', async () => {
    await run({ upstreamClaims: userInfo({ name: 'Up' }) });
    expect(m.createRuleEvaluator).toHaveBeenCalledWith({ db: 'meta' }, ENV.SETTINGS);
    expect(m.hashConfig).toHaveBeenCalledWith(ENV);
    expect(m.hashFor).toHaveBeenCalledWith('Person@Example.com', { cfg: 1 });
    expect(callArg(m.ruleEvaluate, 0, 0)).toEqual({
      email_domain_hash: 'domain-hash',
      email_domain_hash_version: 3,
      email_verified: true,
      idp_claims: userInfo({ name: 'Up' }),
      provider_id: 'prov-1',
      user_type: 'end_user',
      tenant_id: 'tenant-a',
    });
  });

  it('records the matched rules and attributes, and the first organization of a single match', async () => {
    rules({
      matched_rules: ['rule-1'],
      attributes_to_set: [{ name: 'tier', value: 'gold' }],
      orgs_to_join: ['org-rule', 'auto'],
    });
    m.orgByDomain.mockResolvedValue({ org_id: 'org-domain', auto_assign_role_id: 'role-d' });
    await run();
    expect(m.orgByDomain).toHaveBeenCalledWith(
      { db: 'meta' },
      'domain-hash',
      'tenant-a',
      expect.objectContaining({ allow_user_without_org: true })
    );
    expect(m.allOrgsByDomain).not.toHaveBeenCalled();
    expect(await planOf()).toMatchObject({
      organizationIds: ['org-rule', 'org-domain'],
      matchedRules: ['rule-1'],
      attributesSet: [{ name: 'tier', value: 'gold' }],
      roleAssignments: [{ roleId: 'role-d', scopeType: 'org', scopeTarget: 'org:org-domain' }],
    });
  });

  it('uses every matching organization when the tenant joins all of them, without duplicates', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_join_all_matching_orgs': true }));
    rules({ orgs_to_join: ['org-a'] });
    m.allOrgsByDomain.mockResolvedValue([
      { org_id: 'org-a', auto_assign_role_id: null },
      { org_id: 'org-b', auto_assign_role_id: 'role-b' },
    ]);
    await run();
    expect(m.orgByDomain).not.toHaveBeenCalled();
    expect(m.allOrgsByDomain).toHaveBeenCalledWith(
      { db: 'meta' },
      'domain-hash',
      'tenant-a',
      expect.objectContaining({ join_all_matching_orgs: true })
    );
    expect(await planOf()).toMatchObject({
      organizationIds: ['org-a', 'org-b'],
      roleAssignments: [{ roleId: 'role-b', scopeType: 'org', scopeTarget: 'org:org-b' }],
    });
  });

  it('resolves the rule roles: auto targets follow the first organization, unresolved ones are dropped', async () => {
    rules({
      orgs_to_join: ['org-1'],
      roles_to_assign: [
        { role_id: 'r-auto', scope_type: 'org', scope_target: 'auto' },
        { role_id: 'r-fixed', scope_type: 'org', scope_target: 'org:other' },
        { role_id: 'r-global', scope_type: 'global', scope_target: '' },
        { role_id: 'r-empty', scope_type: 'org', scope_target: '' },
        { role_id: 'r-dup', scope_type: 'org', scope_target: 'org:other' },
        { role_id: 'r-fixed', scope_type: 'org', scope_target: 'org:other' },
      ],
    });
    await run();
    expect((await planOf()).roleAssignments).toEqual([
      { roleId: 'r-auto', scopeType: 'org', scopeTarget: 'org:org-1' },
      { roleId: 'r-fixed', scopeType: 'org', scopeTarget: 'org:other' },
      { roleId: 'r-global', scopeType: 'global', scopeTarget: '' },
      { roleId: 'r-dup', scopeType: 'org', scopeTarget: 'org:other' },
    ]);
  });

  it('drops an auto role target when there is no organization', async () => {
    rules({ roles_to_assign: [{ role_id: 'r-auto', scope_type: 'org', scope_target: 'auto' }] });
    await run();
    expect((await planOf()).roleAssignments).toEqual([]);
  });

  it('names the default role, or none for an empty one', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_default_role_id': 'role-default' }));
    await run();
    expect((await planOf()).defaultRoleId).toBe('role-default');
    m.settings.mockResolvedValue(jit());
    m.provision.mockClear();
    await run();
    expect((await planOf()).defaultRoleId).toBeNull();
  });

  it('refuses a plan that would not fit its stored size', async () => {
    rules({ matched_rules: Array.from({ length: 200 }, (_, i) => `${'r'.repeat(120)}${i}`) });
    await expect(run()).rejects.toThrow('external_idp_jit_plan_too_large');
    expect(m.provision).not.toHaveBeenCalled();
  });
});

describe('custom claims', () => {
  it('validates the mapped claims against the tenant schema, requiring a complete record', async () => {
    await run({ mappedCustomClaims: { dept: 'Eng' } });
    expect(m.validateClaims).toHaveBeenCalledWith({
      db: DEFAULT_CORE_DB,
      dbPii: DEFAULT_PII_DB,
      schemaDb: { db: 'meta' },
      tenantId: 'tenant-a',
      submitted: { dept: 'Eng' },
      requireCompleteRecord: true,
    });
  });

  it('derives claims from the attribute mapping when none were mapped', async () => {
    await run({
      provider: provider({
        attributeMapping: {
          'custom_claims.dept': 'org.department',
          'custom_fields.level': 'levels',
          'custom_claims.ok': 'flag',
          'custom_claims.none': 'nothing',
          'custom_claims.object': 'org',
          'custom_claims.': 'name',
          'custom_fields.': 'name',
          'custom_claims_x.y': 'name',
          name: 'name',
        },
      }),
      userInfo: {
        ...userInfo(),
        org: { department: 'Eng' },
        levels: [{ a: 1 }, null, 'L3'],
        flag: false,
      },
    });
    expect(argRecSubmitted()).toEqual({ dept: 'Eng', level: null, ok: false });
  });

  function argRecSubmitted() {
    return rec(argRec(m.validateClaims).submitted);
  }

  it('takes the first usable value of a list, and nothing from an empty one', async () => {
    await run({
      provider: provider({
        attributeMapping: {
          'custom_claims.a': 'list',
          'custom_claims.b': 'empty',
          'custom_claims.c': 'nums',
        },
      }),
      userInfo: { ...userInfo(), list: [{}, 'x', 'y'], empty: [], nums: [[], 5] },
    });
    expect(argRecSubmitted()).toEqual({ a: 'x', c: 5 });
  });

  it('prefers the claims the caller mapped', async () => {
    await run({
      mappedCustomClaims: { given: '1' },
      provider: provider({ attributeMapping: { 'custom_claims.other': 'name' } }),
    });
    expect(argRecSubmitted()).toEqual({ given: '1' });
  });

  it('refuses a sign-up that lacks required attributes, naming them', async () => {
    m.validateClaims.mockResolvedValue({
      ok: false,
      error: 'missing',
      missingRequiredFields: ['dept'],
    });
    const error = await run().catch((e: unknown) => e);
    expect((error as ExternalIdPError).code).toBe(
      ExternalIdPErrorCode.REQUIRED_CUSTOM_CLAIMS_MISSING
    );
    expect((error as ExternalIdPError).details).toEqual({
      validationError: 'missing',
      missingRequiredFields: ['dept'],
    });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it('needs both account databases to validate the claims', async () => {
    m.userSources.mockResolvedValue({ coreDb: DEFAULT_CORE_DB, piiDb: null });
    await expect(run()).rejects.toThrow('identity_stitching_account_runtime_sources_required');
  });
});

describe('an account created at once', () => {
  const finish = async (status: 201 | 202 = 201) => {
    let authority: Record<string, unknown> | undefined;
    m.provision.mockImplementation(
      async (req: {
        operationId: string;
        candidateUserId: string;
        externalIdentity: Record<string, unknown>;
      }) => {
        authority = req.externalIdentity;
        return {
          status,
          operationId: req.operationId,
          accountId: `account:${req.candidateUserId}`,
          userId: req.candidateUserId,
        };
      }
    );
    m.findPending.mockImplementation(async () => ({
      id: authority?.id,
      tenantId: 'tenant-a',
      userId: String(argRec(m.provision).candidateUserId),
      providerId: 'prov-1',
      providerUserId: 'sub-1',
      profileDataEncrypted: authority?.profileDataEncrypted,
    }));
    routes({ external: ['notfound', 'notfound', 'late'] });
    m.byIdentifier.mockImplementation(async (_e: unknown, input: { indexKind: string }) => {
      if (input.indexKind === 'email_exact') throw new Error('account_data_route_not_found');
      if (m.provision.mock.calls.length === 0) throw new Error('account_data_route_not_found');
      return account({ legacyUserId: String(argRec(m.provision).candidateUserId) });
    });
    return run();
  };

  it('applies the plan and returns the activated identity with the user', async () => {
    rulesWithAttributes();
    const result = await finish();
    const userId = String(argRec(m.provision).candidateUserId);
    expect(result).toEqual({
      status: 'ready',
      userId,
      isNewUser: true,
      linkedIdentityId: `external-link-${sha256('tenant-a\u0000prov-1\u0000sub-1').slice(0, 32)}`,
      stitchedFromExisting: false,
      roles_assigned: [],
      orgs_joined: [],
      attributes_set: [{ name: 'tier', value: 'gold' }],
    });
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({
        userId,
        action: 'user_jit_provisioned',
        resource: 'user',
        resourceId: userId,
        metadata: JSON.stringify({
          providerId: 'prov-1',
          roles_assigned: [],
          orgs_joined: [],
          matched_rules: ['rule-1'],
        }),
      })
    );
    expect(m.createLinked).not.toHaveBeenCalled();
  });

  it('answers pending, without activating anything, when the provisioner is still working', async () => {
    const result = await finish(202);
    expect(result.status).toBe('pending');
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.activate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  function rulesWithAttributes() {
    m.ruleEvaluate.mockResolvedValue({
      denied: false,
      matched_rules: ['rule-1'],
      roles_to_assign: [],
      orgs_to_join: [],
      attributes_to_set: [{ name: 'tier', value: 'gold' }],
    });
  }
});
