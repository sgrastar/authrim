import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLog: mocks.audit,
  getTenantIdFromContext: () => 'tenant-a',
}));

import { recordAccountOperation } from '../account-operation-log';

function context() {
  return {
    env: {},
    req: { header: () => undefined },
    get: (key: string) => (key === 'tenantId' ? 'tenant-a' : undefined),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('account operation audit delivery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not allow a state-changing operation to hide an audit delivery failure', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      recordAccountOperation(context(), {
        userId: 'guest-a',
        action: 'account.guest.upgraded',
        required: true,
      })
    ).rejects.toThrow('audit unavailable');
  });
});
