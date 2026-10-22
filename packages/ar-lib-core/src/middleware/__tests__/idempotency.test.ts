import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
}));

vi.mock('../../context/hono-context', () => ({
  createAuthContextFromHono: vi.fn(() => ({
    coreAdapter: mockAdapter,
  })),
}));

import {
  cleanupExpiredIdempotencyKeys,
  IDEMPOTENCY_RESERVATION_RETENTION_SECONDS,
  idempotencyMiddleware,
  markIdempotentResponseRetryable,
  requiredIdempotencyMiddleware,
} from '../idempotency';

const mockEnv = { DEFAULT_TENANT_ID: 'default' };

async function hashBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashBytes(body: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createApp(middleware = idempotencyMiddleware(), tenantId: string | null = 'tenant-a') {
  const app = new Hono();
  if (tenantId) {
    app.use('*', async (c, next) => {
      c.set('tenantId', tenantId);
      await next();
    });
  }
  app.use('/protected', middleware);
  app.post('/protected', async (c) =>
    c.json(
      {
        ok: true,
        email: 'private@example.com',
      },
      201
    )
  );
  return app;
}

describe('idempotency middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it('allows missing Idempotency-Key in best-effort mode', async () => {
    const res = await createApp().request(
      '/protected',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects missing Idempotency-Key when required', async () => {
    const res = await createApp(requiredIdempotencyMiddleware()).request(
      '/protected',
      {
        method: 'POST',
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );
    const payload = (await res.json()) as { error: string; error_description: string };

    expect(res.status).toBe(400);
    expect(payload.error).toBe('invalid_request');
    expect(payload.error_description).toContain('Idempotency-Key');
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects idempotent requests without tenant context', async () => {
    const res = await createApp(requiredIdempotencyMiddleware(), null).request(
      '/protected',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'idem-key-001',
        },
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );
    const payload = (await res.json()) as { error: string; error_description: string };

    expect(res.status).toBe(400);
    expect(payload.error).toBe('invalid_request');
    expect(payload.error_description).toContain('Tenant context');
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('returns the cached response for the same key and body', async () => {
    const body = JSON.stringify({ action: 'write' });
    mockAdapter.queryOne.mockResolvedValue({
      id: 'idempotency-key-001',
      body_hash: await hashBody(body),
      response_status: 202,
      response_body: JSON.stringify({ accepted: true }),
    });

    const res = await createApp(requiredIdempotencyMiddleware()).request(
      '/protected',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'idem-key-001',
        },
        body,
      },
      mockEnv
    );
    const payload = (await res.json()) as { accepted: boolean };

    expect(res.status).toBe(202);
    expect(payload.accepted).toBe(true);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different body as an idempotency conflict', async () => {
    mockAdapter.queryOne.mockResolvedValue({
      id: 'idempotency-key-001',
      body_hash: 'different-body-hash',
      response_status: 201,
      response_body: JSON.stringify({ ok: true }),
    });

    const res = await createApp(requiredIdempotencyMiddleware()).request(
      '/protected',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'idem-key-001',
        },
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );
    const payload = (await res.json()) as {
      error: string;
      error_details?: { code?: string; retryable?: boolean };
    };

    expect(res.status).toBe(409);
    expect(payload.error).toBe('idempotency_conflict');
    expect(payload.error_details?.code).toBe('idempotency_conflict');
    expect(payload.error_details?.retryable).toBe(false);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects oversized idempotent request bodies before database work', async () => {
    const body = 'x'.repeat(1024 * 1024 + 1);

    const res = await createApp(requiredIdempotencyMiddleware()).request(
      '/protected',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'idem-key-001',
          'Content-Type': 'text/plain',
        },
        body,
      },
      mockEnv
    );
    const payload = (await res.json()) as { error: string; error_description: string };

    expect(res.status).toBe(413);
    expect(payload.error).toBe('invalid_request');
    expect(payload.error_description).toContain('size limit');
    expect(mockAdapter.queryOne).not.toHaveBeenCalled();
    expect(mockAdapter.execute).not.toHaveBeenCalled();
  });

  it('hashes and restores the exact request bytes for the handler', async () => {
    const requestBody = new Uint8Array([0x00, 0xff, 0xfe, 0x41]);
    let handlerBody: Uint8Array | undefined;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use(
      '/protected',
      requiredIdempotencyMiddleware({ reserveBeforeExecution: true, redactFields: [] })
    );
    app.post('/protected', async (c) => {
      handlerBody = new Uint8Array(await c.req.arrayBuffer());
      return c.json({ ok: true }, 201);
    });

    const res = await app.request(
      '/protected',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': 'idem-key-001',
          'Content-Type': 'application/octet-stream',
        },
        body: requestBody,
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(handlerBody).toEqual(requestBody);
    expect(mockAdapter.execute.mock.calls[0]?.[1]?.[7]).toBe(await hashBytes(requestBody));
  });

  it('keeps identical keys on different UUID resource paths isolated', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use('/actions/*', requiredIdempotencyMiddleware());
    app.post('/actions/:actionId/complete', (c) =>
      c.json({ actionId: c.req.param('actionId') }, 201)
    );
    const request = (actionId: string) =>
      app.request(
        `/actions/${actionId}/complete`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': 'idem-key-001' },
          body: JSON.stringify({ method: 'totp' }),
        },
        mockEnv
      );

    await request('11111111-1111-4111-8111-111111111111');
    await request('22222222-2222-4222-8222-222222222222');

    const firstKey = (mockAdapter.queryOne.mock.calls[0]?.[1] as unknown[])[0];
    const secondKey = (mockAdapter.queryOne.mock.calls[1]?.[1] as unknown[])[0];
    expect(firstKey).not.toBe(secondKey);
  });

  it('fails closed before mutation when required idempotency storage is unavailable', async () => {
    mockAdapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
    let handlerCalls = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use('/protected', requiredIdempotencyMiddleware({ failClosedOnStorageError: true }));
    app.post('/protected', (c) => {
      handlerCalls += 1;
      return c.json({ ok: true }, 201);
    });

    const res = await app.request(
      '/protected',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-key-001' },
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(handlerCalls).toBe(0);
  });

  it('atomically reserves a required idempotency key before invoking the handler', async () => {
    let handlerCalls = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use(
      '/protected',
      requiredIdempotencyMiddleware({ reserveBeforeExecution: true, redactFields: [] })
    );
    app.post('/protected', (c) => {
      handlerCalls += 1;
      return c.json({ ok: true, name: 'Destination' }, 201);
    });

    const res = await app.request(
      '/protected',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-key-001' },
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(handlerCalls).toBe(1);
    expect(String(mockAdapter.execute.mock.calls[0]?.[0])).toContain(
      'INSERT INTO idempotency_keys'
    );
    expect(String(mockAdapter.execute.mock.calls[1]?.[0])).toContain('response_status = 425');
    expect(mockAdapter.execute.mock.calls[1]?.[1]).toContain(
      JSON.stringify({ ok: true, name: 'Destination' })
    );
  });

  it('does not run a concurrent handler after another request reserves the same key', async () => {
    const body = JSON.stringify({ action: 'write' });
    mockAdapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'idempotency-key-001',
      body_hash: await hashBody(body),
      response_status: 425,
      response_body: JSON.stringify({ error: 'idempotency_in_progress' }),
    });
    mockAdapter.execute.mockRejectedValueOnce(
      new Error('D1_ERROR: UNIQUE constraint failed: idempotency_keys.id')
    );
    let handlerCalls = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use('/protected', requiredIdempotencyMiddleware({ reserveBeforeExecution: true }));
    app.post('/protected', (c) => {
      handlerCalls += 1;
      return c.json({ ok: true }, 201);
    });

    const res = await app.request(
      '/protected',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-key-001' },
        body,
      },
      mockEnv
    );

    expect(res.status).toBe(425);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect(handlerCalls).toBe(0);
  });

  it('stores the terminal error response after a reserved handler fails', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.use('/protected', requiredIdempotencyMiddleware({ reserveBeforeExecution: true }));
    app.post('/protected', () => {
      throw new Error('handler failed');
    });

    const res = await app.request(
      '/protected',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-key-001' },
        body: JSON.stringify({ action: 'write' }),
      },
      mockEnv
    );

    expect(res.status).toBe(500);
    const finalization = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE idempotency_keys')
    );
    expect(finalization?.[1]).toContain(500);
  });

  describe('responses marked retryable', () => {
    const body = JSON.stringify({ action: 'write' });
    const keyId = 'tenant-a:unknown:POST:/protected::idem-key-001';
    const reserved = () =>
      requiredIdempotencyMiddleware({
        reserveBeforeExecution: true,
        failClosedOnStorageError: true,
      });

    function createRetryableApp(
      middleware: ReturnType<typeof idempotencyMiddleware>,
      status: 200 | 403,
      markRetryable = true
    ) {
      const calls = { handler: 0 };
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('tenantId', 'tenant-a');
        await next();
      });
      app.use('/protected', middleware);
      app.post('/protected', (c) => {
        calls.handler += 1;
        if (markRetryable) markIdempotentResponseRetryable(c);
        return c.json(status < 400 ? { ok: true } : { error: 'step_up_required' }, status);
      });
      return { app, calls };
    }

    function send(app: Hono, requestBody = body) {
      return app.request(
        '/protected',
        { method: 'POST', headers: { 'Idempotency-Key': 'idem-key-001' }, body: requestBody },
        mockEnv
      );
    }

    async function retryableEntry(requestBody = body) {
      return {
        id: keyId,
        body_hash: await hashBody(requestBody),
        response_status: 0,
        response_body: JSON.stringify({ retryable: true }),
      };
    }

    function sqlCalls(fragment: string) {
      return mockAdapter.execute.mock.calls.filter(([sql]) => String(sql).includes(fragment));
    }

    it('releases the reservation of a marked error as retryable, keeping the body hash', async () => {
      const { app } = createRetryableApp(reserved(), 403);
      const res = await send(app);

      expect(res.status).toBe(403);
      expect(mockAdapter.execute).toHaveBeenCalledTimes(2);
      expect(String(mockAdapter.execute.mock.calls[0]?.[0])).toContain(
        'INSERT INTO idempotency_keys'
      );
      const reservationBody = mockAdapter.execute.mock.calls[0]?.[1]?.[9] as string;
      expect(JSON.parse(reservationBody)).toMatchObject({
        error: 'idempotency_in_progress',
        reservation_id: expect.any(String),
      });
      const [releaseSql, releaseParams] = mockAdapter.execute.mock.calls[1]!;
      expect(String(releaseSql)).toMatch(
        /WHERE id = \? AND body_hash = \? AND response_status = 425 AND response_body = \?/
      );
      expect(releaseParams).toEqual([
        0,
        JSON.stringify({ retryable: true }),
        expect.any(Number),
        keyId,
        await hashBody(body),
        reservationBody,
      ]);
      expect(sqlCalls('DELETE')).toHaveLength(0);
    });

    it('re-reserves a retryable key for the same body and runs the handler once', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(await retryableEntry());
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(200);
      expect(calls.handler).toBe(1);
      const [takeoverSql, takeoverParams] = mockAdapter.execute.mock.calls[0]!;
      expect(String(takeoverSql)).toMatch(/AND response_status = 0/);
      expect(takeoverParams?.[0]).toBe(425);
      const [storeSql, storeParams] = mockAdapter.execute.mock.calls[1]!;
      expect(String(storeSql)).toContain('response_status = 425 AND response_body = ?');
      expect(storeParams?.[0]).toBe(200);
      // Finalizing requires the reservation body this request wrote when it re-reserved.
      expect(storeParams?.[5]).toBe(takeoverParams?.[1]);
      expect(sqlCalls('INSERT INTO idempotency_keys')).toHaveLength(0);
    });

    it('refuses a different body for a retryable key', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(await retryableEntry());
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app, JSON.stringify({ action: 'other' }));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: 'idempotency_conflict' });
      expect(calls.handler).toBe(0);
      expect(mockAdapter.execute).not.toHaveBeenCalled();
    });

    it('answers 425 when another request re-reserves the retryable key first', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce(await retryableEntry()).mockResolvedValueOnce({
        ...(await retryableEntry()),
        response_status: 425,
        response_body: JSON.stringify({ error: 'idempotency_in_progress' }),
      });
      mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 0 });
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(425);
      expect(res.headers.get('Retry-After')).toBe('2');
      expect(calls.handler).toBe(0);
    });

    it('reserves again instead of running unreserved when the conflicting row is gone', async () => {
      const unique = new Error('D1_ERROR: UNIQUE constraint failed: idempotency_keys.id');
      mockAdapter.execute.mockRejectedValueOnce(unique);
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(200);
      expect(calls.handler).toBe(1);
      expect(sqlCalls('INSERT INTO idempotency_keys')).toHaveLength(2);
      // The conflicting row is not live: only an expired outcome for this key is swept, never an
      // expired reservation whose handler may still be running.
      const [sweepSql, sweepParams] = sqlCalls('DELETE FROM idempotency_keys')[0]!;
      expect(String(sweepSql)).toContain('expires_at <= ?');
      expect(String(sweepSql)).toContain('response_status <> 425');
      expect(sweepParams?.[0]).toBe(keyId);
    });

    it('answers 425, never running the handler, when the key keeps changing hands', async () => {
      // Every re-reservation of the retryable row is won by another request.
      mockAdapter.queryOne.mockResolvedValue(await retryableEntry());
      mockAdapter.execute.mockResolvedValue({ rowsAffected: 0 });
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(425);
      expect(res.headers.get('Retry-After')).toBe('2');
      expect(calls.handler).toBe(0);
      expect(sqlCalls('AND response_status = 0')).toHaveLength(3);
    });

    it('answers a concurrent attempt without the reservation id', async () => {
      mockAdapter.queryOne.mockResolvedValueOnce({
        ...(await retryableEntry()),
        response_status: 425,
        response_body: JSON.stringify({ error: 'idempotency_in_progress', reservation_id: 'r-1' }),
      });
      const { app, calls } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(425);
      const payload = (await res.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ error: 'idempotency_in_progress' });
      expect(payload).not.toHaveProperty('reservation_id');
      expect(calls.handler).toBe(0);
    });

    it('stores a marked error as usual without reservation', async () => {
      const { app } = createRetryableApp(requiredIdempotencyMiddleware(), 403);
      const res = await send(app);

      expect(res.status).toBe(403);
      expect(sqlCalls('UPDATE idempotency_keys')[0]?.[1]).toContain(403);
    });

    it('still stores an error response that was not marked', async () => {
      const { app } = createRetryableApp(reserved(), 403, false);
      const res = await send(app);

      expect(res.status).toBe(403);
      expect(sqlCalls('UPDATE idempotency_keys')[0]?.[1]?.[0]).toBe(403);
    });

    it('still stores a success even when it was marked', async () => {
      const { app } = createRetryableApp(reserved(), 200);
      const res = await send(app);

      expect(res.status).toBe(200);
      expect(sqlCalls('UPDATE idempotency_keys')[0]?.[1]?.[0]).toBe(200);
    });
  });

  it('keeps an expired in-progress reservation through cleanup until its retention ends', async () => {
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 2 });
    const before = Math.floor(Date.now() / 1000);

    await expect(cleanupExpiredIdempotencyKeys(mockAdapter as DatabaseAdapter)).resolves.toBe(2);

    const [sql, params] = mockAdapter.execute.mock.calls[0]!;
    expect(String(sql)).toBe(
      'DELETE FROM idempotency_keys WHERE expires_at < ? AND (response_status <> 425 OR expires_at < ?)'
    );
    const [now, reservationCutoff] = params as [number, number];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now - reservationCutoff).toBe(IDEMPOTENCY_RESERVATION_RETENTION_SECONDS);
  });
});
