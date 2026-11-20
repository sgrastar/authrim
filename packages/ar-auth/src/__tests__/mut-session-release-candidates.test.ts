import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMetadata, Env } from '@authrim/ar-lib-core';

interface AssuranceInput {
  target: string;
  includeScopeClaims: boolean;
  loadSettings: () => Promise<unknown>;
  getAdapter: () => unknown;
  onError: () => unknown;
}
type ApplyInput = Record<string, unknown> & { destinationSurface: string };

const m = vi.hoisted(() => ({
  derive: vi.fn(),
  apply: vi.fn<(input: ApplyInput) => Promise<{ claims: Record<string, unknown> }>>(),
  assurance: vi.fn<(input: AssuranceInput) => Promise<Record<string, unknown>>>(),
  settings: vi.fn(),
  coreAdapter: { name: 'core' },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createPIIContextFromHono: () => ({ coreAdapter: m.coreAdapter, defaultPiiAdapter: {} }),
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    CanonicalRuntimeUserProjectionRepository: class {
      findByLegacyUserId() {
        return Promise.resolve(null);
      }
    },
    CanonicalSensitiveValueResolver: class {},
    resolveAssuranceClaims: m.assurance,
    resolveEffectiveSettings: m.settings,
    deriveOIDCSubject: m.derive,
    applyOIDCIdentityMapping: m.apply,
  };
});

import { ReleaseCandidatesUnavailableError, computeReleaseCandidates } from '../release-candidates';
import { parseClaimsRequest } from '@authrim/ar-lib-core';

const client = {
  client_id: 'app',
  redirect_uris: ['https://app.example/cb'],
  claims_parameter_policy: { sub: 'claims_allowed' },
} as unknown as ClientMetadata;

function run(claims?: unknown, idTokenOnly = false) {
  return computeReleaseCandidates({
    c: { env: { tag: 'env' } as unknown as Env } as never,
    tenantId: 't1',
    userId: 'user-1',
    clientId: 'app',
    clientMetadata: client,
    scopes: ['openid'],
    claimsRequest: claims ? parseClaimsRequest(JSON.stringify(claims)).request : undefined,
    claimsRequestProtected: false,
    idTokenOnly,
  });
}

function applied(surface: string): ApplyInput {
  const found = m.apply.mock.calls.find(([call]) => call.destinationSurface === surface);
  if (!found) throw new Error(`no ${surface} mapping`);
  return found[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  m.assurance.mockResolvedValue({});
  m.settings.mockResolvedValue({ values: {} });
  m.derive.mockResolvedValue('sub-for-app');
  m.apply.mockImplementation(async (input) => ({
    claims: input.claims as Record<string, unknown>,
  }));
});

describe('computeReleaseCandidates', () => {
  it('gives the assurance lookup the tenant settings and the PII core adapter', async () => {
    await run();
    const input = m.assurance.mock.calls[0][0];
    await input.loadSettings();
    expect(m.settings).toHaveBeenCalledWith({ tag: 'env' }, 'assurance', { tenantId: 't1' });
    expect(input.getAdapter()).toBe(m.coreAdapter);
    expect(input.onError()).toBeUndefined();
    expect(m.assurance.mock.calls.map(([call]) => [call.target, call.includeScopeClaims])).toEqual([
      ['userinfo', true],
      ['id_token', false],
    ]);
  });

  it('derives the sub a claims request names with the public subject type by default', async () => {
    await run({ id_token: { sub: { value: 'sub-for-app' } } });
    expect(m.derive).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'public', destinationSurface: 'id_token' })
    );
  });

  it('reports an unavailable release when the sub cannot be derived', async () => {
    const cause = new Error('mapping broken');
    m.derive.mockRejectedValueOnce(cause);
    const error = await run({ userinfo: { sub: { value: 'x' } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseCandidatesUnavailableError);
    expect(error).toMatchObject({
      name: 'ReleaseCandidatesUnavailableError',
      message: 'release_candidates_unavailable',
      cause,
    });
  });

  it('reports an unavailable release when the identity mapping fails', async () => {
    m.apply.mockRejectedValueOnce(new Error('mapping broken'));
    await expect(run()).rejects.toBeInstanceOf(ReleaseCandidatesUnavailableError);
  });

  it('releases eduperson_assurance to UserInfo when the assurance lookup gives it', async () => {
    m.assurance.mockImplementation(async (input) =>
      input.target === 'userinfo' ? { eduperson_assurance: ['https://refeds.org/assurance'] } : {}
    );
    await run();
    const userinfo = applied('userinfo');
    expect(userinfo.authorizedClaimNames).toEqual(['eduperson_assurance']);
    const idToken = applied('id_token');
    expect(idToken).toMatchObject({
      claimsAuthorizedByRequest: true,
      userInfoClaimsInIdToken: false,
    });
    expect(idToken).not.toHaveProperty('authorizedClaimNames');
  });

  it('gives no authorized names to UserInfo without assurance values', async () => {
    await run(undefined, true);
    const userinfo = applied('userinfo');
    expect(userinfo).not.toHaveProperty('authorizedClaimNames');
    expect(userinfo).not.toHaveProperty('claimsAuthorizedByRequest');
    const idToken = applied('id_token');
    expect(idToken.userInfoClaimsInIdToken).toBe(true);
  });
});
