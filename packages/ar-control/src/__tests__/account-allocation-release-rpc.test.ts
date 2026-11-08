/**
 * What a release of an account's route allocation answers through the Control RPC boundary: an
 * allocation that is committed (never released) or absent reaches the caller as such, so an
 * abandoned creation's clean-up can tell them from a failure; anything else stays internal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlEnv } from '../types';

const mocks = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock('../account-allocation', async (original) => ({
  ...(await original<typeof import('../account-allocation')>()),
  ControlAccountAllocationService: class {
    release = mocks.release;
  },
  D1AccountAllocationRepository: class {},
}));
import ControlWorker from '../index';

function worker() {
  return new ControlWorker(
    {
      props: { caller: 'ar-management', audience: 'authrim-control-v1', environmentId: 'test' },
      waitUntil: vi.fn(),
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    { AUTHRIM_ENVIRONMENT_NAME: 'test', CONTROL_DB: {} } as unknown as ControlEnv
  );
}

beforeEach(() => vi.clearAllMocks());

describe('releaseAccountRoute through the RPC boundary', () => {
  it.each([
    'control_account_allocation_release_committed',
    'control_account_allocation_release_not_found',
  ])('passes %s through', async (code) => {
    mocks.release.mockRejectedValueOnce(new Error(code));
    await expect(worker().releaseAccountRoute({})).rejects.toThrow(code);
  });

  it('keeps any other failure internal', async () => {
    mocks.release.mockRejectedValueOnce(new Error('raw database detail'));
    await expect(worker().releaseAccountRoute({})).rejects.toThrow('control_internal_error');
  });
});
