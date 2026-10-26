import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { Script, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  assertPasskeyOnlySamlFlowReady,
  assertPasskeyOnlySamlRuntimeProfile,
} from './passkey-flow-profile';
import { renderAwsPasskeyLoginPage } from './passkey-login';

const runtime = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'entry:step',
        source_node_id: 'entry',
        component: 'interaction_context',
        render: false,
      },
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
        config: { output_handles: ['passkey'] },
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
      },
    ],
  },
};

const editor = {
  nodes: [{ id: 'entry' }, { id: 'auth' }, { id: 'complete' }],
  edges: [
    { source: 'entry', target: 'auth', source_handle: 'next' },
    { source: 'auth', target: 'complete', source_handle: 'passkey' },
  ],
};

function testDb(
  options: {
    specific?: boolean;
    snapshot?: unknown;
    editor?: unknown;
    client?: unknown;
    origin?: string | null;
  } = {}
): Pick<DatabaseAdapter, 'queryOne'> & { calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("a.target_type = 'saml_sp'")) {
      return options.specific === false ? null : { flow_id: 'flow-1', published_version_id: 'v-1' };
    }
    if (sql.includes("a.target_type = 'tenant'")) {
      return { flow_id: 'flow-1', published_version_id: 'v-1' };
    }
    if (sql.includes('FROM flow_versions')) {
      return {
        runtime_snapshot_json: JSON.stringify(options.snapshot ?? runtime),
        editor_snapshot_json: JSON.stringify(options.editor ?? editor),
      };
    }
    if (sql.includes('FROM oauth_clients')) {
      return options.client === undefined
        ? {
            client_id: 'login-ui',
            application_type: 'web',
            allowed_channels: '["browser"]',
            client_secret_hash: null,
          }
        : options.client;
    }
    if (sql.includes('FROM web_origin_registry')) {
      return options.origin === undefined
        ? { origin: 'https://login.example.test' }
        : options.origin === null
          ? null
          : { origin: options.origin };
    }
    throw new Error('unexpected_query');
  });
  return { queryOne: calls as unknown as DatabaseAdapter['queryOne'], calls };
}

describe('AWS SAML passkey Flow admission', () => {
  it('accepts only an explicit passkey selector and completion', () => {
    expect(() => assertPasskeyOnlySamlRuntimeProfile(runtime)).not.toThrow();
    const wrongHandle = structuredClone(runtime);
    wrongHandle.ui.steps[1].config = { output_handles: ['passkey', 'mail_otp'] };
    expect(() => assertPasskeyOnlySamlRuntimeProfile(wrongHandle)).toThrow(
      'aws_login_flow_profile_unsupported'
    );
    const consent = structuredClone(runtime) as { ui: { steps: Record<string, unknown>[] } };
    consent.ui.steps.splice(2, 0, { component: 'consent_policy', render: true });
    expect(() => assertPasskeyOnlySamlRuntimeProfile(consent)).toThrow(
      'aws_login_flow_profile_unsupported'
    );
    const customScreen = structuredClone(runtime) as { ui: { steps: Record<string, unknown>[] } };
    customScreen.ui.steps[1].config = { output_handles: ['passkey'], screen_ref: 'custom' };
    expect(() => assertPasskeyOnlySamlRuntimeProfile(customScreen)).toThrow(
      'aws_login_flow_profile_unsupported'
    );
  });

  it('checks the published SAML assignment and browser login client', async () => {
    const db = testDb({ specific: false });
    await expect(
      assertPasskeyOnlySamlFlowReady(
        db,
        'tenant-a',
        ['https://sp.example.test'],
        'https://login.example.test'
      )
    ).resolves.toBeUndefined();
    expect(db.calls).toHaveBeenCalledWith(expect.stringContaining("a.target_type = 'saml_sp'"), [
      'tenant-a',
      'https://sp.example.test',
    ]);
    expect(db.calls).toHaveBeenCalledWith(expect.stringContaining("a.target_type = 'tenant'"), [
      'tenant-a',
    ]);
    expect(db.calls).toHaveBeenCalledWith(expect.stringContaining('FROM oauth_clients'), [
      'tenant-a',
      'login-ui',
    ]);
    expect(db.calls).toHaveBeenCalledWith(expect.stringContaining('FROM web_origin_registry'), [
      'tenant-a',
      'login-ui',
      'https://login.example.test',
    ]);
  });

  it('rejects a confidential browser client before checking its origin', async () => {
    const db = testDb({
      client: {
        client_id: 'login-ui',
        application_type: 'web',
        allowed_channels: '["browser"]',
        client_secret_hash: 'synthetic-confidential-client-hash',
      },
    });
    await expect(
      assertPasskeyOnlySamlFlowReady(db, 'tenant-a', ['sp-a'], 'https://login.example.test')
    ).rejects.toThrow('aws_login_client_unavailable');
    expect(db.calls).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM web_origin_registry'),
      expect.anything()
    );
  });

  it('rejects an unsupported branch and a non-web client', async () => {
    const branch = structuredClone(editor);
    branch.edges[1].source_handle = 'mail_otp';
    await expect(
      assertPasskeyOnlySamlFlowReady(
        testDb({ editor: branch }),
        'tenant-a',
        ['sp-a'],
        'https://login.example.test'
      )
    ).rejects.toThrow('aws_login_flow_profile_unsupported');
    branch.edges[1].source_handle = undefined as unknown as string;
    await expect(
      assertPasskeyOnlySamlFlowReady(
        testDb({ editor: branch }),
        'tenant-a',
        ['sp-a'],
        'https://login.example.test'
      )
    ).rejects.toThrow('aws_login_flow_profile_unsupported');
    await expect(
      assertPasskeyOnlySamlFlowReady(
        testDb({
          client: {
            client_id: 'login-ui',
            application_type: 'native',
            allowed_channels: '["browser"]',
            client_secret_hash: null,
          },
        }),
        'tenant-a',
        ['sp-a'],
        'https://login.example.test'
      )
    ).rejects.toThrow('aws_login_client_unavailable');
    await expect(
      assertPasskeyOnlySamlFlowReady(
        testDb({ origin: null }),
        'tenant-a',
        ['sp-a'],
        'https://login.example.test'
      )
    ).rejects.toThrow('aws_login_origin_unavailable');
  });
});

describe('AWS same-origin SAML sign-in page', () => {
  const valid =
    'https://login.example.test/login?saml_request_id=request-1&saml_sp_entity_id=https%3A%2F%2Fsp.example.test&return_to=saml_sso';

  it('rejects missing SAML context and reauthentication without a challenge', () => {
    expect(renderAwsPasskeyLoginPage(new Request('https://login.example.test/login')).status).toBe(
      400
    );
    expect(
      renderAwsPasskeyLoginPage(new Request(valid.replace('/login?', '/reauth?'))).status
    ).toBe(400);
  });

  it('serves a syntax-valid same-origin script with a matching CSP hash', async () => {
    const response = renderAwsPasskeyLoginPage(new Request(valid));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    if (!script) throw new Error('script_missing');
    expect(() => new Script(script)).not.toThrow();
    const hash = createHash('sha256').update(script).digest('base64');
    expect(response.headers.get('Content-Security-Policy')).toContain(`'sha256-${hash}'`);
    expect(html).toContain('data-client-id="login-ui"');
    expect(html).not.toContain('https://sp.example.test');
  });

  it('runs the configured Flow, verifies a passkey, creates a session, and resumes only the bound SAML request', async () => {
    const html = await renderAwsPasskeyLoginPage(new Request(valid)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('script_missing');
    const requests: Array<{
      path: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const redirects: string[] = [];
    const button = {
      disabled: true,
      onClick: null as null | (() => Promise<void>),
      addEventListener(_event: string, handler: () => Promise<void>) {
        this.onClick = handler;
      },
    };
    const status = { textContent: '' };
    const assertion = {
      id: 'credential-1',
      rawId: Uint8Array.from([1, 2, 3]).buffer,
      type: 'public-key',
      response: {
        authenticatorData: Uint8Array.from([4, 5]).buffer,
        clientDataJSON: Uint8Array.from([6, 7]).buffer,
        signature: Uint8Array.from([8, 9]).buffer,
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    };
    const responses = [
      {
        interaction: { id: 'interaction-1', state: 'active', current_step_id: 'auth:step' },
        contract: {
          flow_kind: 'login',
          ui: {
            steps: [
              {
                id: 'auth:step',
                source_node_id: 'auth',
                component: 'authentication_method_selector',
                render: true,
                config: { output_handles: ['passkey'] },
                content: { authentication_profile: { id: 'default', output_handles: ['passkey'] } },
              },
              {
                id: 'complete:step',
                source_node_id: 'complete',
                component: 'completion',
                render: true,
              },
            ],
          },
        },
        contract_hash: 'hash-1',
        signature: 'signature-1',
      },
      {
        challenge_id: 'challenge-1',
        options: { challenge: 'Y2hhbGxlbmdl', rpId: 'login.example.test', allowCredentials: [] },
      },
      { direct_auth_artifact: 'artifact-1' },
      { ok: true },
      {
        interaction: { id: 'interaction-1', state: 'active', current_step_id: 'complete:step' },
        completed: false,
        step: { id: 'complete:step', source_node_id: 'complete', component: 'completion' },
      },
      {
        interaction: { id: 'interaction-1', state: 'completed', current_step_id: null },
        completed: true,
        output: {
          protocol_continuation: {
            protocol: 'saml',
            saml_request_id: 'request-1',
            saml_sp_entity_id: 'https://sp.example.test',
          },
        },
      },
    ];
    runInNewContext(script, {
      document: {
        getElementById: (id: string) => (id === 'sign-in' ? button : status),
        documentElement: { dataset: { clientId: 'login-ui' } },
      },
      location: {
        search: new URL(valid).search,
        pathname: '/login',
        origin: 'https://login.example.test',
        assign: (destination: string) => redirects.push(destination),
      },
      navigator: { credentials: { get: vi.fn(async () => assertion) } },
      crypto: webcrypto,
      TextEncoder,
      URL,
      URLSearchParams,
      Uint8Array,
      btoa,
      atob,
      fetch: vi.fn(async (path: string, init: RequestInit) => {
        requests.push({
          path,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
          headers: init.headers as Record<string, string>,
        });
        return Response.json(responses.shift());
      }),
    });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    await button.onClick?.();
    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/login/interactions/start',
      '/api/v1/auth/direct/passkey/login/start',
      '/api/v1/auth/direct/passkey/login/finish',
      '/api/v1/auth/direct/session',
      '/api/v1/login/interactions/interaction-1/submit',
      '/api/v1/login/interactions/interaction-1/submit',
    ]);
    expect(requests[1].headers['X-Authrim-Interaction-Id']).toBe('interaction-1');
    const codeVerifier = requests[2].body.code_verifier as string;
    expect(requests[1].body.code_challenge).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url')
    );
    expect(requests[3].body).toMatchObject({
      direct_auth_artifact: 'artifact-1',
      defer_authorization_continuation: true,
    });
    expect(redirects).toEqual([
      'https://login.example.test/saml/idp/sso?saml_request_id=request-1&saml_sp_entity_id=https%3A%2F%2Fsp.example.test&return_to=saml_sso',
    ]);
  });
});
