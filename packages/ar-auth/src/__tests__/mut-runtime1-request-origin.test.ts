/**
 * The origin a request is taken to come from (getRequestOrigin), as the email verification
 * challenge records it for the browser that may answer it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeEmailVerificationChallengeHandler,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import {
  createContext,
  mocks,
  mockStart,
  readJson,
  resetHarness,
  versionRow,
} from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

const evpRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      {
        id: 'email-verify:step',
        source_node_id: 'email-verify',
        component: 'email_verification',
        render: true,
      },
      { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
    ],
  },
};
const evpEditor = {
  nodes: [
    { id: 'auth', type: 'authentication' },
    { id: 'email-verify', type: 'email_verification' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'e1', source: 'auth', target: 'email-verify', source_handle: 'mail_otp' },
    { id: 'e2', source: 'email-verify', target: 'complete', source_handle: 'verified' },
  ],
};

let signed: { contract_hash: string; signature: string; expires_at: number };

beforeEach(async () => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
  if (!signed) {
    mockStart(evpRuntime, evpEditor);
    const data = await readJson(
      await loginRuntimeInteractionStartHandler(createContext({ body: { flow_kind: 'login' } }))
    );
    const interaction = data.interaction as { expires_at: number };
    signed = {
      contract_hash: String(data.contract_hash),
      signature: String(data.signature),
      expires_at: interaction.expires_at,
    };
    resetHarness();
  }
});

/** The origin the email verification challenge expects, for a request with these headers. */
async function expectedOrigin(
  headers: Record<string, string>,
  url = 'https://api.example.com/api/v1/login/interactions/interaction_1/email-verification/challenge'
): Promise<unknown> {
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce({
      id: 'interaction_1',
      flow_id: 'flow_login',
      flow_version_id: 'fv_1',
      user_id: null,
      client_id: null,
      saml_sp_id: null,
      state: 'active',
      current_node_id: 'auth',
      current_step_id: 'auth:step',
      context_json: JSON.stringify({ protocol: 'direct', target_type: 'tenant', locale: 'en' }),
      contract_hash: signed.contract_hash,
      signature: signed.signature,
      expires_at: signed.expires_at,
    })
    .mockResolvedValueOnce(versionRow(evpRuntime, evpEditor));
  const response = await loginRuntimeEmailVerificationChallengeHandler(
    createContext({
      params: { interaction_id: 'interaction_1' },
      url,
      headers,
      body: {
        step_id: 'auth:step',
        contract_hash: signed.contract_hash,
        signature: signed.signature,
      },
    })
  );
  expect((await readJson(response)).available).toBe(true);
  const stored = mocks.challengeStore.storeChallengeRpc.mock.calls.at(-1)?.[0] as {
    metadata: { expected_origin: unknown };
  };
  return stored.metadata.expected_origin;
}

describe('the origin of a request', () => {
  it('is the origin the browser sends, without its path', async () => {
    expect(await expectedOrigin({ origin: 'https://login.example.com/some/path' })).toBe(
      'https://login.example.com'
    );
  });

  it('is the origin of the request URL without an Origin, or with one that is not a URL', async () => {
    expect(await expectedOrigin({})).toBe('https://api.example.com');
    expect(await expectedOrigin({ origin: 'not a url' })).toBe('https://api.example.com');
  });

  it('is the local fallback when the request URL cannot be read', async () => {
    expect(await expectedOrigin({}, 'not a url')).toBe('https://authrim.local');
  });
});

describe('the origin of a request relayed by the Login UI', () => {
  const relayed = (headers: Record<string, string>) => ({
    'x-authrim-ui-proxy': 'login-ui',
    'x-authrim-browser-origin': 'https://browser.example.test/page',
    ...headers,
  });

  it('is the browser origin it relays when the relay itself comes from this origin', async () => {
    expect(await expectedOrigin(relayed({ origin: 'https://api.example.com' }))).toBe(
      'https://browser.example.test'
    );
  });

  it.each(['https', 'http'])(
    'is the browser origin when the relay comes from the forwarded host over %s',
    async (scheme) => {
      expect(
        await expectedOrigin(
          relayed({
            origin: `${scheme}://proxy.example.test`,
            'x-authrim-forwarded-host': ' proxy.example.test , other.example.test',
          })
        )
      ).toBe('https://browser.example.test');
    }
  );

  it('is not the relayed browser origin when the relay comes from elsewhere', async () => {
    expect(
      await expectedOrigin(
        relayed({
          origin: 'https://evil.example.test',
          'x-authrim-forwarded-host': 'proxy.example.test',
        })
      )
    ).toBe('https://evil.example.test');
    // A forwarded host trusts only itself, not the browser origin the relay names.
    expect(
      await expectedOrigin(
        relayed({ origin: 'https://other.example.test', 'x-authrim-forwarded-host': '' })
      )
    ).toBe('https://other.example.test');
  });

  it('is not the relayed browser origin without the Login UI relay header', async () => {
    expect(
      await expectedOrigin(
        relayed({ 'x-authrim-ui-proxy': 'other', origin: 'https://login.example.com' })
      )
    ).toBe('https://login.example.com');
  });

  it('is the request origin when the relay names no origin of its own', async () => {
    expect(await expectedOrigin({ 'x-authrim-ui-proxy': 'login-ui' })).toBe(
      'https://api.example.com'
    );
    expect(
      await expectedOrigin({
        'x-authrim-ui-proxy': 'login-ui',
        'x-authrim-browser-origin': 'https://browser.example.test',
      })
    ).toBe('https://api.example.com');
  });

  it('falls back to the Origin header when the relayed browser origin is not a URL', async () => {
    expect(
      await expectedOrigin(
        relayed({
          'x-authrim-browser-origin': 'not a url',
          origin: 'https://api.example.com/path',
        })
      )
    ).toBe('https://api.example.com');
  });
});

describe('the current step of the interaction', () => {
  it.each([
    ['a step the Flow does not have', 'gone:step', 'auth'],
    ['a step on another node', 'auth:step', 'other'],
  ])('is not found for %s', async (_label, stepId, nodeId) => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: null,
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: nodeId,
        current_step_id: stepId,
        context_json: null,
        contract_hash: signed.contract_hash,
        signature: signed.signature,
        expires_at: signed.expires_at,
      })
      .mockResolvedValueOnce(versionRow(evpRuntime, evpEditor));
    const response = await loginRuntimeEmailVerificationChallengeHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: { step_id: stepId, contract_hash: signed.contract_hash, signature: signed.signature },
      })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toBe('flow_runtime_invalid');
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });
});
