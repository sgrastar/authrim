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

import { idempotencyMiddleware, requiredIdempotencyMiddleware } from '../idempotency';

const mockEnv = { DEFAULT_TENANT_ID: 'default' };

async function hashBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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
});
