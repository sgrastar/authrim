import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../../types/env';
import type { Session } from '../../durable-objects/SessionStore';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn() }));
vi.mock('../../middleware/request-context', () => ({ getTenantIdFromContext: () => 'tenant-a' }));
vi.mock('../runtime-data-context', async (original) => ({
  ...(await original<typeof import('../runtime-data-context')>()),
  resolveAccountDataContextFromHono: mocks.resolve,
}));
import { revokeGuestResumeForSession } from '../guest-session';
const metadataExecute = vi.fn();
function adapter(execute: unknown) {
  return {
    execute,
    query: vi.fn(),
    queryOne: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: () => 'd1',
    close: vi.fn(),
  };
}
const context = {
  get: (name: string) => {
    if (name === 'tenantId') return 'tenant-a';
    if (name === 'tenantMetadataContext')
      return { tenantId: 'tenant-a', coreDb: adapter(metadataExecute) };
    if (name === 'accountDataContext')
      return { tenantId: 'tenant-a', accountId: 'account:guest-a', coreDb: adapter(mocks.execute) };
  },
} as unknown as Context<{ Bindings: Env }>;
function session(override: Partial<Session> = {}): Session {
  return {
    tenantId: 'tenant-a',
    userId: 'guest-a',
    data: { guest_resume_credential: true, device_id_hash: 'a'.repeat(64) },
    ...override,
  } as Session;
}
describe('explicit guest logout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
  });
  it('revokes only the tenant/account/credential bound to the session', async () => {
    await revokeGuestResumeForSession(context, session());
    expect(mocks.resolve).toHaveBeenCalledWith(context, 'guest-a');
    expect(metadataExecute).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining('SET is_active = FALSE'), [
      'tenant-a',
      'guest-a',
      'a'.repeat(64),
    ]);
  });
  it.each([null, session({ data: {} })])(
    'does not mutate regular or absent sessions',
    async (value) => {
      await revokeGuestResumeForSession(context, value);
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
  it.each([
    session({ tenantId: 'tenant-b' }),
    session({ data: { guest_resume_credential: true, device_id_hash: 'device-id' } }),
  ])('rejects invalid credential binding before storage access', async (value) => {
    await expect(revokeGuestResumeForSession(context, value)).rejects.toThrow(
      'guest_resume_revocation_failed'
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not treat a storage failure as successful logout', async () => {
    mocks.execute.mockRejectedValue(new Error('unavailable'));
    await expect(revokeGuestResumeForSession(context, session())).rejects.toThrow(
      'guest_resume_revocation_failed'
    );
  });
  it('can retry revoking an already inactive credential', async () => {
    mocks.execute.mockResolvedValue({ rowsAffected: 0 });
    await expect(revokeGuestResumeForSession(context, session())).resolves.toBeUndefined();
  });
});
