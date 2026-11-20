/**
 * Direct Auth finish grant: the artifact's bindings, its PKCE check (verifyPKCE), and the
 * redemption it hands to the authorization code grant (src/token.ts handleDirectAuthFinishGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  useTenantSettings,
  postToken,
  expectOAuthError,
  pkceChallenge,
  DIRECT_AUTH_GRANT_TYPE,
  DIRECT_AUTH_REDIRECT_URI,
  VERIFIER,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthCodeData, createPublicClient } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const client = createPublicClient({ allowed_scopes: ['openid', 'profile'] });

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(client);
  mocks.extractDPoPProof.mockReturnValue('dpop-proof');
  mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'browser-jkt' });
});

function finishBody(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const body: Record<string, string | undefined> = {
    grant_type: DIRECT_AUTH_GRANT_TYPE,
    direct_auth_artifact: 'artifact-1',
    client_id: client.client_id,
    code_verifier: VERIFIER,
    channel: 'browser',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

async function useArtifact(
  metadata: Record<string, unknown>,
  challengeFor: string = VERIFIER
): Promise<ReturnType<typeof vi.fn>> {
  const consumeChallengeRpc = vi.fn().mockResolvedValue({
    challenge: await pkceChallenge(challengeFor),
    userId: 'user-001',
    metadata,
  });
  mocks.getChallengeStoreByChallengeId.mockResolvedValue({ consumeChallengeRpc });
  return consumeChallengeRpc;
}

const bound = { client_id: client.client_id, channel: 'browser' };

describe('required parameters', () => {
  it.each(['direct_auth_artifact', 'client_id', 'code_verifier', 'channel'])(
    'refuses a request without %s before reading the artifact',
    async (missing) => {
      const result = await postToken(env, finishBody({ [missing]: undefined }), {
        DPoP: 'dpop-proof',
      });
      expectOAuthError(
        result,
        400,
        'invalid_request',
        'direct_auth_artifact, client_id, code_verifier, and channel are required'
      );
      expect(mocks.getChallengeStoreByChallengeId).not.toHaveBeenCalled();
    }
  );

  it('refuses an invalid client_id with the validator message', async () => {
    mocks.validateClientId.mockReturnValue({ valid: false, error: 'client_id is malformed' });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(result, 401, 'invalid_client', 'client_id is malformed');
    expect(mocks.getChallengeStoreByChallengeId).not.toHaveBeenCalled();
  });
});

describe('artifact bindings', () => {
  it('names the channel mismatch', async () => {
    await useArtifact({ ...bound, channel: 'native' });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(result, 400, 'invalid_grant', 'Direct Auth artifact channel binding mismatch');
  });

  it('never exchanges a browser-session-only artifact', async () => {
    await useArtifact({ ...bound, browser_session_only: true });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'Direct Auth artifact cannot be exchanged for tokens'
    );
    expect(env.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
  });

  it.each(['provider_id', 'provider_slug', 'provider'])(
    'binds the artifact to the provider in metadata.%s',
    async (key) => {
      await useArtifact({ ...bound, [key]: 'google' });
      const refused = await postToken(env, finishBody({ provider_id: 'github' }), {
        DPoP: 'dpop-proof',
      });
      expectOAuthError(
        refused,
        400,
        'invalid_grant',
        'Direct Auth artifact provider binding mismatch'
      );
    }
  );

  it('requires the provider_id of a provider-bound artifact', async () => {
    await useArtifact({ ...bound, provider_id: 'google' });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'Direct Auth artifact provider binding mismatch'
    );
  });

  it('ignores an empty provider in the metadata', async () => {
    await useArtifact({ ...bound, provider_id: '' });
    useCodeStore(env, createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI }));
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expect(result.response.status).toBe(200);
  });

  it('accepts the matching provider and redeems the artifact as a code', async () => {
    await useArtifact({ ...bound, provider_slug: 'google' });
    const store = useCodeStore(env, createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI }));
    const result = await postToken(env, finishBody({ provider_id: 'google' }), {
      DPoP: 'dpop-proof',
    });
    expect(result.response.status).toBe(200);
    // Redeemed through the authorization code grant (validated as one), without the code’s
    // resource binding a Direct Auth code does not carry.
    expect(mocks.validateGrantType).toHaveBeenCalledWith('authorization_code');
    const consumed = store.consumeCodeRpc.mock.calls[0][0] as Record<string, unknown>;
    expect(consumed).toMatchObject({
      code: 'artifact-1',
      expectedRedirectUri: DIRECT_AUTH_REDIRECT_URI,
      codeVerifier: VERIFIER,
    });
    expect(consumed).not.toHaveProperty('expectedResource');
  });
});

describe('PKCE of the artifact (verifyPKCE)', () => {
  it.each([
    ['too short', 'a'.repeat(42)],
    ['with a character outside the unreserved set before it', `!${VERIFIER}`],
    ['with a character outside the unreserved set after it', `${VERIFIER}!`],
    ['too long', 'a'.repeat(129)],
  ])('refuses a verifier %s even when the challenge was made from it', async (_label, verifier) => {
    await useArtifact(bound, verifier);
    const result = await postToken(env, finishBody({ code_verifier: verifier }), {
      DPoP: 'dpop-proof',
    });
    expectOAuthError(result, 400, 'invalid_grant', 'Direct Auth artifact PKCE verification failed');
    expect(env.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
  });

  it('accepts a 43-character verifier whose S256 challenge matches', async () => {
    const verifier = 'A'.repeat(43);
    await useArtifact(bound, verifier);
    useCodeStore(env, createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI }));
    const result = await postToken(env, finishBody({ code_verifier: verifier }), {
      DPoP: 'dpop-proof',
    });
    expect(result.response.status).toBe(200);
  });
});

describe('redemption checks of a Direct Auth code', () => {
  it('refuses a scope beyond the client’s allowed scopes', async () => {
    await useArtifact(bound);
    useCodeStore(
      env,
      createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI, scope: 'openid admin' })
    );
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(result, 400, 'invalid_scope', 'Authorization grant scope is not allowed');
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('refuses an authentication below the AAL a scope requires', async () => {
    useTenantSettings(env, {
      assurance: {
        'assurance.enabled': true,
        'assurance.scope_aal_requirements': JSON.stringify({ profile: 'AAL2' }),
      },
    });
    await useArtifact(bound);
    useCodeStore(env, {
      ...createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI, scope: 'openid profile' }),
      aal: 'AAL1',
    });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'The authentication does not meet the required assurance level'
    );
  });

  it('accepts an authentication at the AAL the scope requires', async () => {
    useTenantSettings(env, {
      assurance: {
        'assurance.enabled': true,
        'assurance.scope_aal_requirements': JSON.stringify({ profile: 'AAL2' }),
      },
    });
    await useArtifact(bound);
    useCodeStore(env, {
      ...createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI, scope: 'openid  profile' }),
      aal: 'AAL2',
    });
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expect(result.response.status).toBe(200);
  });

  it('takes a code with no recorded AAL as AAL0 against the tenant default AAL', async () => {
    useTenantSettings(env, {
      assurance: { 'assurance.enabled': true, 'assurance.default_aal': 'AAL2' },
    });
    await useArtifact(bound);
    useCodeStore(env, createAuthCodeData({ redirectUri: DIRECT_AUTH_REDIRECT_URI }));
    const result = await postToken(env, finishBody(), { DPoP: 'dpop-proof' });
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'The authentication does not meet the required assurance level'
    );
  });

  it('does not hold a non-Direct-Auth code to the AAL with assurance on', async () => {
    useTenantSettings(env, { assurance: { 'assurance.enabled': true } });
    const confidential = {
      ...client,
      client_id: 'confidential-client-001',
      token_endpoint_auth_method: 'client_secret_post',
      client_secret_hash: 'h',
      default_resource: 'svc://confidential-api',
    };
    mocks.getClientCached.mockResolvedValue(confidential);
    mocks.extractDPoPProof.mockReturnValue(null);
    const data = createAuthCodeData();
    useCodeStore(env, data);
    const result = await postToken(env, {
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: data.redirectUri,
      client_id: confidential.client_id,
      client_secret: 's',
    });
    expect(result.response.status).toBe(200);
  });
});
