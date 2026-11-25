import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { recordAdminOperationAudit, type AdminOperationAuditInput } from '../admin-operation-audit';

/**
 * recordAdminOperationAudit against the real admin audit writer and core audit service, with
 * the log store of the producer fixture.
 */

let fixtures: Awaited<ReturnType<typeof logProducerFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures = [];
});

async function setup() {
  const logging = await logProducerFixture('scheduled', {
    tenantId: 'default',
    separateAdmin: true,
  });
  fixtures.push(logging);
  const env = logging.env as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, 'default' as never);
    c.set(
      'adminAuth' as never,
      { userId: 'admin-1', email: 'admin@example.test', authMethod: 'session' } as never
    );
    await next();
  });
  let input: AdminOperationAuditInput | undefined;
  app.post('/op', async (c) => c.json({ id: await recordAdminOperationAudit(c, input!) }));
  const record = async (next: AdminOperationAuditInput) => {
    input = next;
    const response = await app.request('/op', { method: 'POST' }, env);
    expect(response.status).toBe(200);
    return (await response.json<{ id: string }>()).id;
  };
  return { logging, record };
}

describe('recordAdminOperationAudit with the real writers', () => {
  it('stores an admin operation in the admin audit log only, with its administrator', async () => {
    const { logging, record } = await setup();
    const id = await record({
      action: 'screen.updated',
      resourceType: 'screen',
      resourceId: 'screen-1',
      metadata: { changed_fields: ['title'] },
    });
    const admin = await logging.rows('admin.admin_audit_log', 'default');
    expect(admin).toEqual([
      expect.objectContaining({
        id,
        tenant_id: 'default',
        admin_user_id: 'admin-1',
        action: 'screen.updated',
        resource_type: 'screen',
        resource_id: 'screen-1',
        result: 'success',
      }),
    ]);
    expect(await logging.rows('core.event_log', 'default')).toEqual([]);
  });

  it("adds an operation on an end user to that user's history, marked and without the admin", async () => {
    const { logging, record } = await setup();
    await record({
      action: 'user.suspended',
      resourceType: 'user',
      resourceId: 'user-9',
      metadata: { reason: 'abuse', admin_actor_id: 'admin-1' },
      endUser: { userId: 'user-9', action: 'user.suspend' },
    });
    expect(await logging.rows('admin.admin_audit_log', 'default')).toEqual([
      expect.objectContaining({ action: 'user.suspended', admin_user_id: 'admin-1' }),
    ]);
    const core = await logging.rows('core.event_log', 'default');
    expect(core).toHaveLength(1);
    expect(core[0]).toMatchObject({ event_type: 'user.suspend', result: 'success' });
    const details = JSON.parse(String(core[0]?.details_json)) as Record<string, unknown>;
    expect(details).toMatchObject({ actor_type: 'admin', reason: 'abuse', resourceType: 'user' });
    expect(JSON.stringify(core[0])).not.toContain('admin-1');
  });
});
