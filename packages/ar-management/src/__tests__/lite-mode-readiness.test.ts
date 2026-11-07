import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
const DatabaseSync = SqliteDatabase as unknown as new (path: string) => Database;

interface ReadinessMocks {
  adapter: unknown;
  builtIn: Record<string, boolean>;
  directoryPassword: boolean;
  canonicalIssuer: string | null;
}

const mocks = vi.hoisted(
  (): ReadinessMocks => ({
    adapter: null,
    builtIn: {},
    directoryPassword: false,
    canonicalIssuer: null,
  })
);

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: () => ({ coreAdapter: mocks.adapter }),
  };
});
vi.mock('@authrim/ar-lib-core/services/tenant-vanity-domain-resolver', () => ({
  buildCanonicalTenantIssuerUrl: async (_env: unknown, _tenant: string, fallback: string) =>
    mocks.canonicalIssuer ?? fallback,
}));
vi.mock('../authentication-methods', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authentication-methods')>()),
  resolveBuiltInAuthenticationMethods: async () => ({
    passkeyLoginEnabled: true,
    passkeySignupEnabled: true,
    passkeyReauthEnabled: false,
    passkeyAccountLinkEnabled: false,
    emailCodeLoginEnabled: true,
    emailCodeSignupEnabled: false,
    emailCodeReauthEnabled: false,
    emailCodeAccountLinkEnabled: false,
    totpLoginEnabled: false,
    totpSignupEnabled: false,
    totpReauthEnabled: false,
    totpAccountLinkEnabled: false,
    ...mocks.builtIn,
  }),
  resolveDirectoryPasswordMethod: async () => ({ enabled: mocks.directoryPassword, label: 'x' }),
}));

import {
  evaluateLiteReadiness,
  liteAccountPageIssuesFromLoginUISettings,
  liteIssuesOfFlowRuntime,
  liteIssuesOfScreenRemoval,
  liteMethodIssuesFromAuthenticationMethods,
  liteMethodsOnInAuthenticationMethods,
} from '../lite-mode-readiness';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORE_SCHEMA = readRenderedMigrationSql(
  resolve(REPO_ROOT, 'migrations/core/d1'),
  '001_0_5_0_core_baseline.sql'
);

let db: Database;
let kv: Map<string, string>;

function context(env: Record<string, unknown> = {}, tenantMetadata?: unknown) {
  return {
    get: (key: string) => (key === 'tenantMetadataContext' ? tenantMetadata : undefined),
    env: {
      BASE_DOMAIN: 'id.example',
      LOGIN_UI_LITE_PRERELEASE: 'allow',
      LITE_POLICY_STORE: { idFromName: (n: string) => n, get: () => ({}) },
      SETTINGS: { get: async (key: string) => kv.get(key) ?? null },
      ...env,
    },
  } as never;
}

const screenFields = (fields: unknown[]) => JSON.stringify(fields);

function insertScreen(tenant: string, key: string, kind: string, fields: unknown[], system = 0) {
  db.prepare(
    `INSERT INTO screens (id, tenant_id, screen_key, display_name, screen_kind, fields_json,
       is_active, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, 0)`
  ).run(`${tenant}-${key}`, tenant, key, key, kind, screenFields(fields), system);
}

describe('evaluateLiteReadiness', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(CORE_SCHEMA);
    db.exec('PRAGMA foreign_keys = OFF');
    mocks.adapter = {
      query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      queryOne: async (sql: string, params: unknown[] = []) =>
        db.prepare(sql).get(...params) ?? null,
    };
    kv = new Map();
    mocks.builtIn = {};
    mocks.directoryPassword = false;
    mocks.canonicalIssuer = null;
  });

  it('finds nothing for a tenant on the seeded system screens with supported methods', async () => {
    await expect(evaluateLiteReadiness(context(), 'tenant-a')).resolves.toEqual([]);
  });

  it('reports the release lock and a missing policy store', async () => {
    const issues = await evaluateLiteReadiness(
      context({ LOGIN_UI_LITE_PRERELEASE: undefined, LITE_POLICY_STORE: undefined }),
      'tenant-a'
    );
    expect(issues).toEqual([{ code: 'not_released' }, { code: 'policy_store_unavailable' }]);
  });

  it('reports the directory password, DID sign-in and the screens that offer them', async () => {
    mocks.directoryPassword = true;
    kv.set(
      'settings:tenant:tenant-a:authentication-methods',
      JSON.stringify({ 'authentication-methods.did.login_enabled': true })
    );
    insertScreen('tenant-a', 'login', 'login', [
      {
        field: 'd',
        label: 'D',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'directory_password',
      },
    ]);
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([
      { code: 'method_unsupported', subject: 'did' },
      { code: 'method_unsupported', subject: 'directory_password' },
      { code: 'screen_method_unsupported', subject: 'login', detail: 'directory_password' },
    ]);
  });

  it('reports assigned sign-in Flows with components the lite UI cannot drive', async () => {
    db.prepare(
      `INSERT INTO flows (id, tenant_id, profile_id, name, graph_definition, kind, status,
         published_version_id, created_at, updated_at)
       VALUES ('flow-1', 'tenant-a', 'p', 'F', '{}', 'login', 'published', 'v1', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO flow_versions (id, tenant_id, flow_id, version_number, schema_version,
         runtime_snapshot_json, editor_snapshot_json, validation_result_json, published_at, created_at)
       VALUES ('v1', 'tenant-a', 'flow-1', 1, 1, ?, '{}', '{}', 0, 0)`
    ).run(
      JSON.stringify({
        flow_kind: 'login',
        ui: {
          steps: [
            { component: 'interaction_context' },
            { component: 'credential_offer' },
            { component: 'screen', config: { screen_ref: 'terms_v2' } },
            { component: 'authentication_method_selector', config: { screen_ref: 'login' } },
          ],
        },
      })
    );
    db.prepare(
      `INSERT INTO flow_assignments (id, tenant_id, target_type, target_id, flow_kind, flow_id,
         enabled, created_at, updated_at)
       VALUES ('a1', 'tenant-a', 'tenant', NULL, 'login', 'flow-1', 1, 0, 0)`
    ).run();
    // `login` falls back to the system screen; `terms_v2` resolves to nothing.
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'credential_offer' },
      { code: 'flow_screen_missing', subject: 'flow-1', detail: 'terms_v2' },
    ]);
    insertScreen('tenant-a', 'terms_v2', 'custom', [
      { field: 'h', label: 'H', required: false, block_type: 'heading' },
    ]);
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'credential_offer' },
    ]);
    // Removing the screen a step names by key (not a built-in key) loses it.
    expect(
      await liteIssuesOfScreenRemoval(mocks.adapter as never, 'tenant-a', {
        id: 'tenant-a-terms_v2',
        screen_key: 'terms_v2',
      })
    ).toEqual([{ code: 'flow_screen_missing', subject: 'flow-1', detail: 'terms_v2' }]);
    // `basic_profile` always resolves (the step's screen, else a system one).
    expect(
      await liteIssuesOfScreenRemoval(mocks.adapter as never, 'tenant-a', {
        id: 'x',
        screen_key: 'basic_profile',
      })
    ).toEqual([]);
    // Removing the tenant's own `login` keeps the system one.
    expect(
      await liteIssuesOfScreenRemoval(mocks.adapter as never, 'tenant-a', {
        id: 'tenant-a-login',
        screen_key: 'login',
      })
    ).toEqual([]);
  });

  it('takes a tenant whose accounts are made asynchronously (the lite sign-up resumes them)', async () => {
    for (const allocationScope of ['shared_pool', 'tenant_exclusive']) {
      expect(
        await evaluateLiteReadiness(context({}, { route: { allocationScope } }), 'tenant-a')
      ).toEqual([]);
    }
  });

  it('reports an account page at a path of its own (the lite UI serves /account only)', async () => {
    kv.set(
      'settings:tenant:tenant-a:self-service',
      JSON.stringify({ 'self-service.account_page_path': '/my-account' })
    );
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([
      { code: 'account_page_path_custom' },
    ]);
    kv.set(
      'settings:tenant:tenant-a:self-service',
      JSON.stringify({ 'self-service.account_page_path': '/account' })
    );
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([]);
  });

  it('reports applications with their own Login UI and another issuer origin', async () => {
    db.prepare(
      `INSERT INTO oauth_clients (client_id, tenant_id, client_name, redirect_uris, grant_types,
         response_types, login_ui_url, created_at, updated_at)
       VALUES ('app-1', 'tenant-a', 'App', '[]', '[]', '[]', 'https://app.example/login', 0, 0)`
    ).run();
    mocks.canonicalIssuer = 'https://login.customer.example';
    expect(await evaluateLiteReadiness(context(), 'tenant-a')).toEqual([
      { code: 'client_login_ui_url', subject: 'app-1' },
      { code: 'issuer_origin_mismatch' },
    ]);
  });
});

describe('lite readiness of single documents', () => {
  it('reads unsupported methods from an authentication-methods document', () => {
    expect(liteMethodIssuesFromAuthenticationMethods(null)).toEqual([]);
    expect(
      liteMethodIssuesFromAuthenticationMethods({
        'authentication-methods.directory_password.enabled': true,
      })
    ).toEqual([{ code: 'method_unsupported', subject: 'directory_password' }]);
  });

  it('reads an unreadable Flow snapshot as unsupported', async () => {
    expect(await liteIssuesOfFlowRuntime(null as never, 'tenant-a', 'flow-1', '{bad')).toEqual([
      { code: 'flow_component_unsupported', subject: 'flow-1', detail: 'unreadable' },
    ]);
  });

  it('finds nothing in the published account page (snapshots hold account blocks only)', () => {
    expect(liteAccountPageIssuesFromLoginUISettings(null)).toEqual([]);
    expect(
      liteAccountPageIssuesFromLoginUISettings({ 'login-ui.account_pages': '{not json' })
    ).toEqual([]);
  });
});

describe('liteMethodsOnInAuthenticationMethods', () => {
  it('reads the methods a document leaves on, with the defaults and older switches', () => {
    // Nothing saved: passkeys are on by default, email codes and TOTP off.
    expect(liteMethodsOnInAuthenticationMethods({})).toEqual(new Set(['passkey']));
    expect(
      liteMethodsOnInAuthenticationMethods({
        'authentication-methods.passkey.enabled': false,
        'authentication-methods.email_otp.login_enabled': true,
        'authentication-methods.totp.enabled': true,
      })
    ).toEqual(new Set(['mail_otp', 'totp', 'mail_otp_totp']));
    // Saving a method off keeps it off.
    expect(
      liteMethodsOnInAuthenticationMethods({
        'authentication-methods.passkey.enabled': false,
        'authentication-methods.email_otp.login_enabled': false,
      })
    ).toEqual(new Set());
  });
});
