import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { D1AccountEventInstallationResolver } from '../account-event-installations';

function database(rows: Array<{ installation_id: string }>): D1Database {
  const all = vi.fn(async () => ({ success: true, results: rows, meta: {} }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    withSession: vi.fn(() => ({ prepare })),
  } as unknown as D1Database;
}

describe('account event installation resolver', () => {
  it('returns only the fixed lifecycle capability in deterministic installation order', async () => {
    await expect(
      new D1AccountEventInstallationResolver(
        database([{ installation_id: 'installation-a' }, { installation_id: 'installation-b' }])
      ).resolve({ tenantId: 'tenant-a', eventType: 'account.created' })
    ).resolves.toEqual([
      { installationId: 'installation-a', capability: 'hook.account.lifecycle' },
      { installationId: 'installation-b', capability: 'hook.account.lifecycle' },
    ]);
  });

  it('fails closed for an invalid row or more than the bounded target count', async () => {
    await expect(
      new D1AccountEventInstallationResolver(database([{ installation_id: '../invalid' }])).resolve(
        {
          tenantId: 'tenant-a',
          eventType: 'account.created',
        }
      )
    ).rejects.toThrow('plugin_sync_account_event_installation_invalid');
    await expect(
      new D1AccountEventInstallationResolver(
        database(
          Array.from({ length: 33 }, (_value, index) => ({
            installation_id: `installation-${index}`,
          }))
        )
      ).resolve({ tenantId: 'tenant-a', eventType: 'account.created' })
    ).rejects.toThrow('plugin_sync_account_event_installation_limit');
  });
});
