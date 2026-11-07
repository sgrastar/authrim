/**
 * Whether an external sign-in may create an account in a tenant that may be in lite mode: only a
 * sign-in begun at a lite start, unless the store says now that the tenant is not lite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const reads = vi.hoisted(() => ({ cached: vi.fn(), current: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  readLiteModeState: reads.cached,
  readLiteModeAuthoritative: reads.current,
}));

import {
  externalSignInMayCreateAccount,
  isLiteExternalFlow,
  liteExternalFlowId,
} from '../services/lite-start';

const env = {} as Env;

beforeEach(() => {
  reads.cached.mockReset();
  reads.current.mockReset();
});

describe('externalSignInMayCreateAccount', () => {
  it('lets a sign-in begun at a lite start create one without reading the mode', async () => {
    await expect(externalSignInMayCreateAccount(env, 't', liteExternalFlowId())).resolves.toBe(
      true
    );
    expect(reads.current).not.toHaveBeenCalled();
  });

  it('goes by the store now, never by a runtime cache that still says off', async () => {
    reads.cached.mockResolvedValue('off');
    reads.current.mockResolvedValue('always');
    await expect(externalSignInMayCreateAccount(env, 't', 'flow-a')).resolves.toBe(false);
    expect(reads.cached).not.toHaveBeenCalled();
    reads.current.mockResolvedValue('off');
    await expect(externalSignInMayCreateAccount(env, 't', 'flow-a')).resolves.toBe(true);
  });

  it('creates nothing when the mode cannot be read', async () => {
    reads.current.mockRejectedValue(new Error('policy unavailable'));
    await expect(externalSignInMayCreateAccount(env, 't', 'flow-a')).resolves.toBe(false);
  });
});

describe('lite flow IDs', () => {
  it('are made with the prefix, and nothing else counts as one', () => {
    expect(isLiteExternalFlow(liteExternalFlowId())).toBe(true);
    for (const flowId of [undefined, null, '', 'lite', 'LITE:x', ' lite:x', crypto.randomUUID()]) {
      expect(isLiteExternalFlow(flowId)).toBe(false);
    }
  });
});
