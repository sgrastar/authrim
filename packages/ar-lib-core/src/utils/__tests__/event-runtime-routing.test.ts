import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { publishEvent } from '../event-dispatcher-factory';

describe('deployment-owned event routing', () => {
  it('keeps dropped auth event writes in request waitUntil and bypasses CF dispatcher', async () => {
    const publish = vi.fn(async () => {
      throw new Error('durable_audit_failed');
    });
    const waitUntil = vi.fn();
    const app = new Hono<{ Bindings: Env }>();
    app.get('/event', (c) => {
      publishEvent(c, {
        type: 'auth.passkey.failed',
        tenantId: 'tenant-a',
        data: { errorCode: 'credential_not_found' },
      }).catch(() => undefined);
      return c.json({ ok: true });
    });

    const response = await app.fetch(
      new Request('https://auth.example.test/event'),
      { EVENT_RUNTIME_PORTS: { publish } } as Env,
      { waitUntil } as never
    );
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(waitUntil.mock.calls[0][0]).rejects.toThrow('durable_audit_failed');
  });
});
