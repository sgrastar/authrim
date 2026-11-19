import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  TENANT_STATUS_PATH,
  readTenantStatus,
  subdomainTenantOf,
  tenantStatusHandler,
} from '../tenant-status';

type Row = { lifecycle_state: string | null } | null;

/** A D1 stand-in that answers the one query with `row`, or throws. */
function database(row: Row | Error) {
  const first = vi.fn(async () => {
    if (row instanceof Error) throw row;
    return row;
  });
  const bind = vi.fn(() => ({ first, all: async () => ({ results: row ? [row] : [] }) }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare } as unknown as D1Database, prepare, bind };
}

function environment(overrides: Partial<Env> = {}): Env {
  return { BASE_DOMAIN: 'example.com', ...overrides } as Env;
}

async function ask(
  host: string,
  env: Env
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get(TENANT_STATUS_PATH, tenantStatusHandler);
  const response = await app.fetch(
    new Request(`https://${host}${TENANT_STATUS_PATH}`, { headers: { Host: host } }),
    env
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('readTenantStatus', () => {
  it('is deleted for a platform row marked deleted', async () => {
    const { db, bind } = database({ lifecycle_state: 'deleted' });
    await expect(readTenantStatus(db, 'acme')).resolves.toBe('deleted');
    expect(bind).toHaveBeenCalledWith('acme');
  });

  it.each([
    'active',
    'deleting',
    'suspended',
    'frozen',
    'provisioning',
    'migration_read_only',
    'restore_pending',
    'restore_validating',
    'DELETED',
    '',
  ])('is unavailable for lifecycle %j', async (lifecycle) => {
    const { db } = database({ lifecycle_state: lifecycle });
    await expect(readTenantStatus(db, 'acme')).resolves.toBe('unavailable');
  });

  it('is unavailable for a tenant with no row', async () => {
    await expect(readTenantStatus(database(null).db, 'acme')).resolves.toBe('unavailable');
  });

  it('is unavailable when the lifecycle is null', async () => {
    const { db } = database({ lifecycle_state: null });
    await expect(readTenantStatus(db, 'acme')).resolves.toBe('unavailable');
  });

  it('is unavailable when the read fails', async () => {
    const { db } = database(new Error('D1_ERROR'));
    await expect(readTenantStatus(db, 'acme')).resolves.toBe('unavailable');
  });

  it('is unavailable without a database', async () => {
    await expect(readTenantStatus(undefined, 'acme')).resolves.toBe('unavailable');
  });
});

describe('subdomainTenantOf', () => {
  const request = (host: string, headers: Record<string, string> = {}) =>
    new Request(`https://acme.example.com${TENANT_STATUS_PATH}`, {
      headers: { Host: host, ...headers },
    });

  it.each([
    ['acme.example.com', 'acme'],
    ['ACME.Example.COM', 'acme'],
    ['acme.example.com:8443', 'acme'],
  ])('names the tenant of the subdomain host %s', (host, tenantId) => {
    expect(subdomainTenantOf(request(host), environment())).toEqual({
      tenantId,
      host: 'acme.example.com',
    });
  });

  it('accepts forwarded host headers that agree with the host', () => {
    const agreeing = request('acme.example.com', {
      'X-Authrim-Forwarded-Host': 'acme.example.com',
      'X-Forwarded-Host': 'ACME.example.com:443',
    });
    expect(subdomainTenantOf(agreeing, environment())?.tenantId).toBe('acme');
  });

  it.each([
    'login.other.example',
    'a.b.example.com',
    'example.com',
    'acme.example.com.',
    'acme.example.com.evil.test',
    'acme.example.com@evil.test',
    'acme_.example.com',
    '.example.com',
    '',
  ])('answers for no tenant on %j', (host) => {
    expect(subdomainTenantOf(request(host), environment())).toBeNull();
  });

  it.each(['X-Authrim-Forwarded-Host', 'X-Forwarded-Host'])(
    'answers for no tenant when %s names another host',
    (header) => {
      const conflicting = request('acme.example.com', { [header]: 'gone.example.com' });
      expect(subdomainTenantOf(conflicting, environment())).toBeNull();
      const fallback = request('not a host', { [header]: 'gone.example.com' });
      expect(subdomainTenantOf(fallback, environment())).toBeNull();
    }
  );

  describe('behind an ingress declared to rewrite Host', () => {
    const trusted = environment({ AUTHRIM_TRUST_FORWARDED_HOST: 'true' });

    it('reads the forwarded host instead of the transport host', () => {
      const rewritten = request('management.internal', {
        'X-Authrim-Forwarded-Host': 'gone.example.com',
        'X-Forwarded-Host': 'gone.example.com',
      });
      expect(subdomainTenantOf(rewritten, trusted)).toEqual({
        tenantId: 'gone',
        host: 'gone.example.com',
      });
      // Without that declaration the same headers disagree.
      expect(subdomainTenantOf(rewritten, environment())).toBeNull();
    });

    it('still refuses forwarded hosts that disagree with each other', () => {
      const split = request('management.internal', {
        'X-Authrim-Forwarded-Host': 'gone.example.com',
        'X-Forwarded-Host': 'acme.example.com',
      });
      expect(subdomainTenantOf(split, trusted)).toBeNull();
    });

    it('reads Host when nothing was forwarded', () => {
      expect(subdomainTenantOf(request('acme.example.com'), trusted)?.tenantId).toBe('acme');
    });
  });

  it('answers for no tenant on the base domain, even when it is the issuer of a tenant', () => {
    const env = environment({ NAKED_DOMAIN_AS_ISSUER: 'true', PRIMARY_TENANT_ID: 'gone' });
    expect(subdomainTenantOf(request('example.com'), env)).toBeNull();
  });

  it.each(['ADMIN_UI_URL', 'UI_URL'] as const)(
    'answers for no tenant on the host configured as %s',
    (setting) => {
      const env = environment({ [setting]: 'https://gone.example.com' });
      expect(subdomainTenantOf(request('gone.example.com'), env)).toBeNull();
      expect(subdomainTenantOf(request('acme.example.com'), env)?.tenantId).toBe('acme');
    }
  );

  it('answers for no tenant in single-tenant mode', () => {
    const env = environment({ BASE_DOMAIN: undefined });
    expect(subdomainTenantOf(request('acme.example.com'), env)).toBeNull();
  });
});

describe('GET /api/auth/tenant-status', () => {
  it('reports a deleted tenant on its subdomain host, uncached', async () => {
    const { db, bind } = database({ lifecycle_state: 'deleted' });
    const answer = await ask('acme.example.com', environment({ DB: db }));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'deleted', host: 'acme.example.com' });
    expect(answer.headers.get('Cache-Control')).toBe('no-store');
    expect(bind).toHaveBeenCalledWith('acme');
  });

  it('returns nothing but the status', async () => {
    const { db } = database({ lifecycle_state: 'active' });
    const answer = await ask('acme.example.com', environment({ DB: db }));
    expect(answer.body).toEqual({ status: 'unavailable' });
  });

  it('does not look up a custom domain, even when a deleted row would match', async () => {
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const answer = await ask('login.other.example', environment({ DB: db }));
    expect(answer.body).toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not look up the base domain when its primary tenant has a deleted row', async () => {
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const env = environment({ DB: db, NAKED_DOMAIN_AS_ISSUER: 'true', PRIMARY_TENANT_ID: 'gone' });
    expect((await ask('example.com', env)).body).toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not look up a host of the Admin UI when a deleted row would match', async () => {
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const env = environment({ DB: db, ADMIN_UI_URL: 'https://gone.example.com' });
    expect((await ask('gone.example.com', env)).body).toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not look up a tenant named only by a forwarded host', async () => {
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const app = new Hono<{ Bindings: Env }>();
    app.get(TENANT_STATUS_PATH, tenantStatusHandler);
    const response = await app.fetch(
      new Request(`https://acme.example.com${TENANT_STATUS_PATH}`, {
        headers: { Host: 'acme.example.com', 'X-Authrim-Forwarded-Host': 'gone.example.com' },
      }),
      environment({ DB: db })
    );
    await expect(response.json()).resolves.toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not look up anything in single-tenant mode', async () => {
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const answer = await ask('acme.example.com', environment({ DB: db, BASE_DOMAIN: undefined }));
    expect(answer.body).toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('is unavailable when storage fails', async () => {
    const { db } = database(new Error('D1_ERROR'));
    const answer = await ask('acme.example.com', environment({ DB: db }));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'unavailable' });
  });
});

describe('the management worker, with its real rate limiter', () => {
  it('refuses with 503 and reads nothing when the limiter has no storage', async () => {
    const { default: worker } = await import('../index');
    const { db, prepare } = database({ lifecycle_state: 'deleted' });
    const response = await worker.fetch(
      new Request(`https://gone.example.com${TENANT_STATUS_PATH}`, {
        headers: { Host: 'gone.example.com' },
      }),
      environment({ DB: db }),
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.not.toHaveProperty('status');
    expect(prepare).not.toHaveBeenCalled();
    // Loading the whole worker takes most of this.
  }, 30_000);
});
