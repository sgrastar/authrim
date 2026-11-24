import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_IDP_DEFAULTS } from '@authrim/ar-lib-core';
import { ExternalIdPError, ExternalIdPErrorCode, type HandleIdentityParams } from '../types';
import { decrypt, encrypt } from '../utils/crypto';
import { argRec, rec } from './helpers/mock-args';
import {
  KEY,
  NOW,
  account,
  m,
  makeEnv,
  params,
  provider,
  resetIdentityMocks,
  routes,
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

import { completeExternalIdpJIT, handleIdentity } from '../services/identity-stitching';

const ENV = makeEnv();
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
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
async function failure(promise: Promise<unknown>): Promise<ExternalIdPError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ExternalIdPError);
  return error as ExternalIdPError;
}
const run = (extra: Partial<HandleIdentityParams> = {}, env = ENV) =>
  handleIdentity(env, params(extra));
const NAME = { providerName: 'Corp' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetIdentityMocks();
  m.settings.mockResolvedValue(jit());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the answers of an explicit link', () => {
  const link = (extra: Partial<HandleIdentityParams> = {}) =>
    run({ linkingUserId: 'user-a', ...extra });
  beforeEach(() => {
    m.accountCtx.mockResolvedValue(account());
  });

  it('says why an unverified email is refused, and which provider', async () => {
    const error = await failure(link({ userInfo: userInfo({ email_verified: false }) }));
    expect(error.message).toBe(
      'The email from your external account is not verified. Please verify your email with the provider first.'
    );
    expect(error.details).toEqual(NAME);
  });

  it('says that the external account is linked elsewhere, by the directory or by the store', async () => {
    const text = 'This external account is already linked to another account.';
    routes({ external: [account({ legacyUserId: 'user-b' })] });
    let error = await failure(link());
    expect([error.message, error.details]).toEqual([text, NAME]);
    routes({});
    m.findLinked.mockResolvedValue({ id: 'l', userId: 'user-b' });
    error = await failure(link());
    expect([error.message, error.details]).toEqual([text, NAME]);
  });
});

describe('the answers of a sign-in', () => {
  it('names the provider when an unfinished account may not be finished', async () => {
    routes({ external: [account()] });
    const error = await failure(run({ accountCreationAllowed: false }));
    expect(error.message).toBe('Automatic account creation is not available for this sign-in.');
    expect(error.details).toEqual(NAME);
  });

  it('asks to link by hand, with the email and the provider', async () => {
    m.findByEmail.mockResolvedValue({ id: 'user-x', email: 'p@e.com', email_verified: 1 });
    const error = await failure(
      handleIdentity(makeEnv({ ENABLE_IDENTITY_STITCHING: 'false', SETTINGS: undefined }), params())
    );
    expect(error.code).toBe(ExternalIdPErrorCode.ACCOUNT_EXISTS_LINK_REQUIRED);
    expect(error.message).toBe(
      'An account with this email already exists. Please log in with your existing credentials first, then link your account.'
    );
    expect(error.details).toEqual({ email: 'Person@Example.com', providerName: 'Corp' });
  });

  it('keeps the provider name in each sign-up refusal', async () => {
    let error = await failure(run({ accountCreationAllowed: false }));
    expect(error.details).toEqual(NAME);
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_provisioning_enabled': false }));
    error = await failure(run());
    expect(error.details).toEqual(NAME);
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_require_verified_email': true }));
    error = await failure(
      run(
        {
          userInfo: userInfo({ email_verified: false }),
          provider: provider({ requireEmailVerified: false }),
        },
        makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
      )
    );
    expect(error.details).toEqual(NAME);
    m.settings.mockResolvedValue(jit());
    error = await failure(
      run(
        {
          invitation: { invitedEmail: 'person@example.com', requireVerifiedEmail: true },
          userInfo: userInfo({ email_verified: false }),
          provider: provider({ requireEmailVerified: false }),
        },
        makeEnv({ ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false' })
      )
    );
    expect(error.details).toEqual(NAME);
    m.registration.mockResolvedValue('blocked');
    error = await failure(run());
    expect(error.details).toEqual(NAME);
  });

  it('says which required attributes are missing', async () => {
    m.validateClaims.mockResolvedValue({
      ok: false,
      error: 'missing',
      missingRequiredFields: ['dept'],
    });
    const error = await failure(run());
    expect(error.message).toBe(
      'Automatic account creation requires additional profile attributes that are not available from the external provider.'
    );
  });

  it('logs a profile-store failure under the identity stitching module', async () => {
    m.findLinked.mockResolvedValue({ id: 'l1', tenantId: 'tenant-a', userId: 'user-a' });
    m.ensureDb.mockImplementation(() => {
      throw new Error('x');
    });
    await run();
    expect(m.log.warn).toHaveBeenCalled();
  });
});

describe('organizations of a sign-up', () => {
  it('lets a user with an organization through when standalone users are not allowed', async () => {
    m.settings.mockResolvedValue(jit({ 'external_idp.jit_allow_user_without_org': false }));
    m.ruleEvaluate.mockResolvedValue({
      denied: false,
      matched_rules: [],
      roles_to_assign: [],
      orgs_to_join: ['org-1'],
      attributes_to_set: [],
    });
    await expect(run()).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('custom claim mapping through nested values', () => {
  const submitted = () => rec(argRec(m.validateClaims).submitted);
  const mapped = (attributeMapping: Record<string, string>, info: Record<string, unknown>) =>
    run({
      provider: provider({ attributeMapping }),
      userInfo: { ...userInfo(), ...info },
    });

  it('survives a path through null or undefined and leaves the claim out', async () => {
    await mapped(
      {
        'custom_claims.a': 'data.user.name',
        'custom_claims.b': 'gone.deep',
        'custom_claims.c': 'text.deep',
      },
      { data: null, gone: undefined, text: 'plain' }
    );
    expect(submitted()).toEqual({});
  });

  it('leaves out a value that is not a plain value, and a list of such values', async () => {
    await mapped(
      { 'custom_claims.o': 'obj', 'custom_claims.l': 'list', 'custom_claims.e': 'empty' },
      { obj: { a: 1 }, list: [{ a: 1 }, [2, 3]], empty: [] }
    );
    expect(Object.keys(submitted())).toEqual(['l']);
    expect(submitted().l).toBe(2);
  });
});

describe('the sealed plan and the idempotency key', () => {
  const planBytes = (n: number) => 'x'.repeat(n);

  it('derives the idempotency key from the whole request, flow and subject included', async () => {
    await run();
    const request = argRec(m.provision);
    const planText = await decrypt(
      String((request.externalIdentity as Record<string, unknown>).profileDataEncrypted),
      KEY
    );
    const canon = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon(record[k])}`)
        .join(',')}}`;
    };
    const stable = canon({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      flow: 'external_idp',
      email: request.email,
      externalSubject: { issuer: 'prov-1', subject: 'sub-1' },
      runtimeUser: request.runtimeUser,
      plan: JSON.parse(planText) as unknown,
    });
    expect(request.idempotencyKey).toBe(`auth-account:${sha256(stable)}`);
  });

  it('accepts a plan of exactly 20 KiB and refuses one a byte longer', async () => {
    const base = { denied: false, roles_to_assign: [], orgs_to_join: [], attributes_to_set: [] };
    const sizeFor = async (pad: number) => {
      m.provision.mockClear();
      m.ruleEvaluate.mockResolvedValue({ ...base, matched_rules: [planBytes(pad)] });
      try {
        await run();
      } catch {
        return null;
      }
      const sealed = String(
        (argRec(m.provision).externalIdentity as Record<string, unknown>).profileDataEncrypted
      );
      return new TextEncoder().encode(await decrypt(sealed, KEY)).byteLength;
    };
    const small = await sizeFor(10);
    if (small === null) throw new Error('baseline plan refused');
    const exact = 20 * 1024 - small + 10;
    expect(await sizeFor(exact)).toBe(20 * 1024);
    expect(await sizeFor(exact + 1)).toBeNull();
  });

  describe('when a stored plan is read back', () => {
    const plan = (extra: Record<string, unknown> = {}) => ({
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
      ...extra,
    });
    const read = async (value: Record<string, unknown>, pad = 0) => {
      m.byIdentifier.mockResolvedValue(account());
      const chunks: string[] = [];
      for (let left = pad; left > 0; left -= 200) chunks.push(planBytes(Math.min(200, left)));
      const text = JSON.stringify({ ...value, matchedRules: chunks });
      m.findPending.mockResolvedValue({
        id: 'p1',
        tenantId: 'tenant-a',
        userId: 'user-a',
        providerId: 'prov-1',
        providerUserId: 'sub-1',
        profileDataEncrypted: await encrypt(text, KEY),
      });
      return {
        text,
        run: () =>
          completeExternalIdpJIT(ENV, {
            tenantId: 'tenant-a',
            userId: 'user-a',
            providerId: 'prov-1',
            providerUserId: 'sub-1',
          }),
      };
    };

    it('accepts 128 role assignments and refuses 129', async () => {
      const roles = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          roleId: `r${i}`,
          scopeType: 'global',
          scopeTarget: '',
        }));
      await expect(
        (await read(plan({ roleAssignments: roles(128) }))).run()
      ).resolves.toMatchObject({
        linkedIdentityId: 'p1',
      });
      await expect((await read(plan({ roleAssignments: roles(129) }))).run()).rejects.toThrow(
        'external_idp_jit_plan_invalid'
      );
    });

    it('accepts a plan of exactly 20 KiB and refuses one a byte longer', async () => {
      const bytes = (pad: number) => {
        const chunks: string[] = [];
        for (let left = pad; left > 0; left -= 200) chunks.push(planBytes(Math.min(200, left)));
        return new TextEncoder().encode(JSON.stringify({ ...plan(), matchedRules: chunks }))
          .byteLength;
      };
      // the smallest padding that fills 20 KiB exactly (one byte more is over the limit)
      let pad = 19000;
      while (bytes(pad) < 20 * 1024) pad++;
      expect(bytes(pad)).toBe(20 * 1024);
      await expect((await read(plan(), pad)).run()).resolves.toMatchObject({
        linkedIdentityId: 'p1',
      });
      await expect((await read(plan(), pad + 1)).run()).rejects.toThrow(
        'external_idp_jit_plan_invalid'
      );
    });
  });
});
