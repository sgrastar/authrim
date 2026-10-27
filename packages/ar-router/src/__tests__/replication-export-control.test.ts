import { describe, expect, it, vi } from 'vitest';
import worker from '../index';
const base = 'https://issuer.example.test/api/replication-backups/grant-a/exports';
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
const headers = { Authorization: `Bearer ${'a'.repeat(64)}`, 'X-Tenant-Id': 'tenant-a' };
function fixture() {
  const forward = vi.fn(async (_request: Request) => Response.json({ delegated: true }));
  const acquire = vi.fn(async () => ({ admitted: false }));
  return {
    forward,
    acquire,
    env: {
      OP_MANAGEMENT: { fetch: forward },
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: {
        acquireEnvironmentBackupMutationPermit: acquire,
        completeEnvironmentBackupMutationPermit: vi.fn(),
      },
    },
  };
}
describe('narrow public export control forwarding during source drain', () => {
  it.each([
    ['POST', ''],
    ['GET', '/operation-a'],
    ['GET', '/operation-a/export-receipt'],
    ['GET', '/operation-a/download'],
    ['POST', '/operation-a/key-challenges'],
    ['POST', '/operation-a/key-challenges/challenge-a/accept'],
    ['POST', '/operation-a/start'],
  ])(
    'forwards %s %s only to the grant-authenticating Management surface',
    async (method, suffix) => {
      const f = fixture();
      const response = await worker.fetch(
        new Request(base + suffix, { method, headers }),
        f.env,
        context
      );
      expect(response.status).toBe(200);
      expect(f.forward).toHaveBeenCalledOnce();
      expect(f.acquire).not.toHaveBeenCalled();
    }
  );
  it.each(['http', 'no-credential', 'no-tenant', 'query-token', 'oversized'])(
    'rejects %s before any downstream call',
    async (kind) => {
      const f = fixture();
      const h: Record<string, string> = { ...headers };
      if (kind === 'no-credential') delete h.Authorization;
      if (kind === 'no-tenant') delete h['X-Tenant-Id'];
      const response = await worker.fetch(
        new Request(
          kind === 'http'
            ? base.replace('https:', 'http:')
            : base + (kind === 'query-token' ? '?access_token=secret' : ''),
          {
            method: 'POST',
            headers: h,
            ...(kind === 'oversized' ? { body: 'a'.repeat(4097) } : {}),
          }
        ),
        f.env,
        context
      );
      expect(response.status).toBe(kind === 'oversized' ? 413 : 403);
      expect(f.forward).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['POST', '/operation-a/approve'],
    ['DELETE', '/operation-a'],
    ['POST', '/operation-a/cancel'],
    ['POST', '/../users'],
  ])('keeps unrelated %s %s behind the normal writer guard', async (method, suffix) => {
    const f = fixture();
    const response = await worker.fetch(
      new Request(base + suffix, { method, headers }),
      f.env,
      context
    );
    expect(response.status).toBe(503);
    expect(f.forward).not.toHaveBeenCalled();
    expect(f.acquire).toHaveBeenCalledOnce();
  });
  it('strips browser cookies and forged Login UI trust headers and propagates actual downstream auth denial', async () => {
    const f = fixture();
    f.forward.mockResolvedValue(
      Response.json({ error: 'backup_replication_grant_denied' }, { status: 403 })
    );
    const response = await worker.fetch(
      new Request(base, {
        method: 'POST',
        headers: {
          ...headers,
          Cookie: 'admin=private',
          'X-Authrim-Login-UI': 'true',
          'X-Authrim-Browser-Origin': 'https://attacker.example',
          'X-Authrim-Original-Host': 'attacker.example',
        },
      }),
      f.env,
      context
    );
    expect(response.status).toBe(403);
    const request = f.forward.mock.calls[0]?.[0] as Request | undefined;
    expect(request?.headers.get('Cookie')).toBeNull();
    expect(request?.headers.get('X-Authrim-Browser-Origin')).toBeNull();
    expect(request?.headers.get('X-Authrim-Forwarded-Host')).toBe('issuer.example.test');
  });
});
it('permits only authenticated metadata inventory GET during the global drain', async () => {
  const f = fixture();
  const path = 'https://issuer.example.test/api/replication-environments/grant-a/inventory';
  expect((await worker.fetch(new Request(path, { headers }), f.env, context)).status).toBe(200);
  expect(f.acquire).not.toHaveBeenCalled();
  expect(f.forward).toHaveBeenCalledOnce();
  for (const suffix of ['/users', '/extra']) {
    expect(
      (await worker.fetch(new Request(path + suffix, { headers }), f.env, context)).status
    ).toBe(503);
  }
  expect(
    (await worker.fetch(new Request(path, { method: 'POST', headers }), f.env, context)).status
  ).toBe(503);
  expect(f.forward).toHaveBeenCalledOnce();
});
