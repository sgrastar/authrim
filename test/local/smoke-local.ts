/**
 * Smoke test for a running local environment (`pnpm setup:local up`).
 *
 * It exercises the paths a developer relies on: discovery and JWKS, initial-admin setup state,
 * then sign-in with a passkey (software authenticator) and with an email code (read from the
 * local log notifier), each followed by the authorization-code flow with PKCE and an ID token
 * signature check.
 *
 * Usage: pnpm setup:local-smoke [--env local] [--base-url http://localhost:8787]
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanupSetupMachineAccessInD1,
  ensureSetupMachineAccessInD1,
} from '../../packages/setup/src/core/cloudflare.js';
import { resolveAdminBearerToken } from '../../packages/setup/src/core/login-ui-client.js';
import { createLocalTarget } from '../../packages/setup/src/core/local/data.js';
import { loadLocalConfig } from '../../packages/setup/src/core/local/init.js';
import { buildLocalLock } from '../../packages/setup/src/core/local/environment.js';
import { getLocalEnvironmentPaths } from '../../packages/setup/src/core/local/paths.js';
import { createSoftAuthenticator } from './soft-authenticator.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const env = option('env', 'local');
const rootDir = process.cwd();
const paths = getLocalEnvironmentPaths(rootDir, env);
const config = await loadLocalConfig(paths);
const baseUrl = option('base-url', config.urls!.api!.auto!).replace(/\/$/u, '');
const origin = new URL(baseUrl).origin;
// The Login UI and Admin UI run on their own localhost origins; browser requests to the API (and
// the WebAuthn ceremony) carry the UI's origin, not the issuer's.
const loginUiOrigin = new URL(config.urls!.loginUi!.auto!).origin;
const adminUiOrigin = new URL(config.urls!.adminUi!.auto!).origin;
const rpId = new URL(baseUrl).hostname;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  );
  if (!ok) failures += 1;
}

class Session {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly requestOrigin: string = origin) {}
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('origin', this.requestOrigin);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair!.indexOf('=');
      const name = pair!.slice(0, separator);
      const value = pair!.slice(separator + 1);
      if (value === '' || /max-age=0/iu.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async json(path: string, body: unknown): Promise<{ status: number; body: any }> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      // Direct Auth endpoints are rate limited per client; wait out the window and retry.
      if (response.status === 429 && attempt < 2 && typeof payload?.retry_after === 'number') {
        await new Promise((resolve) => setTimeout(resolve, (payload.retry_after + 1) * 1000));
        continue;
      }
      return { status: response.status, body: payload };
    }
  }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function withAdminToken<T>(action: (token: string) => Promise<T>): Promise<T> {
  const target = createLocalTarget(paths);
  const adminDatabase = buildLocalLock(env).d1.DB_ADMIN!.id;
  const machine = await ensureSetupMachineAccessInD1(env, config, paths.keys, undefined, {
    databaseIdentifier: adminDatabase,
    target,
  });
  if (!machine.success) throw new Error(machine.error);
  try {
    const token = await resolveAdminBearerToken({
      apiBaseUrl: baseUrl,
      keysDir: paths.keys,
      tenantId: config.tenant.name,
    });
    return await action(token);
  } finally {
    await cleanupSetupMachineAccessInD1(env, paths.keys, undefined, {
      databaseIdentifier: adminDatabase,
      target,
    });
  }
}

const adminHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'x-tenant-id': config.tenant.name,
});

async function findLoginUiClientId(token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/admin/clients?search=Login%20UI&limit=10`, {
    headers: adminHeaders(token),
  });
  const payload = (await response.json()) as {
    clients?: Array<{ client_id?: string; client_name?: string }>;
  };
  const client = payload.clients?.find((candidate) => candidate.client_name === 'Login UI');
  if (!client?.client_id)
    throw new Error('The Login UI client was not found; run `local up` first.');
  return client.client_id;
}

async function createTestClient(token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/admin/clients`, {
    method: 'POST',
    headers: { ...adminHeaders(token), 'idempotency-key': `local-smoke-${randomUUID()}` },
    body: JSON.stringify({
      client_name: 'Local smoke test',
      redirect_uris: [`${baseUrl}/smoke/callback`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      // Authorization-code grants are issued for the client's default resource.
      default_resource: baseUrl,
      is_trusted: true,
      skip_consent: true,
    }),
  });
  const payload = (await response.json()) as { client?: { client_id?: string } };
  if (!response.ok || !payload.client?.client_id) {
    throw new Error(`client creation failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.client.client_id;
}

interface Clients {
  loginUi: string;
  app: string;
}

/**
 * The browser flow of a third-party app: /authorize sends an unauthenticated browser to the Login
 * UI with a challenge, the Login UI authenticates through Direct Auth as the Login UI client and
 * finishes the session with that challenge, which continues the authorization.
 */
async function startAuthorization(session: Session, clients: Clients) {
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const nonce = randomBytes(8).toString('hex');
  const redirectUri = `${baseUrl}/smoke/callback`;
  const authorize = await session.request(
    `/authorize?${new URLSearchParams({
      client_id: clients.app,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`
  );
  const location = authorize.headers.get('location') ?? '';
  const challengeId = location ? new URL(location, baseUrl).searchParams.get('challenge_id') : null;
  check('authorize sends an unauthenticated browser to the Login UI', challengeId !== null, {
    status: authorize.status,
    location,
  });
  return { challengeId, verifier, state, nonce, redirectUri };
}

/** Follow the continuation from the session response until the app's redirect URI is reached. */
async function finishAuthorization(
  session: Session,
  clients: Clients,
  flow: NonNullable<Awaited<ReturnType<typeof startAuthorization>>>,
  redirectUrl: string
) {
  let next = redirectUrl;
  let code: string | null = null;
  for (let hop = 0; hop < 5 && !code; hop += 1) {
    const url = new URL(next, baseUrl);
    if (url.href.startsWith(flow.redirectUri)) {
      code = url.searchParams.get('code');
      check('state is echoed', url.searchParams.get('state') === flow.state);
      break;
    }
    if (url.pathname === '/consent') {
      // The app is not pre-approved: grant consent the way the consent screen does.
      const consent = await session.json('/api/auth/consents', {
        challenge_id: url.searchParams.get('challenge_id'),
        approved: true,
      });
      check('consent is granted', consent.status === 200 || consent.status === 302, consent);
      next = consent.body?.redirect_url ?? consent.body?.redirectUrl ?? '';
      if (!next) break;
      continue;
    }
    const response = await session.request(`${url.pathname}${url.search}`);
    const location = response.headers.get('location');
    if (!location) break;
    next = location;
  }
  check('the authorization continues to the app with a code', code !== null, { next });
  if (!code) return null;
  const exchange = () =>
    fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        client_id: clients.app,
        code_verifier: flow.verifier,
      }),
    });
  let tokenResponse = await exchange();
  if (tokenResponse.status === 429) {
    // The authorization code is single use, but a rate-limited request was never processed.
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    tokenResponse = await exchange();
  }
  const tokens = (await tokenResponse.json()) as Record<string, string>;
  check('token endpoint returns access and ID tokens', tokenResponse.ok && !!tokens.id_token, {
    status: tokenResponse.status,
    error: tokens.error,
  });
  return tokenResponse.ok ? { tokens, nonce: flow.nonce } : null;
}

/** Each sign-in flow must end in a verified ID token; a skipped branch would otherwise go unnoticed. */
let verifiedIdTokens = 0;

async function verifyIdToken(idToken: string, nonce: string): Promise<void> {
  const [header, payload, signature] = idToken.split('.');
  const parsedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  const jwks = (await (await fetch(`${baseUrl}/.well-known/jwks.json`)).json()) as {
    keys: Array<Record<string, string>>;
  };
  const jwk = jwks.keys.find((key) => key.kid === parsedHeader.kid);
  const valid =
    !!jwk &&
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(signature!, 'base64url')
    );
  check('ID token signature verifies against JWKS', valid);
  if (valid) verifiedIdTokens += 1;
  check(
    'ID token issuer, nonce and expiry',
    claims.iss === baseUrl && claims.nonce === nonce && claims.exp > Date.now() / 1000,
    {
      iss: claims.iss,
    }
  );
}

async function passkeyFlow(clients: Clients): Promise<void> {
  console.log('\n-- Passkey sign-up and sign-in (software authenticator)');
  const session = new Session(loginUiOrigin);
  const authenticator = createSoftAuthenticator();
  const email = `passkey-${Date.now()}@example.test`;
  const flow = await startAuthorization(session, clients);
  if (!flow.challengeId) return;
  const direct = pkce();
  const start = await session.json('/api/v1/auth/direct/passkey/signup/start', {
    client_id: clients.loginUi,
    email,
    display_name: 'Passkey User',
    code_challenge: direct.challenge,
    code_challenge_method: 'S256',
    channel: 'browser',
    scope: 'openid profile email',
    authorization_challenge_id: flow.challengeId,
  });
  check('passkey sign-up start', start.status === 200 && !!start.body?.options, start);
  if (!start.body?.options) return;
  const finish = await session.json('/api/v1/auth/direct/passkey/signup/finish', {
    challenge_id: start.body.challenge_id,
    credential: authenticator.register({ options: start.body.options, origin: loginUiOrigin }),
    code_verifier: direct.verifier,
    channel: 'browser',
  });
  check(
    'passkey sign-up finish returns an artifact',
    finish.status === 200 && !!finish.body?.direct_auth_artifact,
    finish
  );
  if (!finish.body?.direct_auth_artifact) return;
  const created = await session.json('/api/v1/auth/direct/session', {
    direct_auth_artifact: finish.body.direct_auth_artifact,
    client_id: clients.loginUi,
    code_verifier: direct.verifier,
    channel: 'browser',
    authorization_challenge_id: flow.challengeId,
  });
  check(
    'browser session is created and continues the authorization',
    created.status === 200 && !!created.body?.redirect_url,
    created
  );
  if (created.body?.redirect_url) {
    const result = await finishAuthorization(session, clients, flow, created.body.redirect_url);
    if (result) await verifyIdToken(result.tokens.id_token!, result.nonce);
  }

  // Sign in again, in a new browser, with the registered credential.
  const second = new Session(loginUiOrigin);
  const secondFlow = await startAuthorization(second, clients);
  if (!secondFlow.challengeId) return;
  const login = pkce();
  const loginStart = await second.json('/api/v1/auth/direct/passkey/login/start', {
    client_id: clients.loginUi,
    code_challenge: login.challenge,
    code_challenge_method: 'S256',
    channel: 'browser',
    authorization_challenge_id: secondFlow.challengeId,
  });
  check('passkey login start', loginStart.status === 200 && !!loginStart.body?.options, loginStart);
  if (!loginStart.body?.options) return;
  const loginFinish = await second.json('/api/v1/auth/direct/passkey/login/finish', {
    challenge_id: loginStart.body.challenge_id,
    credential: authenticator.authenticate({
      options: {
        challenge: loginStart.body.options.challenge,
        rpId: loginStart.body.options.rpId ?? rpId,
      },
      origin: loginUiOrigin,
      userHandle: Buffer.from(start.body.options.user.id, 'base64url'),
    }),
    code_verifier: login.verifier,
    channel: 'browser',
  });
  check(
    'passkey login finish returns an artifact',
    loginFinish.status === 200 && !!loginFinish.body?.direct_auth_artifact,
    loginFinish
  );
  if (!loginFinish.body?.direct_auth_artifact) return;
  const loginSession = await second.json('/api/v1/auth/direct/session', {
    direct_auth_artifact: loginFinish.body.direct_auth_artifact,
    client_id: clients.loginUi,
    code_verifier: login.verifier,
    channel: 'browser',
    authorization_challenge_id: secondFlow.challengeId,
  });
  check(
    'passkey sign-in creates a browser session and continues the authorization',
    loginSession.status === 200 && !!loginSession.body?.redirect_url,
    loginSession
  );
  if (loginSession.body?.redirect_url) {
    const result = await finishAuthorization(
      second,
      clients,
      secondFlow,
      loginSession.body.redirect_url
    );
    if (result) await verifyIdToken(result.tokens.id_token!, result.nonce);
  }
}

/** The plain-text part of the newest delivery to `email` (it holds the code without markup). */
async function latestNotification(email: string): Promise<{ body: string } | null> {
  const log = await readFile(join(paths.logs, 'workers.log'), 'utf-8').catch(() => '');
  const matches = [...log.matchAll(/\[LOCAL-NOTIFICATION\] (\{.*\})/gu)]
    .map(
      (match) =>
        JSON.parse(match[1]!) as { to?: string; body?: string; metadata?: { textBody?: string } }
    )
    .filter((entry) => entry.to === email);
  const latest = matches.at(-1);
  return latest ? { body: latest.metadata?.textBody ?? latest.body ?? '' } : null;
}

async function emailCodeFlow(clients: Clients): Promise<void> {
  console.log('\n-- Email code sign-in (code read from the local log notifier)');
  const session = new Session(loginUiOrigin);
  const email = `emailcode-${Date.now()}@example.test`;
  const flow = await startAuthorization(session, clients);
  if (!flow.challengeId) return;
  const direct = pkce();
  const send = await session.json('/api/v1/auth/direct/email-code/send', {
    client_id: clients.loginUi,
    email,
    display_name: 'Email User',
    code_challenge: direct.challenge,
    code_challenge_method: 'S256',
    channel: 'browser',
    scope: 'openid profile email',
    authorization_challenge_id: flow.challengeId,
  });
  check('email code send', send.status === 200 && !!send.body?.attempt_id, send);
  let notification: { body: string } | null = null;
  for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    notification = await latestNotification(email);
  }
  check('code delivery appears in the Worker log', notification !== null);
  const code = notification?.body.match(/\b(\d{6})\b/u)?.[1];
  check('delivery contains a 6-digit code', code !== undefined);
  if (!code || !send.body?.attempt_id) return;
  const verified = await session.json('/api/v1/auth/direct/email-code/verify', {
    attempt_id: send.body.attempt_id,
    code,
    code_verifier: direct.verifier,
    channel: 'browser',
  });
  check(
    'email code verify returns an artifact',
    verified.status === 200 && !!verified.body?.direct_auth_artifact,
    verified
  );
  if (!verified.body?.direct_auth_artifact) return;
  const created = await session.json('/api/v1/auth/direct/session', {
    direct_auth_artifact: verified.body.direct_auth_artifact,
    client_id: clients.loginUi,
    code_verifier: direct.verifier,
    channel: 'browser',
    authorization_challenge_id: flow.challengeId,
  });
  check(
    'browser session is created and continues the authorization',
    created.status === 200 && !!created.body?.redirect_url,
    created
  );
  if (created.body?.redirect_url) {
    const result = await finishAuthorization(session, clients, flow, created.body.redirect_url);
    if (result) await verifyIdToken(result.tokens.id_token!, result.nonce);
  }
}

console.log(`Local smoke test against ${baseUrl}\n`);
const discovery = await fetch(`${baseUrl}/.well-known/openid-configuration`);
const metadata = (await discovery.json()) as { issuer?: string };
check(
  'discovery returns 200 with the local issuer',
  discovery.status === 200 && metadata.issuer === baseUrl
);
const jwksResponse = await fetch(`${baseUrl}/.well-known/jwks.json`);
const jwks = (await jwksResponse.json()) as { keys?: unknown[] };
check('JWKS is published', jwksResponse.status === 200 && (jwks.keys?.length ?? 0) > 0);
const setup = (await (await fetch(`${baseUrl}/api/admin-init-setup/status`)).json()) as {
  initialized?: boolean;
  error?: string;
};
// Before the first administrator exists the status is reported; afterwards setup is closed.
check(
  'initial admin setup state is reported',
  typeof setup.initialized === 'boolean' || setup.error === 'setup_completed',
  setup
);

/** The dev server's page must be reachable and every script/style it names must load. */
async function checkUi(name: string, url: string): Promise<void> {
  const page = await fetch(url);
  const html = await page.text();
  check(`${name} page is served`, page.status === 200 && html.includes('<html'), {
    status: page.status,
  });
  const references = [...html.matchAll(/(?:import\(|src=|href=)["'](\/[^"']+)["']/gu)]
    .map((match) => match[1]!)
    .filter((path) => /\.(?:js|ts|svelte|css)(?:\?|$)|^\/(?:@|node_modules|_authrim)/u.test(path));
  check(`${name} page references scripts`, references.length > 0, { count: references.length });
  const failures: string[] = [];
  for (const path of [...new Set(references)].slice(0, 12)) {
    const response = await fetch(new URL(path, url));
    if (response.status !== 200) failures.push(`${path} -> ${response.status}`);
    await response.arrayBuffer();
  }
  check(`${name} scripts and styles load from the UI origin`, failures.length === 0, failures);
}

await checkUi('Login UI', `${loginUiOrigin}/login`);
await checkUi('Admin UI', `${adminUiOrigin}/admin/info`);

const preflight = await fetch(`${baseUrl}/api/v1/auth/direct/passkey/login/start`, {
  method: 'OPTIONS',
  headers: {
    origin: loginUiOrigin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
check(
  'the API allows the Login UI origin (CORS with credentials)',
  preflight.headers.get('access-control-allow-origin') === loginUiOrigin &&
    preflight.headers.get('access-control-allow-credentials') === 'true',
  { status: preflight.status, allow: preflight.headers.get('access-control-allow-origin') }
);

const clients = await withAdminToken(async (token) => ({
  loginUi: await findLoginUiClientId(token),
  app: await createTestClient(token),
}));
await passkeyFlow(clients);
await emailCodeFlow(clients);
// Passkey sign-up, passkey sign-in and email-code sign-in each finish with an ID token.
check('all three sign-in flows ended with a verified ID token', verifiedIdTokens === 3, {
  verified: verifiedIdTokens,
});

// A ready-made authorize URL for trying the real Login UI in a browser. The app's redirect URI
// is served by nothing: after sign-in the browser lands on it with `?code=...`.
const browserFlow = pkce();
console.log(
  `\nTry the Login UI in a browser (sign in with an email code; read it from the Worker log):\n  ${baseUrl}/authorize?${new URLSearchParams(
    {
      client_id: clients.app,
      redirect_uri: `${baseUrl}/smoke/callback`,
      response_type: 'code',
      scope: 'openid profile email',
      state: 'browser-check',
      nonce: 'browser-check',
      code_challenge: browserFlow.challenge,
      code_challenge_method: 'S256',
    }
  )}`
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
