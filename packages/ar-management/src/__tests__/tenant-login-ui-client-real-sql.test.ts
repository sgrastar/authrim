import { describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted((): { source: object | undefined; fail: boolean } => ({
  source: undefined,
  fail: false,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantDatabaseSourceFromRegistry: vi.fn(async () => {
      if (registry.fail) throw new Error('registry unavailable');
      return { source: registry.source };
    }),
  };
});

import { getClient, getWebOriginRegistry, type Env } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  ensureTenantLoginUiClient,
  resolveLoginUiClientId,
  resolveTenantLoginUiOrigin,
} from '../tenant-login-ui-client';
import { LOGIN_UI_CLIENT_DESCRIPTION, LOGIN_UI_CLIENT_NAME } from '../login-ui-client-metadata';

const env = { BASE_DOMAIN: 'idp.example.test' } as unknown as Env;

function addTenant(db: ReturnType<typeof openCoreStore>['db'], id: string) {
  db.prepare(
    `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, `code-${id}`, `key-${id}`, `Tenant ${id}`);
}

function clientCount(db: ReturnType<typeof openCoreStore>['db'], tenantId: string): number {
  return Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM oauth_clients WHERE tenant_id = ?').get(tenantId) as {
        n: number;
      }
    ).n
  );
}

describe('ensureTenantLoginUiClient (real SQL)', () => {
  it('creates the client under the given id with exactly the tenant origin', async () => {
    const { adapter } = openCoreStore('tenant-a');

    const result = await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    expect(result).toEqual({
      status: 'created',
      clientId: 'login-client-1',
      origin: 'https://tenant-a.idp.example.test',
    });
    const client = await getClient(env, 'tenant-a', 'login-client-1', adapter);
    expect(client).not.toBeNull();
    expect(client?.client_name).toBe(LOGIN_UI_CLIENT_NAME);
    expect(client?.token_endpoint_auth_method).toBe('none');
    expect([...(client?.redirect_uris ?? [])].sort()).toEqual(
      [
        'https://tenant-a.idp.example.test/callback',
        'https://tenant-a.idp.example.test/ciba/callback',
        'https://tenant-a.idp.example.test/device/callback',
        'https://tenant-a.idp.example.test/reauth/callback',
      ].sort()
    );
    const registry = await getWebOriginRegistry(env, 'tenant-a', 'login-client-1', adapter);
    expect(registry.origins.map((entry) => entry.origin)).toEqual([
      'https://tenant-a.idp.example.test',
    ]);
    expect(registry.origins[0]?.handoff_allowed).toBe(true);
    expect(registry.origins[0]?.iframe_allowed).toBe(false);
  });

  it('leaves the client as a public PKCE browser client the Login UI channel accepts', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    const row = db
      .prepare(
        `SELECT application_type, allowed_channels, require_pkce, is_trusted, skip_consent,
                client_secret_hash, browser_public_client_mode, browser_refresh_token_policy,
                grant_types, allowed_redirect_origins
           FROM oauth_clients WHERE tenant_id = ? AND client_id = ?`
      )
      .get('tenant-a', 'login-client-1') as Record<string, unknown>;
    // What validateDirectAuthClient reads: the browser channel is open (no native type, no
    // channel list) and the origin allowlist comes from the registry.
    expect(row.application_type).toBe('web');
    expect(row.allowed_channels).toBeNull();
    expect(row.require_pkce).toBe(1);
    expect(row.is_trusted).toBe(1);
    expect(row.skip_consent).toBe(1);
    expect(row.client_secret_hash).toBeNull();
    expect(row.browser_public_client_mode).toBe('cookie_fallback');
    expect(row.browser_refresh_token_policy).toBe('disabled');
    expect(JSON.parse(String(row.grant_types))).toEqual(['authorization_code']);
    expect(row.allowed_redirect_origins).toBeNull();
  });

  it('is a no-op the second time', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');
    const before = db.prepare('SELECT * FROM oauth_clients WHERE tenant_id = ?').all('tenant-a');

    const second = await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    expect(second.status).toBe('exists');
    expect(clientCount(db, 'tenant-a')).toBe(1);
    expect(db.prepare('SELECT * FROM oauth_clients WHERE tenant_id = ?').all('tenant-a')).toEqual(
      before
    );
    expect(
      Number(
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM web_origin_registry WHERE tenant_id = ?')
            .get('tenant-a') as { n: number }
        ).n
      )
    ).toBe(1);
  });

  it('completes the web origins when a run stopped after the client was written', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');
    db.prepare('DELETE FROM web_origin_registry WHERE tenant_id = ?').run('tenant-a');

    const retry = await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    expect(retry.status).toBe('exists');
    const registry = await getWebOriginRegistry(env, 'tenant-a', 'login-client-1', adapter);
    expect(registry.origins).toHaveLength(1);
  });

  it('keeps tenants apart when they share the client id', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    addTenant(db, 'tenant-b');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    // Tenant B has no such client until its own is made.
    expect(await getClient(env, 'tenant-b', 'login-client-1', adapter)).toBeNull();
    await ensureTenantLoginUiClient(env, adapter, 'tenant-b', 'login-client-1');

    const a = await getClient(env, 'tenant-a', 'login-client-1', adapter);
    const b = await getClient(env, 'tenant-b', 'login-client-1', adapter);
    expect(a?.redirect_uris.every((uri) => uri.startsWith('https://tenant-a.'))).toBe(true);
    expect(b?.redirect_uris.every((uri) => uri.startsWith('https://tenant-b.'))).toBe(true);
    const registryB = await getWebOriginRegistry(env, 'tenant-b', 'login-client-1', adapter);
    expect(registryB.origins.map((entry) => entry.origin)).toEqual([
      'https://tenant-b.idp.example.test',
    ]);
    // Removing B's leaves A's.
    db.prepare('DELETE FROM oauth_clients WHERE tenant_id = ?').run('tenant-b');
    expect(await getClient(env, 'tenant-a', 'login-client-1', adapter)).not.toBeNull();
    expect(
      Number(
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM web_origin_registry WHERE tenant_id = ?')
            .get('tenant-b') as { n: number }
        ).n
      )
    ).toBe(0);
  });

  it('refuses to overwrite a different client that has the same id', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    db.prepare(
      `INSERT INTO oauth_clients (client_id, tenant_id, client_name, redirect_uris, grant_types,
                                  response_types, token_endpoint_auth_method, created_at, updated_at)
       VALUES ('login-client-1', 'tenant-a', 'Somebody else', '["https://evil.example/cb"]',
               '["authorization_code"]', '["code"]', 'none', 1, 1)`
    ).run();

    await expect(
      ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1')
    ).rejects.toThrow('tenant_login_ui_client_conflict');

    const row = db
      .prepare('SELECT client_name, redirect_uris FROM oauth_clients WHERE tenant_id = ?')
      .get('tenant-a') as { client_name: string; redirect_uris: string };
    expect(row.client_name).toBe('Somebody else');
    expect(row.redirect_uris).toBe('["https://evil.example/cb"]');
  });

  it('does nothing without a tenant host', async () => {
    const { db, adapter } = openCoreStore('tenant-a');

    const result = await ensureTenantLoginUiClient(
      {} as Env,
      adapter,
      'tenant-a',
      'login-client-1'
    );

    expect(result).toEqual({ status: 'skipped', reason: 'origin_unavailable' });
    expect(clientCount(db, 'tenant-a')).toBe(0);
  });

  it('removes its web origins with the client', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');

    db.prepare('DELETE FROM oauth_clients WHERE tenant_id = ?').run('tenant-a');

    expect(
      Number(
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM web_origin_registry WHERE tenant_id = ?')
            .get('tenant-a') as { n: number }
        ).n
      )
    ).toBe(0);
  });
});

describe('resolveTenantLoginUiOrigin', () => {
  it('comes from the deployment and the tenant id only', () => {
    expect(resolveTenantLoginUiOrigin(env, 'tenant-a')).toBe('https://tenant-a.idp.example.test');
    expect(resolveTenantLoginUiOrigin({} as Env, 'tenant-a')).toBeNull();
  });

  it('refuses a tenant whose host is the common Login UI, Admin UI or issuer host', () => {
    const withUi = {
      BASE_DOMAIN: 'idp.example.test',
      UI_URL: 'https://login.idp.example.test',
      ADMIN_UI_URL: 'https://admin.idp.example.test',
      ISSUER_URL: 'https://api.idp.example.test',
    } as unknown as Env;
    for (const id of ['login', 'admin', 'api']) {
      expect(() => resolveTenantLoginUiOrigin(withUi, id)).toThrow('tenant_login_ui_host_reserved');
    }
    expect(resolveTenantLoginUiOrigin(withUi, 'tenant-a')).toBe(
      'https://tenant-a.idp.example.test'
    );
  });

  it('makes no client for a reserved host', async () => {
    const { db, adapter } = openCoreStore('login');
    const reserved = {
      BASE_DOMAIN: 'idp.example.test',
      UI_URL: 'https://login.idp.example.test',
    } as unknown as Env;
    await expect(ensureTenantLoginUiClient(reserved, adapter, 'login', 'c1')).rejects.toThrow(
      'tenant_login_ui_host_reserved'
    );
    expect(clientCount(db, 'login')).toBe(0);
  });
});

describe('a clone: cleanup, then the target ends with its own client', () => {
  it('has exactly one Login UI client with the target origin, also after a retry', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    addTenant(db, 'tenant-b');
    await ensureTenantLoginUiClient(env, adapter, 'tenant-a', 'login-client-1');
    // The target's seed, then the clone's cleanup removes it, the copy leaves the source's
    // Login UI client out, and the target's own is made again. Twice: a retry.
    await ensureTenantLoginUiClient(env, adapter, 'tenant-b', 'login-client-1');
    for (let run = 0; run < 2; run += 1) {
      db.prepare('DELETE FROM web_origin_registry WHERE tenant_id = ?').run('tenant-b');
      db.prepare('DELETE FROM oauth_clients WHERE tenant_id = ?').run('tenant-b');
      await ensureTenantLoginUiClient(env, adapter, 'tenant-b', 'login-client-1');
    }
    // A retry that does not clean up first is a no-op, not a conflict.
    await ensureTenantLoginUiClient(env, adapter, 'tenant-b', 'login-client-1');

    expect(clientCount(db, 'tenant-b')).toBe(1);
    const b = await getClient(env, 'tenant-b', 'login-client-1', adapter);
    expect(b?.redirect_uris.every((uri) => uri.startsWith('https://tenant-b.'))).toBe(true);
    const registryB = await getWebOriginRegistry(env, 'tenant-b', 'login-client-1', adapter);
    expect(registryB.origins.map((entry) => entry.origin)).toEqual([
      'https://tenant-b.idp.example.test',
    ]);
    const a = await getClient(env, 'tenant-a', 'login-client-1', adapter);
    expect(a?.redirect_uris.every((uri) => uri.startsWith('https://tenant-a.'))).toBe(true);
  });
});

describe('resolveLoginUiClientId', () => {
  const insertClient = (db: ReturnType<typeof openCoreStore>['db'], id: string) =>
    db
      .prepare(
        `INSERT INTO oauth_clients (client_id, tenant_id, client_name, description, redirect_uris,
           grant_types, response_types, token_endpoint_auth_method, is_trusted, require_pkce,
           created_at, updated_at)
         VALUES (?, 'tenant-a', ?, ?, '[]', '["authorization_code"]', '["code"]', 'none', 1, 1, 1, 1)`
      )
      .run(id, LOGIN_UI_CLIENT_NAME, LOGIN_UI_CLIENT_DESCRIPTION);
  const initial = { PRIMARY_TENANT_ID: 'tenant-a' } as unknown as Env;

  it('uses the deployment variable', async () => {
    expect(
      await resolveLoginUiClientId({ LOGIN_UI_CLIENT_ID: ' configured-id ' } as unknown as Env)
    ).toBe('configured-id');
  });

  it('fails on a variable that is not a plain identifier', async () => {
    await expect(
      resolveLoginUiClientId({ LOGIN_UI_CLIENT_ID: 'a b/../c' } as unknown as Env)
    ).rejects.toThrow('login_ui_client_id_invalid');
  });

  it('uses the initial tenant single Login UI client', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    registry.fail = false;
    registry.source = adapter;
    insertClient(db, 'generated-id');
    expect(await resolveLoginUiClientId(initial)).toBe('generated-id');
  });

  it('falls back to login-ui only when the lookup worked and found none', async () => {
    const { adapter } = openCoreStore('tenant-a');
    registry.fail = false;
    registry.source = adapter;
    expect(await resolveLoginUiClientId(initial)).toBe('login-ui');
  });

  it('fails on two candidates instead of guessing', async () => {
    const { db, adapter } = openCoreStore('tenant-a');
    registry.fail = false;
    registry.source = adapter;
    insertClient(db, 'real-id');
    insertClient(db, 'look-alike');
    await expect(resolveLoginUiClientId(initial)).rejects.toThrow('login_ui_client_id_ambiguous');
  });

  it('fails when the initial tenant store cannot be read', async () => {
    registry.fail = true;
    try {
      await expect(resolveLoginUiClientId(initial)).rejects.toThrow(
        'login_ui_client_id_lookup_failed'
      );
    } finally {
      registry.fail = false;
    }
  });
});
