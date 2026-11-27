/**
 * The consent screen's release candidates are computed the way issuance computes the claims: a
 * claims parameter that names the pairwise sub the app receives must not make them disappear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  derive: vi.fn(),
  apply: vi.fn(),
  computed: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createPIIContextFromHono: () => ({ coreAdapter: {}, defaultPiiAdapter: {} }),
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    CanonicalRuntimeUserProjectionRepository: class {
      findByLegacyUserId() {
        return Promise.resolve({});
      }
    },
    CanonicalSensitiveValueResolver: class {},
    canonicalProjectionToOIDCClaimsUser: () => ({}),
    buildStandardUserClaims: () => ({ email: 'a@example.test' }),
    resolveAssuranceClaims: () => Promise.resolve({}),
    resolveEffectiveSettings: () => Promise.resolve({}),
    deriveOIDCSubject: mocks.derive,
    applyOIDCIdentityMapping: mocks.apply,
    createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
    loadSubjectServerClaims: mocks.computed,
    // The app's profile discloses what the test computes.
    resolveDisclosedServerClaims: (input: { claims: Record<string, unknown> }) =>
      Promise.resolve(structuredClone(input.claims)),
  };
});

import { computeReleaseCandidates } from '../release-candidates';

const PAIRWISE = 'pairwise-sub';
const client = {
  client_id: 'app',
  subject_type: 'pairwise',
  redirect_uris: ['https://app.example/cb'],
  claims_parameter_policy: { sub: 'claims_allowed', email: 'claims_allowed' },
} as unknown as ClientMetadata;

async function candidates(sub: string) {
  const { parseClaimsRequest } = await import('@authrim/ar-lib-core');
  const parsed = parseClaimsRequest(
    JSON.stringify({
      id_token: { sub: { value: sub }, email: null },
      userinfo: { sub: { value: sub }, email: null },
    })
  );
  return computeReleaseCandidates({
    c: { env: {} as Env } as never,
    tenantId: 'default',
    userId: 'user-1',
    clientId: 'app',
    clientMetadata: client,
    scopes: ['openid', 'email'],
    claimsRequest: parsed.request,
    claimsRequestProtected: false,
    idTokenOnly: false,
  });
}

describe('release candidates for a pairwise app with a claims parameter sub', () => {
  beforeEach(() => {
    mocks.computed.mockReset().mockResolvedValue({});
    mocks.derive.mockReset().mockResolvedValue(PAIRWISE);
    mocks.apply
      .mockReset()
      .mockImplementation((input: { claims: Record<string, unknown> }) =>
        Promise.resolve({ claims: { ...input.claims, sub: PAIRWISE } })
      );
  });

  it('lists the candidates when the claims name the sub the app receives', async () => {
    const result = await candidates(PAIRWISE);
    expect(result.candidates.map((candidate) => candidate.name)).toContain('email');
    expect(mocks.derive).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'pairwise', claims: { sub: 'user-1' } })
    );
  });

  it('lists none when the claims name the raw account id', async () => {
    const result = await candidates('user-1');
    expect(result.candidates).toEqual([]);
  });
});

describe('release candidates with a server-computed claim in the profile', () => {
  it('does not list authrim_groups as a consent item', async () => {
    mocks.derive.mockReset().mockResolvedValue(PAIRWISE);
    mocks.apply.mockReset().mockImplementation((input: { claims: Record<string, unknown> }) =>
      Promise.resolve({
        claims: { ...input.claims, authrim_groups: [{ id: 'g' }], authrim_roles: ['r'] },
      })
    );
    const result = await candidates(PAIRWISE);
    const names = result.candidates.map((candidate) => candidate.name);
    expect(names).toContain('email');
    expect(names).not.toContain('authrim_groups');
    expect(names).not.toContain('authrim_roles');
  });
});

describe('release candidates under an SAO rule on a server-computed claim', () => {
  const groups = [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }];
  async function emailCandidate() {
    const { parseClaimsRequest } = await import('@authrim/ar-lib-core');
    const parsed = parseClaimsRequest(
      JSON.stringify({
        userinfo: { email: null },
        _asc: {
          sao: {
            userinfo: [
              {
                loc: '/authrim_groups/0/key',
                method: 'simple',
                value: 'staff',
                else: 'omit',
                what: ['/email'],
              },
            ],
          },
        },
      })
    );
    const result = await computeReleaseCandidates({
      c: { env: {} as Env } as never,
      tenantId: 'default',
      userId: 'user-1',
      clientId: 'app',
      clientMetadata: { ...client, subject_type: 'public' },
      scopes: ['openid', 'email'],
      claimsRequest: parsed.request,
      claimsRequestProtected: true,
      idTokenOnly: false,
    });
    return result.candidates.map((candidate) => candidate.name);
  }

  beforeEach(() => {
    mocks.derive.mockReset().mockResolvedValue('user-1');
    mocks.apply
      .mockReset()
      .mockImplementation((input: { claims: Record<string, unknown> }) =>
        Promise.resolve({ claims: { ...input.claims } })
      );
  });

  it('makes email a candidate when the rule on the groups holds, and not when it does not', async () => {
    mocks.computed.mockResolvedValue({ authrim_groups: groups });
    const held = await emailCandidate();
    expect(held).toContain('email');
    expect(held).not.toContain('authrim_groups');
    mocks.computed.mockResolvedValue({});
    expect(await emailCandidate()).not.toContain('email');
  });

  it('asks the mapping not to fail a profile for the claims it has not computed', async () => {
    mocks.computed.mockResolvedValue({ authrim_groups: groups });
    await emailCandidate();
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({ serverComputedPending: true })
    );
  });

  it('hands the SAO rules the full computed set for the ID token and roles and groups for UserInfo', async () => {
    mocks.computed.mockResolvedValue({
      authrim_groups: groups,
      authrim_permissions: ['reports:read'],
    });
    await emailCandidate();
    expect(mocks.computed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'default',
      'user-1',
      'id_token'
    );
  });

  it('keeps an item that depends on a disclosed permission in the candidates', async () => {
    mocks.computed.mockResolvedValue({ authrim_permissions: ['reports:read'] });
    const { parseClaimsRequest } = await import('@authrim/ar-lib-core');
    const parsed = parseClaimsRequest(
      JSON.stringify({
        id_token: { email: null },
        _asc: {
          sao: {
            id_token: [
              {
                loc: '/authrim_permissions/0',
                method: 'simple',
                value: 'reports:read',
                else: 'omit',
                what: ['/email'],
              },
            ],
          },
        },
      })
    );
    const result = await computeReleaseCandidates({
      c: { env: {} as Env } as never,
      tenantId: 'default',
      userId: 'user-1',
      clientId: 'app',
      clientMetadata: { ...client, subject_type: 'public' },
      scopes: ['openid', 'email'],
      claimsRequest: parsed.request,
      claimsRequestProtected: true,
      idTokenOnly: true,
    });
    const names = result.candidates.map((candidate) => candidate.name);
    expect(names).toContain('email');
    expect(names).not.toContain('authrim_permissions');
  });
});
