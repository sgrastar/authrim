/**
 * The consent screen's release candidates are computed the way issuance computes the claims: a
 * claims parameter that names the pairwise sub the app receives must not make them disappear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  derive: vi.fn(),
  apply: vi.fn(),
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
