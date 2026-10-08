/**
 * The sign-in sequence the Login UI runs, through the real handlers.
 *
 * Email code:
 *   interactions/start -> email-code/send -> interactions/<id>/submit (the method selection; the
 *   completion waits) -> email-code/verify -> direct/session (the session finish, the
 *   authorization continuation deferred) -> interactions/start (resume) -> interactions/<id>/submit
 *   (the completion, now with a session) -> the authorization continuation
 *
 * External provider:
 *   interactions/start -> interactions/<id>/submit (the provider chosen; the completion waits) ->
 *   [the provider's round trip ends with a new session cookie, as the bridge and the handoff
 *   finalize leave it] -> interactions/start (resume) -> interactions/<id>/submit (the completion)
 *
 * Nothing between the browser and the stores is mocked on the authorization path: the Flow is the
 * default login Flow the core migrations seed (the method selection leads straight to the
 * completion), its tables are a real SQLite database built from those migrations, the challenge
 * store is the real ChallengeStore Durable Object (one-time consumption included) over in-memory
 * storage, and the session store, the user store and the mail delivery are small in-memory fakes.
 * The authorization challenge is stored the way authorize stores it (an SSO-off client adds
 * fresh_sign_in_after).
 *
 * The Login UI's own order is replayed: it chooses the method before the sign-in, defers the
 * authorization continuation while the interaction is open, and after the sign-in resumes the
 * interaction and submits what is left (a screen, the completion).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertDestinationFieldConsentRecord,
  insertFlowConsentRecords,
} from '../login-runtime-flow';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { ChallengeStore } from '../../../ar-lib-core/dist/durable-objects/ChallengeStore';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';

const TENANT = 'default';
const ORIGIN = 'https://app.example.com';
const CLIENT_ID = 'web-client';
const EMAIL = 'user@example.com';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  };
};

const world = vi.hoisted(() => ({
  db: undefined as unknown,
  challenges: undefined as unknown,
  sessions: new Map<string, Record<string, unknown>>(),
  sessionStore: undefined as unknown,
  mail: [] as Array<{ to: string; text: string }>,
  rateLimiter: { incrementRpc: async () => ({ allowed: true }) },
  /** The next transaction of the core database fails (a database that is not there just then). */
  failNextTransaction: false,
  /** Writing an audit event fails. */
  failAudit: false,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const user = {
    id: 'user_existing',
    account_type: 'user',
    active: 1,
    email: 'user@example.com',
    name: 'Example User',
    email_verified: 1,
    phone_number_verified: 0,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
    last_login_at: null,
  };
  const authContext = () => ({
    coreAdapter: world.db,
    repositories: { userCore: { findById: async () => ({ id: user.id, is_active: true }) } },
  });
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        return userId === user.id ? user : null;
      }
      async findByEmail(email: string) {
        return email === user.email ? user : null;
      }
      async findForOtpLogin(userId: string, trustedEmail: string) {
        return userId === user.id ? { ...user, email: trustedEmail.toLowerCase() } : null;
      }
      async findAccountAuthenticationState(userId: string) {
        return { userId, accountType: 'user', lifecycle: 'active', sourceVersionMs: 1_000 };
      }
      async markEmailVerified() {
        return true;
      }
      async markEmailVerifiedAndTouchLastLogin() {
        return true;
      }
      async touchLastLogin() {
        return true;
      }
    },
    assertGuestCredentialAuthenticationAllowed: vi.fn(async () => undefined),
    ensureAccountAuthenticationState: vi.fn(async (_env, _tenant, _user, loader) => loader()),
    getTenantIdFromContext: vi.fn(() => TENANT),
    getDefaultTenantId: vi.fn(() => TENANT),
    getTenantSettingsDocument: vi.fn(async () => null),
    resolveTenantFromEmailDomain: vi.fn(async () => null),
    getClient: vi.fn(async () => ({
      client_id: CLIENT_ID,
      application_type: 'web',
      allowed_redirect_origins: [ORIGIN],
    })),
    getWebOriginRegistry: vi.fn(async () => ({
      origins: [{ origin: ORIGIN, handoff_allowed: true }],
    })),
    createAuthContextFromHono: vi.fn(authContext),
    createAccountAuthContextFromHono: vi.fn(authContext),
    createPIIContextFromHono: vi.fn(() => ({ piiRepositories: { userPII: {} } })),
    hasPIIDatabase: vi.fn(() => true),
    getFeatureFlag: vi.fn(
      (_key: string, env: { ENABLE_LOGIN_RUNTIME_FLOW?: string }) =>
        env.ENABLE_LOGIN_RUNTIME_FLOW === 'true'
    ),
    getChallengeStoreByChallengeId: vi.fn(async () => world.challenges),
    getChallengeStoreByUserId: vi.fn(async () => world.challenges),
    isShardedSessionId: vi.fn((id: string) => /^\d+_session_/.test(id)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: world.sessionStore })),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: world.sessionStore,
      sessionId: `0_session_${crypto.randomUUID()}`,
      resolution: {},
      instanceName: 'session-store',
    })),
    generateBrowserState: vi.fn(async () => 'browser-state'),
    getRequiredPluginContext: vi.fn(() => ({
      registry: { getNotifier: () => ({ send: async () => ({ success: true }) }) },
    })),
    produceNotificationDelivery: vi.fn(
      async (
        _env,
        input: {
          payload: { to: string; body?: string; metadata?: { textBody?: string } };
        }
      ) => {
        world.mail.push({
          to: input.payload.to,
          text: input.payload.metadata?.textBody ?? input.payload.body ?? '',
        });
        return { reference: {}, bindingRef: 'TDB_SHARED_CORE', delivery: 'delivered' };
      }
    ),
    publishEvent: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    })),
  };
});

vi.mock('../registration-field-utils', () => ({
  buildCanonicalProfileRuntimeUserFields: () => ({ piiFields: {}, sensitiveValues: {} }),
  validateRegistrationFieldSubmissionFromEnv: vi.fn(async () => ({ ok: true, values: {} })),
  persistRegistrationFieldValuesFromEnv: vi.fn(async () => undefined),
}));

vi.mock('../human-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../human-verification')>()),
  verifyHumanVerificationForAction: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------------------------

function memoryDurableObjectState() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      delete: async (key: string) => storage.delete(key),
      list: async () => new Map(storage),
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
}

function createSessionStore() {
  return {
    async createSessionRpc(
      sessionId: string,
      userId: string,
      ttlSeconds: number,
      data: Record<string, unknown> | undefined,
      tenantId: string
    ) {
      const session = {
        id: sessionId,
        tenantId,
        userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlSeconds * 1000,
        data,
      };
      world.sessions.set(sessionId, session);
      return session;
    },
    async getSessionRpc(sessionId: string) {
      return world.sessions.get(sessionId) ?? null;
    },
  };
}

function createCoreDatabase(): DatabaseAdapter {
  const db = new DatabaseSync(':memory:');
  const folder = path.resolve(__dirname, '../../../../migrations/core/d1');
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(path.join(folder, file), 'utf8'), 'sqlite'));
  }
  const bind = (params: unknown[] = []) =>
    params.map((value) =>
      value === undefined ? null : typeof value === 'boolean' ? +value : value
    );
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...bind(params)) as unknown) ?? null,
    execute: async (sql: string, params?: unknown[]) => {
      if (world.failAudit && sql.includes('INSERT INTO flow_audit_events')) {
        throw new Error('audit store unavailable');
      }
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...bind(params)).changes),
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (world.failNextTransaction) {
        world.failNextTransaction = false;
        throw new Error('database unavailable');
      }
      return fn(adapter);
    },
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map((s) => ({
        success: true,
        rowsAffected: Number(db.prepare(s.sql).run(...bind(s.params)).changes),
      })),
    isHealthy: async () => true,
    getType: () => 'sqlite',
    close: async () => undefined,
  };
  return adapter as unknown as DatabaseAdapter;
}

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function createEnv(): Env {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-test-secret',
    ALLOWED_ORIGINS: ORIGIN,
    ENABLE_LOGIN_RUNTIME_FLOW: 'true',
    FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
    AUTHRIM_CONFIG: { get: async () => null },
    SETTINGS: {
      get: async (key: string) =>
        key === `settings:tenant:${TENANT}:authentication-methods`
          ? JSON.stringify({
              'authentication-methods.email_otp.login_enabled': true,
              'authentication-methods.email_otp.signup_enabled': true,
              'authentication-methods.email_otp.reauth_enabled': true,
            })
          : null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    RATE_LIMITER: { idFromName: () => 'rate-limit', get: () => world.rateLimiter },
    AUTH_CODE_STORE: {
      idFromName: () => 'auth-code',
      get: () => ({ storeCodeRpc: async () => undefined }),
    },
  } as unknown as Env;
}

async function s256(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

class Browser {
  cookies = new Map<string, string>();
  readonly env = createEnv();
  private readonly app = new Hono<{ Bindings: Env }>();
  /** Calls made, in order, as "METHOD /path -> status". */
  readonly calls: string[] = [];
  private readonly background: Array<Promise<unknown>> = [];

  constructor(
    handlers: typeof import('../login-runtime-flow'),
    direct: typeof import('../direct-auth')
  ) {
    this.app.post('/api/v1/login/interactions/start', handlers.loginRuntimeInteractionStartHandler);
    this.app.post(
      '/api/v1/login/interactions/:interaction_id/submit',
      handlers.loginRuntimeInteractionSubmitHandler
    );
    this.app.post('/api/v1/auth/direct/email-code/send', direct.directEmailCodeSendHandler);
    this.app.post('/api/v1/auth/direct/email-code/verify', direct.directEmailCodeVerifyHandler);
    this.app.post('/api/v1/auth/direct/session', direct.directSessionCreateHandler);
  }

  async post(
    pathname: string,
    body: Json
  ): Promise<{ status: number; json: Json; headers: Headers }> {
    const response = await this.app.request(
      `${ORIGIN}${pathname}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Host: 'app.example.com',
          'User-Agent': 'Vitest',
          ...(this.cookies.size
            ? {
                Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
              }
            : {}),
        },
        body: JSON.stringify(body),
      },
      this.env,
      {
        waitUntil: (promise: Promise<unknown>) => void this.background.push(promise),
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext
    );
    await Promise.allSettled(this.background.splice(0));
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, ...rest] = pair.split('=');
      this.cookies.set(name.trim(), rest.join('='));
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    this.calls.push(
      `POST ${pathname.replace(/interactions\/[^/]+\//, 'interactions/<id>/')} -> ${response.status}`
    );
    return { status: response.status, json, headers: response.headers };
  }

  get sessionCookie(): string | undefined {
    return this.cookies.get('authrim_session');
  }
}

/** What authorize stores for a request that needs a sign-in (and, for an SSO-off client, a new one). */
async function storeAuthorizationChallenge(options: {
  kind: 'login' | 'reauth';
  freshAfter?: number;
  clientId?: string;
  /** The issuer authorize recorded (the continuation is an address on it). */
  issuer?: string;
}): Promise<string> {
  const id = `authz_${crypto.randomUUID()}`;
  await (world.challenges as ChallengeStore).storeChallengeRpc({
    id,
    tenantId: TENANT,
    type: options.kind,
    userId: 'anonymous',
    challenge: id,
    ttl: 600,
    metadata: {
      client_id: options.clientId ?? CLIENT_ID,
      ...(options.issuer ? { issuer: options.issuer } : {}),
      redirect_uri: 'https://rp.example.com/callback',
      scope: 'openid profile',
      state: 'state_1',
      nonce: 'nonce_1',
      response_type: 'code',
      ...(options.kind === 'login' && options.freshAfter !== undefined
        ? { fresh_sign_in_after: options.freshAfter }
        : {}),
      ...(options.kind === 'reauth'
        ? {
            reauth_issued_at: options.freshAfter ?? Date.now(),
            sessionUserId: 'user_existing',
            purpose: 'reauth',
          }
        : {}),
    },
  });
  return id;
}

/** A session the browser already holds: made before `ageMs` ago, by `method`. */
function existingSession(ageMs: number, method = 'email_code', userId = 'user_existing'): string {
  const provenAt = Date.now() - ageMs;
  const id = `0_session_existing_${crypto.randomUUID()}`;
  world.sessions.set(id, {
    id,
    tenantId: TENANT,
    userId,
    createdAt: provenAt,
    expiresAt: Date.now() + 3_600_000,
    data: {
      amr: [method],
      authTime: Math.floor(provenAt / 1000),
      proven_at: provenAt,
    },
  });
  return id;
}

interface FlowSpec {
  id: string;
  kind: 'login' | 'registration';
  /** The steps after the entry and the session check, in the runtime contract's form. */
  steps: Array<Record<string, unknown>>;
  /** Editor edges as [source, handle, target]. */
  edges: Array<[string, string, string]>;
}

const OIDC_COMPLETION = {
  id: 'complete:step',
  source_node_id: 'complete',
  component: 'completion',
  render: true,
  config: {
    completion_block: {
      id: 'oidc-authorization-completion',
      protocol: 'oidc',
      purpose: 'authorization',
      role: 'output',
    },
  },
};
const AUTH_STEP = {
  id: 'auth:step',
  source_node_id: 'auth',
  component: 'authentication_method_selector',
  render: true,
};

/** A Flow of its own for one client (the seeded default Flows serve every other request). */
async function installFlow(clientId: string, spec: FlowSpec) {
  const runtime = {
    flow_kind: spec.kind,
    flow_id: spec.id,
    ui: {
      steps: [
        {
          id: 'request:step',
          source_node_id: 'request',
          component: 'interaction_context',
          render: false,
        },
        {
          id: 'session-check:step',
          source_node_id: 'session-check',
          component: 'session_check',
          render: false,
        },
        ...spec.steps,
      ],
    },
  };
  const nodeIds = ['request', 'session-check', ...spec.steps.map((step) => step.source_node_id)];
  const editor = {
    nodes: nodeIds.map((id) => ({ id, type: id === 'complete' ? 'complete' : 'step' })),
    edges: [
      ['request', 'next', 'session-check'],
      ['session-check', 'continue', 'complete'],
      ['session-check', 'authenticate', 'auth'],
      ...spec.edges,
    ].map(([source, handle, target]) => ({
      id: `${source}:${handle}->${target}`,
      source,
      source_handle: handle,
      target,
    })),
  };
  const db = world.db as DatabaseAdapter;
  const now = Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO flows (id, tenant_id, profile_id, name, graph_definition, created_at, updated_at,
                        kind, status, published_version_id)
     VALUES (?, ?, 'human-basic', ?, '{}', ?, ?, ?, 'published', ?)`,
    [spec.id, TENANT, spec.id, now, now, spec.kind, `${spec.id}-v1`]
  );
  await db.execute(
    `INSERT INTO flow_versions (id, tenant_id, flow_id, version_number, schema_version,
                                runtime_snapshot_json, editor_snapshot_json,
                                validation_result_json, published_at, created_at)
     VALUES (?, ?, ?, 1, 'authrim.login_ui.contract.v1', ?, ?,
             '{"valid":true,"errors":[],"warnings":[],"issues":[]}', ?, ?)`,
    [`${spec.id}-v1`, TENANT, spec.id, JSON.stringify(runtime), JSON.stringify(editor), now, now]
  );
  await db.execute(
    `INSERT INTO flow_assignments (id, tenant_id, target_type, target_id, flow_kind, flow_id,
                                   enabled, created_at, updated_at)
     VALUES (?, ?, 'oidc_client', ?, ?, ?, 1, ?, ?)`,
    [`assign-${spec.id}`, TENANT, clientId, spec.kind, spec.id, now, now]
  );
}

/** A consent policy with one required statement, to put on a method selection. */
async function installLoginConsentPolicy(options: { requirement?: 'required' | 'optional' } = {}) {
  const db = world.db as DatabaseAdapter;
  const now = Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO consent_policies (id, tenant_id, name, display_name, is_active, created_at, updated_at)
     VALUES ('policy_login', ?, 'login', 'Login consent', 1, ?, ?)`,
    [TENANT, now, now]
  );
  await db.execute(
    `INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
     VALUES ('statement_terms', ?, 'terms_of_service', 'terms_of_service', ?, ?)`,
    [TENANT, now, now]
  );
  await db.execute(
    `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
                                             is_current, status, created_at, updated_at)
     VALUES ('version_terms_1', ?, 'statement_terms', '20260701', ?, 1, 'active', ?, ?)`,
    [TENANT, now, now, now]
  );
  await db.execute(
    `INSERT INTO consent_statement_localizations (id, tenant_id, version_id, language, title,
                                                  description, document_url, created_at, updated_at)
     VALUES ('loc_terms_en', ?, 'version_terms_1', 'en', 'Terms', '', 'https://example.com/tos', ?, ?)`,
    [TENANT, now, now]
  );
  await db.execute(
    `INSERT INTO consent_policy_items (id, tenant_id, policy_id, statement_id, requirement,
                                       version_mode, checkbox_mode, binding_type, created_at, updated_at)
     VALUES ('item_terms', ?, 'policy_login', 'statement_terms', ?, 'current', ?,
             'subject', ?, ?)`,
    [TENANT, options.requirement ?? 'required', options.requirement ?? 'required', now, now]
  );
}

const TWO_STEP_FLOW: FlowSpec = {
  id: 'flow-two-step',
  kind: 'login',
  steps: [
    AUTH_STEP,
    {
      id: 'welcome:step',
      source_node_id: 'welcome',
      component: 'screen',
      render: true,
      config: {},
    },
    OIDC_COMPLETION,
  ],
  edges: [
    ['auth', 'mail_otp', 'welcome'],
    ['auth', 'facebook', 'welcome'],
    ['welcome', 'submitted', 'complete'],
  ],
};
const CONSENT_FLOW: FlowSpec = {
  id: 'flow-consent-selector',
  kind: 'login',
  steps: [
    {
      ...AUTH_STEP,
      config: { consent_policy_ref: 'policy_login' },
    },
    OIDC_COMPLETION,
  ],
  edges: [
    ['auth', 'mail_otp', 'complete'],
    ['auth', 'facebook', 'complete'],
  ],
};

interface Response_ {
  status: number;
  json: Json;
  headers?: Headers;
}
const stepsOf = (json: Json) =>
  (
    json.contract as {
      ui: { steps: Array<{ id: string; component: string; source_node_id: string }> };
    }
  ).ui.steps;
const redirectOf = (json: Json | undefined) => {
  const redirect = json?.redirect_url as string | undefined;
  return redirect && /_confirmation_challenge=/.test(redirect) ? redirect : undefined;
};

interface SignIn {
  start: Response_;
  interactionId: string;
  selection: Response_;
  /** The sign-in call (the session finish for an email code); none for a provider. */
  finish?: Response_;
  /** What the browser submits after the sign-in until the Flow is complete. */
  steps: Response_[];
  final?: Response_;
  /** The authorization continuation the Flow ended with. */
  continuation?: string;
}

async function startFlow(
  browser: Browser,
  options: { flowKind?: string; oidcClientId?: string; challengeId?: string; saml?: boolean }
): Promise<{ start: Response_; interaction: { id: string; state: string } }> {
  const start = await browser.post('/api/v1/login/interactions/start', {
    flow_kind: options.flowKind ?? 'login',
    ...(options.saml
      ? {
          saml_sp_id: 'sp_1',
          saml_request_id: 'req_1',
          saml_sp_entity_id: 'https://sp.example.com',
        }
      : { client_id: options.oidcClientId ?? CLIENT_ID }),
    ...(options.challengeId ? { authorization_challenge_id: options.challengeId } : {}),
  });
  expect(start.status).toBe(200);
  return { start, interaction: start.json.interaction as { id: string; state: string } };
}

/** The method is chosen on the interaction's current step (the selector). */
async function selectMethod(
  browser: Browser,
  start: Response_,
  handle: string,
  input?: Json
): Promise<Response_> {
  const interaction = start.json.interaction as { id: string; current_step_id: string };
  const step = stepsOf(start.json).find(
    (candidate) => candidate.id === interaction.current_step_id
  );
  expect(step?.component).toMatch(/method_selector$/);
  return browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
    step_id: step?.id as string,
    node_id: step?.source_node_id as string,
    selected_handle: handle,
    contract_hash: start.json.contract_hash as string,
    signature: start.json.signature as string,
    ...(input ? { input } : {}),
  });
}

/**
 * After the sign-in, the Login UI resumes the interaction and submits each step it is left with (a
 * screen, then the completion) until the Flow is complete.
 */
async function resumeAndComplete(
  browser: Browser,
  start: Response_,
  interactionId: string
): Promise<{ steps: Response_[]; final?: Response_; continuation?: string }> {
  let flow: Response_ = await browser.post('/api/v1/login/interactions/start', {
    resume_interaction_id: interactionId,
    contract_hash: start.json.contract_hash as string,
    signature: start.json.signature as string,
  });
  expect(flow.status).toBe(200);
  const steps: Response_[] = [];
  let current = (flow.json.interaction as { current_step_id: string | null }).current_step_id;
  for (let guard = 0; guard < 5 && current; guard += 1) {
    const step = stepsOf(flow.json).find((candidate) => candidate.id === current);
    if (!step) break;
    const submitted = await browser.post(`/api/v1/login/interactions/${interactionId}/submit`, {
      step_id: step.id,
      node_id: step.source_node_id,
      selected_handle: step.component === 'completion' ? 'completed' : 'submitted',
      contract_hash: start.json.contract_hash as string,
      signature: start.json.signature as string,
    });
    steps.push(submitted);
    if (submitted.status !== 200 || submitted.json.completed === true) {
      return {
        steps,
        final: submitted,
        continuation: redirectOf(submitted.json.output as Json | undefined),
      };
    }
    current = (submitted.json.interaction as { current_step_id: string | null }).current_step_id;
    flow = { status: 200, json: { ...flow.json, interaction: submitted.json.interaction } };
  }
  return { steps };
}

/**
 * The browser signs in by email code the way the Login UI does: start, send, choose the method,
 * verify, finish the session (the authorization continuation deferred while the interaction is
 * open), resume and submit what is left.
 */
async function signInByEmailCode(
  browser: Browser,
  options: {
    flowKind?: string;
    challengeId?: string;
    oidcClientId?: string;
    saml?: boolean;
    selectionInput?: Json;
  }
): Promise<SignIn> {
  const { start, interaction } = await startFlow(browser, options);
  const verifier = `verifier-${crypto.randomUUID()}`;
  const send = await browser.post('/api/v1/auth/direct/email-code/send', {
    client_id: CLIENT_ID,
    email: EMAIL,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    channel: 'browser',
    scope: 'openid email',
    ...(options.challengeId ? { authorization_challenge_id: options.challengeId } : {}),
    runtime_interaction_id: interaction.id,
  });
  expect(send.status).toBe(200);
  const code = world.mail.at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  expect(code).toBeDefined();

  const selection = await selectMethod(browser, start, 'mail_otp', options.selectionInput);
  const result: SignIn = { start, interactionId: interaction.id, selection, steps: [] };
  if (selection.status !== 200) return result;
  // The Flow waits at its completion (or a step before it): the interaction is carried to the
  // verification page and resumed after the code.
  expect(selection.json.completed).toBe(false);

  const verify = await browser.post('/api/v1/auth/direct/email-code/verify', {
    attempt_id: send.json.attempt_id as string,
    code: code as string,
    code_verifier: verifier,
    channel: 'browser',
  });
  expect(verify.status).toBe(200);
  result.finish = await browser.post('/api/v1/auth/direct/session', {
    direct_auth_artifact: verify.json.direct_auth_artifact as string,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    channel: 'browser',
    ...(options.challengeId ? { authorization_challenge_id: options.challengeId } : {}),
    defer_authorization_continuation: true,
  });
  expect(result.finish.status).toBe(200);
  Object.assign(result, await resumeAndComplete(browser, start, interaction.id));
  return result;
}

/**
 * The browser signs in through an external provider: the provider is chosen, the browser leaves
 * (the bridge's callback and the handoff finalize end with a new session cookie), then returns to
 * resume the interaction.
 */
async function signInByProvider(
  browser: Browser,
  options: {
    challengeId?: string;
    oidcClientId?: string;
    /** What the provider's login recorded in the session it gave (no proof time of its own). */
    sessionData?: Record<string, unknown>;
    selectionInput?: Json;
  }
): Promise<SignIn> {
  const { start, interaction } = await startFlow(browser, options);
  const selection = await selectMethod(browser, start, 'facebook', options.selectionInput);
  const result: SignIn = { start, interactionId: interaction.id, selection, steps: [] };
  expect(selection.status).toBe(200);
  expect(selection.json.completed).toBe(false);

  const sessionId = `0_session_external_${crypto.randomUUID()}`;
  world.sessions.set(sessionId, {
    id: sessionId,
    tenantId: TENANT,
    userId: 'user_existing',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    data: { amr: ['external_idp'], ...options.sessionData },
  });
  browser.cookies.set('authrim_session', sessionId);
  Object.assign(result, await resumeAndComplete(browser, start, interaction.id));
  return result;
}

describe('sign-in sequences through the real handlers', () => {
  let runtimeHandlers: typeof import('../login-runtime-flow');
  let directHandlers: typeof import('../direct-auth');

  beforeAll(async () => {
    runtimeHandlers = await import('../login-runtime-flow');
    directHandlers = await import('../direct-auth');
  }, 30_000);

  beforeEach(() => {
    world.db = createCoreDatabase();
    world.challenges = new ChallengeStore(memoryDurableObjectState() as never, {} as never);
    world.sessionStore = createSessionStore();
    world.sessions.clear();
    world.mail.length = 0;
    runtimeHandlers.clearLoginRuntimeFlowVersionCacheForTests();
  });

  const browserWith = (sessionId?: string) => {
    const browser = new Browser(runtimeHandlers, directHandlers);
    if (sessionId) browser.cookies.set('authrim_session', sessionId);
    return browser;
  };

  /** Whether the authorization challenge has been used up (looking does not use it). */
  const challengeIsUsedUp = async (challengeId: string) => {
    const challenge = (await (world.challenges as ChallengeStore).getChallengeRpc(challengeId)) as {
      consumed?: boolean;
    } | null;
    return !challenge || challenge.consumed === true;
  };
  const failures = (browser: Browser) => browser.calls.filter((call) => /-> [45]\d\d$/.test(call));

  describe.each([
    ['the default Flow (the selection leads to the completion)', undefined, undefined, undefined],
    ['a Flow with a screen after the selection', 'two-step-client', TWO_STEP_FLOW, undefined],
    [
      'a Flow with a consent on the selection',
      'consent-client',
      CONSENT_FLOW,
      { consent_item_decisions: { statement_terms: 'granted' } },
    ],
  ])('%s', (_name, flowClient, flowSpec, selectionInput) => {
    const oidcClientId = flowClient ?? CLIENT_ID;
    beforeEach(async () => {
      if (flowSpec) {
        if (flowSpec === CONSENT_FLOW) await installLoginConsentPolicy();
        await installFlow(oidcClientId, flowSpec);
      }
    });

    it.each([
      ['SSO off, with a session made earlier', true, true],
      ['SSO off, without a session', true, false],
      ['SSO on, without a session', false, false],
    ])('email code, /authorize: %s', async (_label, ssoOff, hasSession) => {
      const sessionId = hasSession ? existingSession(60_000) : undefined;
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: ssoOff ? Date.now() : undefined,
        clientId: oidcClientId,
      });
      const browser = browserWith(sessionId);

      const result = await signInByEmailCode(browser, {
        challengeId,
        oidcClientId,
        selectionInput,
      });

      expect(result.selection.status).toBe(200);
      expect(result.finish?.status).toBe(200);
      // The session finish deferred the continuation: the Flow's completion gives it.
      expect(redirectOf(result.finish?.json)).toBeUndefined();
      expect(result.final?.status).toBe(200);
      expect(result.continuation).toBeDefined();
      expect(browser.sessionCookie).toBeDefined();
      expect(browser.sessionCookie).not.toBe(sessionId);
      expect(await challengeIsUsedUp(challengeId)).toBe(true);
      expect(failures(browser)).toEqual([]);
    });

    it('email code, /authorize for a re-authentication, with a session made earlier', async () => {
      const sessionId = existingSession(60_000);
      const challengeId = await storeAuthorizationChallenge({
        kind: 'reauth',
        clientId: oidcClientId,
      });
      const browser = browserWith(sessionId);

      const result = await signInByEmailCode(browser, {
        challengeId,
        oidcClientId,
        selectionInput,
      });

      expect(result.selection.status).toBe(200);
      expect(result.continuation).toBeDefined();
      expect(browser.sessionCookie).not.toBe(sessionId);
      expect(await challengeIsUsedUp(challengeId)).toBe(true);
    });

    it('email code, /login opened directly, without a session', async () => {
      const browser = browserWith();

      const result = await signInByEmailCode(browser, { oidcClientId, selectionInput });

      expect(result.selection.status).toBe(200);
      expect(result.final?.status).toBe(200);
      expect(result.final?.json.completed).toBe(true);
      expect(result.final?.json.output).toMatchObject({ action: expect.any(String) });
      expect(browser.sessionCookie).toBeDefined();
      expect(failures(browser)).toEqual([]);
    });

    it.each([
      ['SSO off, with a session made earlier', true, true],
      ['SSO off, without a session', true, false],
    ])('external provider, /authorize: %s', async (_label, _ssoOff, hasSession) => {
      const sessionId = hasSession ? existingSession(60_000) : undefined;
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: oidcClientId,
      });
      const browser = browserWith(sessionId);

      const result = await signInByProvider(browser, {
        challengeId,
        oidcClientId,
        selectionInput,
      });

      expect(result.final?.status).toBe(200);
      expect(result.continuation).toBeDefined();
      expect(browser.sessionCookie).not.toBe(sessionId);
      expect(await challengeIsUsedUp(challengeId)).toBe(true);
    });
  });

  it('answers a completion submitted before anyone has signed in, and the sign-in still completes', async () => {
    const challengeId = await storeAuthorizationChallenge({
      kind: 'login',
      freshAfter: Date.now(),
    });
    const browser = browserWith(existingSession(60_000));
    const { start, interaction } = await startFlow(browser, { challengeId });
    const selection = await selectMethod(browser, start, 'mail_otp');
    expect(selection.json.completed).toBe(false);

    // Neither no session nor the older one lets the completion through.
    const attempt = await resumeAndComplete(browser, start, interaction.id);
    expect(attempt.final?.status).toBe(401);
    expect(attempt.final?.json).toMatchObject({ error: 'authentication_required' });
    expect(await challengeIsUsedUp(challengeId)).toBe(false);

    // The interaction is still there for the sign-in that follows.
    browser.cookies.set(
      'authrim_session',
      (() => {
        const id = `0_session_signed_in_${crypto.randomUUID()}`;
        world.sessions.set(id, {
          id,
          tenantId: TENANT,
          userId: 'user_existing',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
          data: {
            amr: ['email_code'],
            authTime: Math.floor(Date.now() / 1000),
            proven_at: Date.now(),
          },
        });
        return id;
      })()
    );
    const done = await resumeAndComplete(browser, start, interaction.id);
    expect(done.final?.status).toBe(200);
    expect(done.continuation).toBeDefined();
    expect(await challengeIsUsedUp(challengeId)).toBe(true);
  });

  it('/authorize with SSO on: an earlier session answers the Flow without any sign-in', async () => {
    const sessionId = existingSession(60_000);
    const challengeId = await storeAuthorizationChallenge({ kind: 'login' });
    const browser = browserWith(sessionId);
    const { start } = await startFlow(browser, { challengeId });
    const interaction = start.json.interaction as { id: string; current_step_id: string };
    const current = stepsOf(start.json).find((step) => step.id === interaction.current_step_id);
    expect(current?.component).toBe('completion');

    const done = await resumeAndComplete(browser, start, interaction.id);

    expect(done.final?.status).toBe(200);
    expect(done.continuation).toBeDefined();
    expect(await challengeIsUsedUp(challengeId)).toBe(true);
  });

  it('/login opened directly with a session made earlier offers no method', async () => {
    const browser = browserWith(existingSession(60_000));
    const { start } = await startFlow(browser, {});
    const interaction = start.json.interaction as { current_step_id: string };
    const current = stepsOf(start.json).find((step) => step.id === interaction.current_step_id);

    expect(current?.component).toBe('completion');
  });

  describe('a registration Flow (the method, an account action, the completion)', () => {
    it('keeps the completion waiting past the account action, then completes after the code', async () => {
      const browser = browserWith();

      const result = await signInByEmailCode(browser, { flowKind: 'registration' });

      expect(result.selection.status).toBe(200);
      expect(result.selection.json.completed).toBe(false);
      expect(result.selection.json.step).toMatchObject({ component: 'completion' });
      expect(result.final?.status).toBe(200);
      expect(result.final?.json.completed).toBe(true);
      expect(browser.sessionCookie).toBeDefined();
      expect(failures(browser)).toEqual([]);
    });

    it('does not complete for a browser that has not signed in', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { flowKind: 'registration' });
      await selectMethod(browser, start, 'mail_otp');

      const attempt = await resumeAndComplete(browser, start, interaction.id);

      expect(attempt.final?.status).toBe(401);
    });
  });

  describe('a SAML request', () => {
    it('completes with the SAML continuation after the code, not before', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { saml: true });
      const selection = await selectMethod(browser, start, 'mail_otp');
      expect(selection.json.completed).toBe(false);
      const before = await resumeAndComplete(browser, start, interaction.id);
      expect(before.final?.status).toBe(401);

      const signedIn = await signInByEmailCode(browserWith(), { saml: true });

      expect(signedIn.final?.status).toBe(200);
      expect(signedIn.final?.json.output).toMatchObject({
        action: 'continue_protocol',
        protocol_continuation: { protocol: 'saml' },
      });
    });
  });

  describe('consent given at the method selection', () => {
    const consentRows = async () =>
      (await (world.db as DatabaseAdapter).query(
        'SELECT subject_user_id, statement_id, decision FROM consent_records'
      )) as Array<{ subject_user_id: string; statement_id: string; decision: string }>;

    beforeEach(async () => {
      await installLoginConsentPolicy();
      await installFlow('consent-client', CONSENT_FLOW);
    });

    it('is refused when a required statement is not given', async () => {
      const browser = browserWith();
      const { start } = await startFlow(browser, { oidcClientId: 'consent-client' });

      const selection = await selectMethod(browser, start, 'mail_otp', {
        consent_item_decisions: {},
      });

      expect(selection.status).toBe(400);
      expect(selection.json.error).toBe('consent_required');
    });

    it('is recorded once, for the user who signs in, and for no one before', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: 'consent-client',
      });
      const browser = browserWith(existingSession(60_000));

      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-client',
        challengeId,
      });
      await selectMethod(browser, start, 'mail_otp', {
        consent_item_decisions: { statement_terms: 'granted' },
      });
      // Held: nothing is recorded while no one is signed in (not for the older session's user).
      expect(await consentRows()).toEqual([]);

      browser.cookies.set('authrim_session', existingSession(0));
      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(200);
      expect(await consentRows()).toEqual([
        { subject_user_id: 'user_existing', statement_id: 'statement_terms', decision: 'accepted' },
      ]);
    });
  });

  describe('consent held across the sign-in, in the harder cases', () => {
    const CONSENT_SCREEN_FLOW: FlowSpec = {
      id: 'flow-consent-screen',
      kind: 'login',
      steps: [
        { ...AUTH_STEP, config: { consent_policy_ref: 'policy_login' } },
        {
          id: 'welcome:step',
          source_node_id: 'welcome',
          component: 'screen',
          render: true,
          config: {},
        },
        OIDC_COMPLETION,
      ],
      edges: [
        ['auth', 'mail_otp', 'welcome'],
        ['welcome', 'submitted', 'complete'],
      ],
    };
    const given = { consent_item_decisions: { statement_terms: 'granted' } };
    const consentRows = async () =>
      (await (world.db as DatabaseAdapter).query(
        'SELECT subject_user_id, statement_id, statement_version, decision FROM consent_records'
      )) as Array<{ subject_user_id: string; statement_version: string }>;
    const signedIn = (userId = 'user_existing') => existingSession(-50, 'email_code', userId);

    beforeEach(async () => {
      await installLoginConsentPolicy();
      await installFlow('consent-client', CONSENT_FLOW);
      await installFlow('consent-screen-client', CONSENT_SCREEN_FLOW);
    });

    it('is recorded when the Flow ends from a step after the selection, not only from the completion', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: 'consent-screen-client',
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-screen-client',
        challengeId,
      });
      await selectMethod(browser, start, 'mail_otp', given);
      browser.cookies.set('authrim_session', signedIn());

      // The screen is submitted with a session: the Flow ends in the same request.
      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(200);
      expect(done.steps).toHaveLength(1);
      expect(done.continuation).toBeDefined();
      expect(await consentRows()).toHaveLength(1);
    });

    it('is recorded in the version it was given for; a newer version is asked for again', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: 'consent-client',
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-client',
        challengeId,
      });
      await selectMethod(browser, start, 'mail_otp', given);

      // While the sign-in is under way the statement gets a newer version.
      const db = world.db as DatabaseAdapter;
      const now = Math.floor(Date.now() / 1000);
      await db.execute(
        "UPDATE consent_statement_versions SET is_current = 0 WHERE id = 'version_terms_1'"
      );
      await db.execute(
        `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
                                                 is_current, status, created_at, updated_at)
         VALUES ('version_terms_2', ?, 'statement_terms', '20260901', ?, 1, 'active', ?, ?)`,
        [TENANT, now, now, now]
      );
      browser.cookies.set('authrim_session', signedIn());
      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(400);
      expect(done.final?.json.error).toBe('consent_changed');
      expect(await consentRows()).toEqual([]);
      // Nothing was used up: the authorization request and the interaction are as they were.
      expect(await challengeIsUsedUp(challengeId)).toBe(false);
    });

    it('records the version it was given for when the statement has not changed', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      await selectMethod(browser, start, 'mail_otp', given);
      browser.cookies.set('authrim_session', signedIn());

      await resumeAndComplete(browser, start, interaction.id);

      expect(await consentRows()).toEqual([
        expect.objectContaining({
          subject_user_id: 'user_existing',
          statement_version: '20260701',
        }),
      ]);
    });

    it('is recorded once when the completion is submitted twice at the same time', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      await selectMethod(browser, start, 'mail_otp', given);
      const cookie = signedIn();
      const twin = browserWith(cookie);
      browser.cookies.set('authrim_session', cookie);

      const [first, second] = await Promise.all([
        resumeAndComplete(browser, start, interaction.id),
        resumeAndComplete(twin, start, interaction.id),
      ]);

      expect([first.final?.status, second.final?.status]).toContain(200);
      expect(await consentRows()).toHaveLength(1);
    });

    it('is recorded for one user only when two sessions race to complete it', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      await selectMethod(browser, start, 'mail_otp', given);
      const other = browserWith(signedIn('user_other'));
      browser.cookies.set('authrim_session', signedIn('user_existing'));

      const [first, second] = await Promise.all([
        resumeAndComplete(browser, start, interaction.id),
        resumeAndComplete(other, start, interaction.id),
      ]);

      const statuses = [first.final?.status, second.final?.status].sort();
      expect(statuses).toEqual([200, 403]);
      const rows = await consentRows();
      expect(rows).toHaveLength(1);
      // The record is the winner's, and the interaction is about that user alone.
      const winner = first.final?.status === 200 ? 'user_existing' : 'user_other';
      expect(rows[0].subject_user_id).toBe(winner);
    });

    it('is refused when the same statement in the same version has become required meanwhile', async () => {
      // An optional statement, left ungiven; the tenant then makes the very same version required.
      const db = world.db as DatabaseAdapter;
      await db.execute(
        "UPDATE consent_policy_items SET requirement = 'optional', checkbox_mode = 'optional'"
      );
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: 'consent-client',
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-client',
        challengeId,
      });
      const selection = await selectMethod(browser, start, 'mail_otp', {
        consent_item_decisions: {},
      });
      expect(selection.status).toBe(200);
      await db.execute(
        "UPDATE consent_policy_items SET requirement = 'required', checkbox_mode = 'required'"
      );
      browser.cookies.set('authrim_session', signedIn());

      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(400);
      expect(done.final?.json.error).toBe('consent_changed');
      expect(await consentRows()).toEqual([]);
      expect(await challengeIsUsedUp(challengeId)).toBe(false);
    });

    it('does not record a choice that is no longer offered, and asks again', async () => {
      const db = world.db as DatabaseAdapter;
      const now = Math.floor(Date.now() / 1000);
      const setOptions = (values: string[]) =>
        db.execute(
          `INSERT INTO tenant_consent_requirements (id, tenant_id, statement_id, conditional_rules_json,
                                                    created_at, updated_at)
           VALUES ('req_terms', ?, 'statement_terms', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET conditional_rules_json = excluded.conditional_rules_json`,
          [
            TENANT,
            JSON.stringify({
              content_mode: 'radio',
              content_options: values.map((value) => ({ value })),
            }),
            now,
            now,
          ]
        );
      await setOptions(['once', 'always']);
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      const selection = await selectMethod(browser, start, 'mail_otp', {
        consent_item_selected_values: { statement_terms: 'always' },
      });
      expect(selection.status).toBe(200);
      // While the sign-in is under way the lasting choice is withdrawn.
      await setOptions(['once']);
      browser.cookies.set('authrim_session', signedIn());

      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(400);
      expect(done.final?.json.error).toBe('consent_changed');
      expect(await consentRows()).toEqual([]);
    });

    it('goes back to the consent when the terms changed, so that it is asked for again', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      await selectMethod(browser, start, 'mail_otp', given);
      const db = world.db as DatabaseAdapter;
      const now = Math.floor(Date.now() / 1000);
      await db.execute(
        "UPDATE consent_statement_versions SET is_current = 0 WHERE id = 'version_terms_1'"
      );
      await db.execute(
        `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
                                                 is_current, status, created_at, updated_at)
         VALUES ('version_terms_2', ?, 'statement_terms', '20260901', ?, 1, 'active', ?, ?)`,
        [TENANT, now, now, now]
      );
      browser.cookies.set('authrim_session', signedIn());
      const refused = await resumeAndComplete(browser, start, interaction.id);
      expect(refused.final?.json.error).toBe('consent_changed');

      // The browser resumes the same interaction: it is at the method selection again, with the
      // consent in its newer version, and nothing held.
      const resumed = await browser.post('/api/v1/login/interactions/start', {
        resume_interaction_id: interaction.id,
        contract_hash: start.json.contract_hash as string,
        signature: start.json.signature as string,
      });
      expect(resumed.status).toBe(200);
      const current = (resumed.json.interaction as { current_step_id: string }).current_step_id;
      expect(current).toBe('auth:step');
      expect(JSON.stringify(resumed.json)).toContain('20260901');

      // Given again, and with someone signed in, it is recorded in the newer version.
      const again = await browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'mail_otp',
        // The resume signed the contract as it is now: that one is submitted.
        contract_hash: resumed.json.contract_hash as string,
        signature: resumed.json.signature as string,
        input: given,
      });
      expect(again.status).toBe(200);
      expect(again.json.completed).toBe(true);
      expect(await consentRows()).toEqual([
        expect.objectContaining({
          subject_user_id: 'user_existing',
          statement_version: '20260901',
        }),
      ]);
    });

    it('refuses what was accepted on a contract prepared before the terms changed, and serves a new one', async () => {
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { oidcClientId: 'consent-client' });
      const db = world.db as DatabaseAdapter;
      const now = Math.floor(Date.now() / 1000);
      await db.execute(
        "UPDATE consent_statement_versions SET is_current = 0 WHERE id = 'version_terms_1'"
      );
      await db.execute(
        `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
                                                 is_current, status, created_at, updated_at)
         VALUES ('version_terms_2', ?, 'statement_terms', '20260901', ?, 1, 'active', ?, ?)`,
        [TENANT, now, now, now]
      );
      const resume = (hash: string, signature: string) =>
        browser.post('/api/v1/login/interactions/start', {
          resume_interaction_id: interaction.id,
          contract_hash: hash,
          signature,
        });

      // A Worker that has the contract prepared before the change in its cache serves it again.
      const stale = await resume(
        start.json.contract_hash as string,
        start.json.signature as string
      );
      expect(JSON.stringify(stale.json)).toContain('20260701');
      const attempt = await browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'mail_otp',
        contract_hash: stale.json.contract_hash as string,
        signature: stale.json.signature as string,
        input: given,
      });
      // What would be accepted is not what was shown.
      expect(attempt.status).toBe(400);
      expect(attempt.json.error).toBe('consent_changed');

      // The interaction is prepared anew for every Worker: the terms as they are now are shown.
      const fresh = await resume(
        stale.json.contract_hash as string,
        stale.json.signature as string
      );
      expect(JSON.stringify(fresh.json)).toContain('20260901');
      const accepted = await browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'mail_otp',
        contract_hash: fresh.json.contract_hash as string,
        signature: fresh.json.signature as string,
        input: given,
      });
      expect(accepted.status).toBe(200);
    });

    it('finds the step to submit when an earlier step is run again after the consent is asked again', async () => {
      await installFlow('consent-steps-client', {
        id: 'flow-consent-steps',
        kind: 'login',
        steps: [
          { ...AUTH_STEP, config: { consent_policy_ref: 'policy_login' } },
          { id: 'a:step', source_node_id: 'a', component: 'screen', render: true, config: {} },
          { id: 'b:step', source_node_id: 'b', component: 'screen', render: true, config: {} },
          OIDC_COMPLETION,
        ],
        edges: [
          ['auth', 'mail_otp', 'a'],
          ['a', 'submitted', 'b'],
          ['b', 'submitted', 'complete'],
        ],
      });
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        clientId: 'consent-steps-client',
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-steps-client',
        challengeId,
      });
      await selectMethod(browser, start, 'mail_otp', given);
      browser.cookies.set('authrim_session', signedIn());
      const submit = (stepId: string, handle: string, contract = start) =>
        browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
          step_id: `${stepId}:step`,
          node_id: stepId,
          selected_handle: handle,
          contract_hash: contract.json.contract_hash as string,
          signature: contract.json.signature as string,
        });
      expect((await submit('a', 'submitted')).status).toBe(200);

      // The terms change before the Flow ends: B ends it, and it is refused.
      const db = world.db as DatabaseAdapter;
      const now = Math.floor(Date.now() / 1000);
      await db.execute(
        "UPDATE consent_statement_versions SET is_current = 0 WHERE id = 'version_terms_1'"
      );
      await db.execute(
        `INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, effective_at,
                                                 is_current, status, created_at, updated_at)
         VALUES ('version_terms_2', ?, 'statement_terms', '20260901', ?, 1, 'active', ?, ?)`,
        [TENANT, now, now, now]
      );
      const refused = await submit('b', 'submitted');
      expect(refused.json.error).toBe('consent_changed');

      // Asked again, the Flow runs on from the selection, A again included: its step is found.
      const resumed = await browser.post('/api/v1/login/interactions/start', {
        resume_interaction_id: interaction.id,
        contract_hash: start.json.contract_hash as string,
        signature: start.json.signature as string,
      });
      expect((resumed.json.interaction as { current_step_id: string }).current_step_id).toBe(
        'auth:step'
      );
      const again = { ...start, json: { ...start.json, ...resumed.json } };
      const selected = await browser.post(`/api/v1/login/interactions/${interaction.id}/submit`, {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'mail_otp',
        contract_hash: again.json.contract_hash as string,
        signature: again.json.signature as string,
        input: given,
      });
      expect(selected.status).toBe(200);
      expect((await submit('a', 'submitted', again)).status).toBe(200);
      const last = await submit('b', 'submitted', again);
      expect(last.status).toBe(200);
      expect(last.json.completed).toBe(true);
    });

    it.each([
      ['a re-authentication', 'reauth'],
      ['a sign-in that asked for a new one', 'login'],
    ] as const)(
      'is not recorded, nor the interaction given, to another user once the challenge of %s is gone',
      async (_label, kind) => {
        const challengeId = await storeAuthorizationChallenge({
          kind,
          freshAfter: Date.now(),
          clientId: 'consent-client',
        });
        const first = browserWith(existingSession(60_000));
        const second = browserWith(existingSession(60_000));
        const one = await startFlow(first, { oidcClientId: 'consent-client', challengeId });
        const two = await startFlow(second, { oidcClientId: 'consent-client', challengeId });
        await selectMethod(first, one.start, 'mail_otp', given);
        await selectMethod(second, two.start, 'mail_otp', given);

        // The user it was asked of answers it by the first interaction; the challenge is then cleared.
        first.cookies.set('authrim_session', signedIn('user_existing'));
        const done = await resumeAndComplete(first, one.start, one.interaction.id);
        expect(done.final?.status).toBe(200);
        await (world.challenges as ChallengeStore).deleteChallengeRpc(challengeId);

        // Someone else, with a sign-in of their own, comes to the second interaction.
        second.cookies.set('authrim_session', signedIn('user_other'));
        const attempt = await resumeAndComplete(second, two.start, two.interaction.id);

        expect(attempt.final?.status).toBe(401);
        const rows = (await (world.db as DatabaseAdapter).query(
          'SELECT user_id FROM flow_interactions WHERE id = ?',
          [two.interaction.id]
        )) as Array<{ user_id: string | null }>;
        expect(rows).toEqual([{ user_id: null }]);
        // Only the first interaction's user has a record.
        expect((await consentRows()).map((row) => row.subject_user_id)).toEqual(['user_existing']);
      }
    );

    it('is not recorded for another user than the one a re-authentication was asked of', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'reauth',
        clientId: 'consent-client',
      });
      const browser = browserWith(existingSession(60_000));
      const { start, interaction } = await startFlow(browser, {
        oidcClientId: 'consent-client',
        challengeId,
      });
      await selectMethod(browser, start, 'mail_otp', given);
      // A new sign-in, made after the request, but by someone else.
      browser.cookies.set('authrim_session', signedIn('user_other'));

      const attempt = await resumeAndComplete(browser, start, interaction.id);

      expect(attempt.final?.status).toBe(401);
      expect(await consentRows()).toEqual([]);
      expect(await challengeIsUsedUp(challengeId)).toBe(false);

      // The user it was asked of can still answer it.
      browser.cookies.set('authrim_session', signedIn('user_existing'));
      const done = await resumeAndComplete(browser, start, interaction.id);
      expect(done.final?.status).toBe(200);
      expect(await consentRows()).toHaveLength(1);
    });
  });

  describe('how consent records are written', () => {
    const interaction = (id: string) => ({
      id,
      flow_id: 'flow_x',
      flow_version_id: 'fv_1',
      user_id: null,
      client_id: 'client_1',
      saml_sp_id: null,
      state: 'active',
      current_node_id: null,
      current_step_id: null,
      context_json: null,
      contract_hash: 'hash',
      signature: 'signature',
      expires_at: 0,
    });
    const requestContext = {
      protocol: 'oidc' as const,
      target_type: 'oidc_client' as const,
      target_id: 'client_1',
      client_id: 'client_1',
      saml_sp_id: null,
      authorization_challenge_id: null,
      saml_request_id: null,
      saml_sp_entity_id: null,
      return_to: null,
      requested_scope: ['openid'],
      locale: null,
    };
    const step = {
      id: 'consent:step',
      source_node_id: 'consent',
      component: 'consent_policy',
    } as never;
    const policy = {
      id: 'policy_1',
      display_name: 'Policy',
      description: null,
      language: 'en',
      default_language: 'en',
      items: [
        {
          statement_id: 'statement_email',
          slug: 'email',
          category: 'custom',
          title: 'Email',
          description: '',
          document_url: null,
          inline_content: null,
          version: '1',
          version_id: 'v1',
          is_required: false,
          content_mode: 'checkbox',
          options: [],
          attribute_value_display: null,
          checkbox_mode: 'optional',
          checkbox_default_checked: false,
          binding_type: 'subject',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
        },
      ],
    } as never;
    const rows = async (sql: string) =>
      (await (world.db as DatabaseAdapter).query(sql)) as Array<Record<string, unknown>>;

    it('replaces a decision that is sent again with another: the last one stands', async () => {
      const common = {
        db: world.db as DatabaseAdapter,
        tenantId: TENANT,
        interaction: interaction('interaction_1'),
        step,
        policy,
        requestContext,
        userId: 'user_1',
      };

      await insertFlowConsentRecords({
        ...common,
        decisions: { statement_email: { decision: 'accepted', selectedValue: null } },
      });
      await insertFlowConsentRecords({
        ...common,
        decisions: { statement_email: { decision: 'rejected', selectedValue: null } },
      });
      await insertFlowConsentRecords({
        ...common,
        decisions: { statement_email: { decision: 'rejected', selectedValue: null } },
      });

      expect(await rows('SELECT decision FROM consent_records')).toEqual([
        { decision: 'rejected' },
      ]);
    });

    describe('a release of destination fields, one user, one recipient, one profile', () => {
      const consent = {
        profile_id: 'profile_1',
        profile_version_id: 'pv_1',
        consent_version: '1',
        destination_type: 'oidc' as const,
        consent_mode: 'once' as const,
        fields: [],
      } as never;
      const record = (interactionId: string, selectedFields: string[]) =>
        insertDestinationFieldConsentRecord({
          db: world.db as DatabaseAdapter,
          tenantId: TENANT,
          interaction: interaction(interactionId),
          step,
          policyId: 'policy_1',
          requestContext,
          userId: 'user_1',
          consent,
          selectedFields,
        });
      const active = () =>
        rows(
          "SELECT id, released_claims_json FROM consent_records WHERE status = 'active' AND binding_type = 'destination_field_mapping_set'"
        );

      it('has exactly one that stands, whatever order two interactions record it in', async () => {
        await Promise.all([record('interaction_a', ['email']), record('interaction_b', ['phone'])]);

        const standing = await active();
        expect(standing).toHaveLength(1);
        // Of the two, the greater by (created_at, id) stands, and sending the other again changes nothing.
        const all = await rows('SELECT id FROM consent_records ORDER BY created_at, id');
        expect(standing[0].id).toBe(all.at(-1)?.id);
        await record('interaction_a', ['email']);
        await record('interaction_b', ['phone']);
        expect(await active()).toEqual(standing);
      });

      it('keeps one active when the greater record was written first, in the same second', async () => {
        await record('interaction_a', ['email']);
        await record('interaction_b', ['phone']);
        // Both in the same second whatever their order: the greater by id stands, the other not.
        await (world.db as DatabaseAdapter).execute('UPDATE consent_records SET created_at = 1000');
        await record('interaction_a', ['email']);
        await record('interaction_b', ['phone']);

        const standing = await active();
        expect(standing).toHaveLength(1);
        const ids = (await rows('SELECT id FROM consent_records ORDER BY id')).map((row) => row.id);
        expect(standing[0].id).toBe(ids.at(-1));
      });

      it('is a different record for another consent version of the same profile', async () => {
        await record('interaction_a', ['email']);
        await insertDestinationFieldConsentRecord({
          db: world.db as DatabaseAdapter,
          tenantId: TENANT,
          interaction: interaction('interaction_a'),
          step,
          policyId: 'policy_1',
          requestContext,
          userId: 'user_1',
          consent: { ...(consent as object), consent_version: '2' } as never,
          selectedFields: ['email', 'phone'],
        });

        expect(
          await rows('SELECT statement_version FROM consent_records ORDER BY created_at, id')
        ).toHaveLength(2);
        expect(await active()).toHaveLength(1);
      });

      it('does not let a request delayed past a change of the terms displace the newer consent', async () => {
        const at = (version: string, interactionId: string, current?: string) =>
          insertDestinationFieldConsentRecord({
            db: world.db as DatabaseAdapter,
            tenantId: TENANT,
            interaction: interaction(interactionId),
            step,
            policyId: 'policy_1',
            requestContext,
            userId: 'user_1',
            consent: { ...(consent as object), consent_version: version } as never,
            selectedFields: ['email'],
            currentConsentVersion: current,
          });
        // The newer consent is recorded, in the version that applies now ...
        await at('2', 'interaction_b', '2');
        // ... and then a request that was accepted under the older version, held up until now,
        // is written, with the version that applies as this is written.
        await at('1', 'interaction_a', '2');

        const standing = await rows(
          "SELECT statement_version FROM consent_records WHERE status = 'active' AND binding_type = 'destination_field_mapping_set'"
        );
        expect(standing).toEqual([{ statement_version: '2' }]);
      });

      it('keeps the record in the newer consent version, whatever sorts later', async () => {
        const at = (version: string, interactionId: string, fields: string[]) =>
          insertDestinationFieldConsentRecord({
            db: world.db as DatabaseAdapter,
            tenantId: TENANT,
            interaction: interaction(interactionId),
            step,
            policyId: 'policy_1',
            requestContext,
            userId: 'user_1',
            consent: { ...(consent as object), consent_version: version } as never,
            selectedFields: fields,
          });
        await at('1', 'interaction_a', ['email']);
        // The older record sorts later in every way but its version.
        await (world.db as DatabaseAdapter).execute(
          'UPDATE consent_records SET created_at = 4102444800'
        );
        await at('2', 'interaction_b', ['email', 'phone']);

        const standing = await rows(
          "SELECT statement_version FROM consent_records WHERE status = 'active' AND binding_type = 'destination_field_mapping_set'"
        );
        expect(standing).toEqual([{ statement_version: '2' }]);
      });

      it('is updated by a retry with other fields, and an older one sent again retires nothing newer', async () => {
        await record('interaction_a', ['email']);
        await record('interaction_a', ['email', 'phone']);
        expect(await active()).toEqual([
          expect.objectContaining({ released_claims_json: JSON.stringify(['email', 'phone']) }),
        ]);

        await record('interaction_b', ['email']);
        const afterB = await active();
        expect(afterB).toHaveLength(1);
        await record('interaction_a', ['email', 'phone']);
        expect(await active()).toEqual(afterB);
      });
    });
  });

  describe('a registration with a session already there', () => {
    it('is not answered by that session, and completes after its own sign-in', async () => {
      const oldSession = existingSession(3_600_000);
      const browser = browserWith(oldSession);
      const { start, interaction } = await startFlow(browser, { flowKind: 'registration' });
      expect(
        stepsOf(start.json).find(
          (step) =>
            step.id === (start.json.interaction as { current_step_id: string }).current_step_id
        )?.component
      ).toBe('registration_method_selector');

      const selection = await selectMethod(browser, start, 'mail_otp');
      expect(selection.json.completed).toBe(false);
      const early = await resumeAndComplete(browser, start, interaction.id);
      expect(early.final?.status).toBe(401);

      browser.cookies.set('authrim_session', existingSession(-50));
      const done = await resumeAndComplete(browser, start, interaction.id);
      expect(done.final?.status).toBe(200);
      expect(done.final?.json.completed).toBe(true);
    });
  });

  describe('a database that fails just after the authorization request was continued', () => {
    it('gives the same continuation again when the completion is submitted again', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));

      // The continuation is made (the challenge is used up); then the interaction cannot be saved.
      world.failNextTransaction = true;
      const failed = await resumeAndComplete(browser, start, interaction.id);
      expect(failed.final?.status).toBe(500);
      expect(await challengeIsUsedUp(challengeId)).toBe(true);

      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(200);
      expect(done.final?.json.completed).toBe(true);
      expect(done.continuation).toBeDefined();
    });

    it('gives it again after the challenge itself was cleared away', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));
      world.failNextTransaction = true;
      const failed = await resumeAndComplete(browser, start, interaction.id);
      expect(failed.final?.status).toBe(500);

      // The store's cleanup removes a record that was used, before its time.
      await (world.challenges as ChallengeStore).deleteChallengeRpc(challengeId);
      const done = await resumeAndComplete(browser, start, interaction.id);

      expect(done.final?.status).toBe(200);
      expect(done.continuation).toBeDefined();
    });

    it('does not give it to another user', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));
      world.failNextTransaction = true;
      await resumeAndComplete(browser, start, interaction.id);

      browser.cookies.set('authrim_session', existingSession(-50, 'email_code', 'user_other'));
      const other = await resumeAndComplete(browser, start, interaction.id);

      expect(other.continuation).toBeUndefined();
      expect(other.final?.status).not.toBe(200);
    });
  });

  describe('the address the browser is sent to when the Flow ends', () => {
    // What the Login UI does with it is judged by the UI (completion-redirect.test.ts, with the
    // same address): this pins what the server gives, in a local development setup, where the
    // issuer is plain http on a port of its own, apart from the UI.
    it("is the issuer's authorize address with the confirmation, as the UI is tested to accept", async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
        issuer: 'http://localhost:8787',
      });
      const browser = browserWith(existingSession(60_000));

      const result = await signInByEmailCode(browser, { challengeId });

      // The session finish (continuation deferred) gives the tenant's usual destination: the page
      // has to go on with the one the Flow's completion gives, or it never returns to the application.
      expect(result.finish?.json.redirect_url).not.toMatch(/_confirmation_challenge/);
      expect(result.final?.json.output).toMatchObject({
        redirect_url: expect.stringMatching(
          /^http:\/\/localhost:8787\/authorize\?_confirmation_challenge=[0-9a-f-]{36}$/
        ),
      });
    });
  });

  describe('an authorization request that cannot be read just then', () => {
    it('decides no branch at a session check that runs on its own, and answers that it is not available', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith(existingSession(-50));
      // The request is read when the interaction is begun, and not when the session is checked.
      const store = world.challenges as ChallengeStore;
      const read = store.getChallengeRpc.bind(store);
      let reads = 0;
      store.getChallengeRpc = async (id: string) => {
        reads += 1;
        if (reads === 2) throw new Error('store unavailable');
        return read(id);
      };

      const attempt = await browser.post('/api/v1/login/interactions/start', {
        flow_kind: 'login',
        client_id: CLIENT_ID,
        authorization_challenge_id: challengeId,
      });
      store.getChallengeRpc = read;

      expect(attempt.status).toBe(503);
      expect(attempt.json).toMatchObject({
        error: 'temporarily_unavailable',
        action: 'retry_step',
      });
      // Asked again, it goes on as it should: the session is the one the request accepts.
      const again = await browser.post('/api/v1/login/interactions/start', {
        flow_kind: 'login',
        client_id: CLIENT_ID,
        authorization_challenge_id: challengeId,
      });
      expect(again.status).toBe(200);
    });
  });

  describe('an authorization request that has expired', () => {
    it('is found out at once, whether or not anyone has signed in, and says so', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      // The request is gone (expired and cleared) before the sign-in is done.
      await (world.challenges as ChallengeStore).deleteChallengeRpc(challengeId);

      // Taking the interaction up again says so, with nobody signed in ...
      const resumed = await browser.post('/api/v1/login/interactions/start', {
        resume_interaction_id: interaction.id,
        contract_hash: start.json.contract_hash as string,
        signature: start.json.signature as string,
      });
      expect(resumed.status).toBe(400);
      expect(resumed.json.error).toBe('authorization_request_expired');

      // ... as does a step submitted, a method chosen for example ...
      const selection = await selectMethod(browser, start, 'mail_otp');
      expect(selection.status).toBe(400);
      expect(selection.json.error).toBe('authorization_request_expired');

      // ... and signing in does not change the answer, however often it is asked.
      browser.cookies.set('authrim_session', existingSession(-50));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const after = await selectMethod(browser, start, 'mail_otp');
        expect(after.status).toBe(400);
        expect(after.json.error).toBe('authorization_request_expired');
      }
    });

    it('is the answer to a new start on it, not that the request is invalid', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      await (world.challenges as ChallengeStore).deleteChallengeRpc(challengeId);

      const start = await browserWith().post('/api/v1/login/interactions/start', {
        flow_kind: 'login',
        client_id: CLIENT_ID,
        authorization_challenge_id: challengeId,
      });

      expect(start.status).toBe(400);
      expect(start.json.error).toBe('authorization_request_expired');
    });

    it('does not cut off what was continued and can still be had', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));
      world.failNextTransaction = true;
      await resumeAndComplete(browser, start, interaction.id);
      await (world.challenges as ChallengeStore).deleteChallengeRpc(challengeId);

      // Its confirmation is there: the interaction is resumed and completes.
      const done = await resumeAndComplete(browser, start, interaction.id);
      expect(done.final?.status).toBe(200);
    });
  });

  describe('an audit store that fails when the Flow ends', () => {
    it('does not take the continuation away: the audit is logged, the browser is answered', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));

      world.failAudit = true;
      const done = await resumeAndComplete(browser, start, interaction.id);
      world.failAudit = false;

      expect(done.final?.status).toBe(200);
      expect(done.final?.json.completed).toBe(true);
      expect(done.continuation).toBeDefined();
      // The audit did fail (and only that did).
      const events = (await (world.db as DatabaseAdapter).query(
        'SELECT event_type FROM flow_audit_events WHERE interaction_id = ?',
        [interaction.id]
      )) as Array<{ event_type: string }>;
      expect(events.map((event) => event.event_type)).not.toContain('flow.interaction.completed');
    });
  });

  describe('an authorization request that cannot be continued just then', () => {
    it('leaves the interaction open and audits no success, then completes when submitted again', async () => {
      const challengeId = await storeAuthorizationChallenge({
        kind: 'login',
        freshAfter: Date.now(),
      });
      const browser = browserWith();
      const { start, interaction } = await startFlow(browser, { challengeId });
      await selectMethod(browser, start, 'mail_otp');
      browser.cookies.set('authrim_session', existingSession(-50));

      // The challenge is readable when the completion is checked and not when it is continued.
      const store = world.challenges as ChallengeStore;
      const read = store.getChallengeRpc.bind(store);
      let reads = 0;
      store.getChallengeRpc = async (id: string) => {
        reads += 1;
        if (reads === 2) throw new Error('store unavailable');
        return read(id);
      };
      const failed = await resumeAndComplete(browser, start, interaction.id);
      store.getChallengeRpc = read;

      expect(failed.final?.status).toBe(503);
      const events = (await (world.db as DatabaseAdapter).query(
        'SELECT event_type FROM flow_audit_events WHERE interaction_id = ?',
        [interaction.id]
      )) as Array<{ event_type: string }>;
      expect(events.map((event) => event.event_type)).not.toContain('flow.interaction.completed');
      expect(await challengeIsUsedUp(challengeId)).toBe(false);

      const done = await resumeAndComplete(browser, start, interaction.id);
      expect(done.final?.status).toBe(200);
      expect(done.continuation).toBeDefined();
    });
  });

  describe('an external provider', () => {
    it.each([['a login dated by its auth_time', undefined, 'login']])(
      'answers an SSO-off sign-in with %s',
      async (_label, sessionData) => {
        const challengeId = await storeAuthorizationChallenge({
          kind: 'login',
          freshAfter: Date.now(),
        });
        const browser = browserWith(existingSession(60_000));

        const result = await signInByProvider(browser, {
          challengeId,
          sessionData: { authTime: Math.floor(Date.now() / 1000), ...(sessionData ?? {}) },
        });

        expect(result.final?.status).toBe(200);
        expect(result.continuation).toBeDefined();
      }
    );

    it('answers a re-authentication only with a login the provider was asked for', async () => {
      const challengeId = await storeAuthorizationChallenge({ kind: 'reauth' });
      const browser = browserWith(existingSession(60_000));

      // The provider answered from a session of its own: no new login was shown.
      const unrenewed = await signInByProvider(browser, {
        challengeId,
        sessionData: { authTime: Math.floor(Date.now() / 1000) },
      });
      expect(unrenewed.final?.status).toBe(401);
      expect(await challengeIsUsedUp(challengeId)).toBe(false);

      // A new login, dated by Authrim's own clock when it was asked for.
      const browser2 = browserWith(existingSession(60_000));
      const renewed = await signInByProvider(browser2, {
        challengeId,
        sessionData: {
          authTime: Math.floor(Date.now() / 1000),
          reauth_proven_amr: ['external_idp'],
          reauth_proven_at: Date.now() + 1000,
        },
      });
      expect(renewed.final?.status).toBe(200);
      expect(renewed.continuation).toBeDefined();
      expect(await challengeIsUsedUp(challengeId)).toBe(true);
    });
  });
});
