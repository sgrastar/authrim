/**
 * Mutation-driven tests: strict request shape of the replication export control forwarder.
 */
import { describe, it, expect, vi } from 'vitest';
import app from '../index';
import worker from '../index';

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
const ID = 'grant-a';
const base = `https://issuer.example.test/api/replication-backups/${ID}/exports`;
const good = { Authorization: `Bearer ${'a'.repeat(64)}`, 'X-Tenant-Id': 'tenant-a' };

function fixture() {
  const forward = vi.fn(async (_r: Request) => Response.json({ delegated: true }));
  return { forward, env: { OP_MANAGEMENT: { fetch: forward } } };
}
const send = async (url: string, init: RequestInit, f = fixture()) => {
  const res = await worker.fetch(new Request(url, init), f.env, ctx);
  return { res, f };
};

describe('credential and tenant header shape', () => {
  it.each([
    ['uppercase hex', `Bearer ${'A'.repeat(64)}`],
    ['a 63 character token', `Bearer ${'a'.repeat(63)}`],
    ['a 65 character token', `Bearer ${'a'.repeat(65)}`],
    ['a non-hex token', `Bearer ${'g'.repeat(64)}`],
    ['another scheme', `Basic ${'a'.repeat(64)}`],
    ['a prefix before the scheme', `x Bearer ${'a'.repeat(64)}`],
  ])('denies %s', async (_label, authorization) => {
    const { res, f } = await send(base, {
      method: 'POST',
      headers: { ...good, Authorization: authorization },
    });
    expect(res.status).toBe(403);
    expect(f.forward).not.toHaveBeenCalled();
  });

  it.each([
    ['a space', 'tenant a'],
    ['a slash', 'tenant/a'],
    ['129 characters', 'a'.repeat(129)],
    ['an empty value', ''],
    ['a leading junk character', '!tenant'],
    ['a trailing junk character', 'tenant!'],
  ])('denies a tenant id with %s', async (_label, tenant) => {
    const { res, f } = await send(base, {
      method: 'POST',
      headers: { ...good, 'X-Tenant-Id': tenant },
    });
    expect(res.status).toBe(403);
    expect(f.forward).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(128), 'Tenant_1.2:x-y'])('accepts the tenant id %s', async (tenant) => {
    const { res } = await send(base, {
      method: 'POST',
      headers: { ...good, 'X-Tenant-Id': tenant },
    });
    expect(res.status).toBe(200);
  });

  it('denies with a no-store JSON body', async () => {
    const { res } = await send(base, { method: 'POST', headers: {} });
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'backup_replication_request_denied' });
  });
});

describe('path identifiers', () => {
  it('accepts a 128 character identifier and refuses 129', async () => {
    const okId = 'a'.repeat(128);
    const ok = await send(`https://issuer.example.test/api/replication-backups/${okId}/exports`, {
      method: 'POST',
      headers: good,
    });
    expect(ok.res.status).toBe(200);
    // Not an export-control path, so it goes through the router app, which denies it.
    const longId = 'a'.repeat(129);
    const denied = await send(
      `https://issuer.example.test/api/replication-backups/${longId}/exports`,
      {
        method: 'POST',
        headers: good,
      }
    );
    expect(denied.f.forward).not.toHaveBeenCalled();
  });

  it('refuses identifiers with characters outside the set', async () => {
    const { f } = await send('https://issuer.example.test/api/replication-backups/a%20b/exports', {
      method: 'POST',
      headers: good,
    });
    expect(f.forward).not.toHaveBeenCalled();
  });

  it('matches whole paths only', async () => {
    for (const url of [
      `${base}/op-1/start/extra`,
      `${base}x`,
      `https://issuer.example.test/x/api/replication-backups/${ID}/exports`,
    ]) {
      const { f } = await send(url, { method: 'POST', headers: good });
      expect(f.forward).not.toHaveBeenCalled();
    }
  });

  it('refuses the wrong method for each shape', async () => {
    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', '/op-1'],
      ['POST', '/op-1/export-receipt'],
      ['POST', '/op-1/download'],
      ['GET', '/op-1/start'],
      ['GET', '/op-1/key-challenges'],
    ] as const) {
      const { f } = await send(base + suffix, { method, headers: good });
      expect(f.forward).not.toHaveBeenCalled();
    }
  });
});

describe('forwarding', () => {
  it('forwards the POST body bytes (up to 4096) and the credentials', async () => {
    const body = 'b'.repeat(4096);
    const { res, f } = await send(base, { method: 'POST', headers: good, body });
    expect(res.status).toBe(200);
    const r = f.forward.mock.calls[0][0];
    expect(await r.text()).toBe(body);
    expect(r.method).toBe('POST');
    expect(r.headers.get('Authorization')).toBe(good.Authorization);
    expect(r.headers.get('X-Tenant-Id')).toBe('tenant-a');
  });

  it('forwards a GET without a body', async () => {
    const { f } = await send(`${base}/op-1`, { method: 'GET', headers: good });
    const r = f.forward.mock.calls[0][0];
    expect(r.method).toBe('GET');
    expect(r.body).toBeNull();
  });

  it('answers 503 when Management cannot be reached', async () => {
    const f = fixture();
    f.forward.mockRejectedValueOnce(new Error('down'));
    const { res } = await send(base, { method: 'POST', headers: good }, f);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'backup_replication_request_denied' });
  });

  it('answers 413 for an oversized body', async () => {
    const { res, f } = await send(base, { method: 'POST', headers: good, body: 'c'.repeat(4097) });
    expect(res.status).toBe(413);
    expect(f.forward).not.toHaveBeenCalled();
  });
});

describe('through the router app for non-listed shapes', () => {
  it('denies unknown replication paths with 403 and no-store', async () => {
    const f = fixture();
    const res = await app.fetch(
      new Request('https://issuer.example.test/api/replication-backups/x/other', { headers: good }),
      f.env
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(f.forward).not.toHaveBeenCalled();
  });

  it('denies unknown replication-environments paths too', async () => {
    const f = fixture();
    const res = await app.fetch(
      new Request('https://issuer.example.test/api/replication-environments/x/other', {
        headers: good,
      }),
      f.env
    );
    expect(res.status).toBe(403);
  });
});
