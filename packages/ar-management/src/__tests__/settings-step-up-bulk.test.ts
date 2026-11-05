import { describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import { gateStepUpSettingsPatch } from '../routes/settings-v2/step-up-settings';

/** A settings manager whose dry run lowers one step-up level. */
function lowering() {
  return {
    patch: vi.fn(async () => ({
      candidate: {
        before: { 'security.admin_step_up_overrides': { 'sessions.revoke_all': 'L2' } },
        after: { 'security.admin_step_up_overrides': {} },
      },
    })),
    getAll: vi.fn(async () => ({ inherited: { values: {} } })),
  };
}

async function run(refuse: boolean) {
  const app = new Hono();
  app.post('/x', async (c) => {
    const refused = await gateStepUpSettingsPatch({
      c: c as never,
      manager: lowering() as never,
      category: 'security',
      scope: { type: 'tenant', id: 'tenant-a' },
      targetTenantId: 'tenant-a',
      body: { ifMatch: '1', set: { 'security.admin_step_up_overrides': {} } },
      actor: 'admin-1',
      refuse,
    });
    return refused ?? c.json({ saved: true });
  });
  const response = await app.request('/x', { method: 'POST' });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe('step-up settings in a bulk apply', () => {
  it('refuses a weakening item instead of asking for a receipt per item', async () => {
    gate.mockClear();
    expect(await run(true)).toEqual({
      status: 400,
      body: expect.objectContaining({
        error: 'step_up_not_in_bulk',
        operation: 'admin_step_up.policy.relax',
      }) as unknown,
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it('asks for the step-up when the change is made on its own', async () => {
    gate.mockClear();
    expect(await run(false)).toEqual({ status: 200, body: { saved: true } });
    expect(gate).toHaveBeenCalledOnce();
  });
});
