import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resetAdminTokenCache, REQUIRED_SCOPES } from '../admin-api';
import { loadConfig, type Config } from '../config';
import { handleRequest } from '../index';
import type { DemoDatabase, DemoStatement, Deps, Env } from '../types';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};

export interface TestDb {
  db: DemoDatabase;
  sqlite: SqliteDatabase;
  /** Runs before every statement: lets a test interleave other work. */
  beforeStatement: { current: ((sql: string) => Promise<void>) | null };
  statements: string[];
}

/** A tiny D1-like adapter over real SQLite, with the migration applied. */
export function createTestDb(): TestDb {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync(
      fileURLToPath(new URL('../../migrations/0001_tenant_registry.sql', import.meta.url)),
      'utf8'
    )
  );
  const beforeStatement: TestDb['beforeStatement'] = { current: null };
  const statements: string[] = [];
  const db: DemoDatabase = {
    prepare(sql: string): DemoStatement {
      let params: unknown[] = [];
      const statement: DemoStatement = {
        bind(...values) {
          params = values;
          return statement;
        },
        async run() {
          statements.push(sql);
          await Promise.resolve();
          await beforeStatement.current?.(sql);
          const result = sqlite.prepare(sql).run(...params);
          return { meta: { changes: Number(result.changes) } };
        },
        async first<T>() {
          statements.push(sql);
          await Promise.resolve();
          await beforeStatement.current?.(sql);
          return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
        },
      };
      return statement;
    },
  };
  return { db, sqlite, beforeStatement, statements };
}

export const PORTAL = 'https://start.demo-test.example';
export const CONSOLE = 'https://console.demo-test.example';
export const API = 'https://api.demo-test.example';

export async function generateKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateJwk, publicJwk, publicKey: pair.publicKey };
}

export async function makeEnv(
  testDb: TestDb,
  overrides: Partial<Record<keyof Env, unknown>> = {}
): Promise<Env> {
  const { privateJwk } = await generateKey();
  return {
    DB: testDb.db,
    ADMIN_API_ORIGIN: API,
    CONSOLE_ORIGIN: CONSOLE,
    PORTAL_ORIGIN: PORTAL,
    TURNSTILE_SITE_KEY: 'site-key-1',
    TURNSTILE_SECRET_KEY: 'turnstile-secret-1',
    MACHINE_CLIENT_ID: 'machine-client-1',
    MACHINE_KEY_ID: 'machine-key-1',
    MACHINE_PRIVATE_JWK: JSON.stringify(privateJwk),
    IP_HASH_SECRET: 'ip-hash-secret-0123456789',
    MAX_ACTIVE_TENANTS: '50',
    MAX_STARTS_PER_IP_PER_DAY: '3',
    TENANT_TTL_HOURS: '12',
    ENVIRONMENT: 'production',
    ...overrides,
  } as Env;
}

export function configOf(env: Env): Config {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(`config: ${result.problems.join(',')}`);
  return result.config;
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestInit['redirect'];
}

type Handler = (call: Call) => Response | Promise<Response>;

export interface Upstream {
  deps: Deps;
  calls: Call[];
  clock: { now: number };
  /** Replace the handler of one endpoint ("POST /token" style key, matched on the path). */
  on(key: string, handler: Handler): void;
  count(key: string): number;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const SCOPES = REQUIRED_SCOPES.join(' ');

/** A fake Turnstile plus a fake Admin API, with a clock the tests move. */
export function createUpstream(): Upstream {
  resetAdminTokenCache();
  const calls: Call[] = [];
  const clock = { now: Date.UTC(2026, 10, 13, 12, 0, 0) };
  const handlers = new Map<string, Handler>();
  let tokenCounter = 0;
  handlers.set('POST challenges.cloudflare.com/turnstile/v0/siteverify', () =>
    json({ success: true, hostname: new URL(PORTAL).hostname })
  );
  handlers.set(`POST ${new URL(API).host}/token`, () =>
    json({
      access_token: `token-${(tokenCounter += 1)}`,
      token_type: 'Bearer',
      expires_in: 900,
      scope: SCOPES,
    })
  );
  handlers.set(`POST ${new URL(API).host}/api/admin/tenants`, () => json({ id: 'x' }, 202));
  handlers.set(`GET ${new URL(API).host}/api/admin/tenants/*/provisioning`, () =>
    json({ status: 'succeeded' })
  );
  handlers.set(`POST ${new URL(API).host}/api/admin/admin-invitations`, (call) => {
    const body = JSON.parse(call.body) as { email: string };
    return json(
      {
        id: 'inv-1',
        email: body.email,
        expires_at: 1,
        email_sent: false,
        code_delivery: 'response',
        code: 'SECRET-CODE-123',
        join_url: `${CONSOLE}/admin/join`,
      },
      201
    );
  });

  const keyOf = (call: Call): string[] => {
    const url = new URL(call.url);
    const path = url.pathname.replace(
      /^\/api\/admin\/tenants\/[^/]+\/provisioning$/,
      '/api/admin/tenants/*/provisioning'
    );
    return [`${call.method} ${url.host}${path}`];
  };
  const upstream: Upstream = {
    calls,
    clock,
    deps: {
      now: () => clock.now,
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, name) => {
          headers[name] = value;
        });
        const call: Call = {
          url: input,
          method: (init.method ?? 'GET').toUpperCase(),
          headers,
          body: typeof init.body === 'string' ? init.body : '',
          redirect: init.redirect,
        };
        calls.push(call);
        const handler = keyOf(call)
          .map((key) => handlers.get(key))
          .find(Boolean);
        if (!handler) throw new Error(`no fake for ${keyOf(call)[0]}`);
        return handler(call);
      },
    },
    on(key, handler) {
      handlers.set(key, handler);
    },
    count(key) {
      return calls.filter((call) => keyOf(call)[0] === key).length;
    },
  };
  return upstream;
}

export const K = {
  siteverify: 'POST challenges.cloudflare.com/turnstile/v0/siteverify',
  token: `POST ${new URL(API).host}/token`,
  create: `POST ${new URL(API).host}/api/admin/tenants`,
  provisioning: `GET ${new URL(API).host}/api/admin/tenants/*/provisioning`,
  invite: `POST ${new URL(API).host}/api/admin/admin-invitations`,
};

export function startRequest(
  options: {
    origin?: string | null;
    ip?: string | null;
    contentType?: string | null;
    body?: string;
    language?: string;
  } = {}
): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set('Origin', options.origin ?? PORTAL);
  if (options.ip !== null) headers.set('CF-Connecting-IP', options.ip ?? '203.0.113.7');
  if (options.contentType !== null) {
    headers.set('Content-Type', options.contentType ?? 'application/x-www-form-urlencoded');
  }
  if (options.language) headers.set('Accept-Language', options.language);
  return new Request(`${PORTAL}/start`, {
    method: 'POST',
    headers,
    body: options.body ?? 'cf-turnstile-response=good-token',
  });
}

export function cookieOf(response: Response): string | null {
  const header = response.headers.get('Set-Cookie');
  const match = header?.match(/__Host-demo_ticket=([^;]*)/);
  return match ? match[1] : null;
}

export function statusRequest(ticket: string | null): Request {
  return new Request(`${PORTAL}/status`, {
    headers: ticket ? { Cookie: `__Host-demo_ticket=${ticket}` } : {},
  });
}

export async function start(
  env: Env,
  upstream: Upstream,
  options: Parameters<typeof startRequest>[0] = {}
): Promise<Response> {
  return handleRequest(startRequest(options), env, upstream.deps);
}

export function allRows(testDb: TestDb): Array<Record<string, unknown>> {
  return testDb.sqlite.prepare('SELECT * FROM demo_tenants').all() as Array<
    Record<string, unknown>
  >;
}
