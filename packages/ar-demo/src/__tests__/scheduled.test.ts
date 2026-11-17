import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleScheduled } from '../cleanup';
import { handleSweep } from '../sweep';
import worker from '../index';
import { CLEANUP_CRON, dispatchScheduled, SWEEP_CRON } from '../scheduled';
import type { Deps, Env } from '../types';

vi.mock('../cleanup', () => ({ handleScheduled: vi.fn() }));
vi.mock('../sweep', () => ({ handleSweep: vi.fn() }));
const env = {} as Env;
const deps = {} as Deps;
beforeEach(() => vi.clearAllMocks());

describe('scheduled dispatch', () => {
  it('runs only tenant cleanup on its existing cron', async () => {
    await dispatchScheduled(CLEANUP_CRON, env, deps);
    expect(handleScheduled).toHaveBeenCalledExactlyOnceWith(env, deps);
    expect(handleSweep).not.toHaveBeenCalled();
  });

  it('runs only the default sweep on its separate cron', async () => {
    await dispatchScheduled(SWEEP_CRON, env, deps);
    expect(handleSweep).toHaveBeenCalledExactlyOnceWith(env, deps);
    expect(handleScheduled).not.toHaveBeenCalled();
  });

  it('does not run either task for an unknown cron', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await dispatchScheduled('unrecognised', env, deps);
      expect(handleSweep).not.toHaveBeenCalled();
      expect(handleScheduled).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith('{"event":"scheduled_unknown_cron"}');
    } finally {
      error.mockRestore();
    }
  });

  it('the exported Worker awaits completion and passes the actual cron', async () => {
    let release!: () => void;
    vi.mocked(handleSweep).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        })
    );
    let complete = false;
    const run = worker.scheduled({ cron: SWEEP_CRON }, env).then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(handleSweep).toHaveBeenCalledOnce();
    expect(handleScheduled).not.toHaveBeenCalled();
    release();
    await run;
    expect(complete).toBe(true);
  });
});
