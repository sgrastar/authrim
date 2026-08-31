import { describe, expect, it, vi } from 'vitest';

vi.mock('../web/api.js', () => ({
  createApiRoutes: vi.fn(),
  generateSessionToken: vi.fn(),
  getSessionToken: vi.fn(() => 'test-session-token'),
}));

import { createWebRequestDrainController, createWebShutdownController } from '../web/server.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('setup Web server graceful shutdown', () => {
  it('stops admission and waits for an in-flight request cleanup before exiting', async () => {
    const requests = createWebRequestDrainController();
    const exit = vi.fn();
    const events: string[] = [];
    expect(requests.beginRequest()).toBe(true);

    const shutdown = createWebShutdownController({
      stopAccepting: () => {
        events.push('stop-accepting');
        requests.beginDrain();
      },
      waitForDrain: () => requests.waitForIdle(),
      exit,
      gracePeriodMs: 5_000,
      scheduleTimeout: () => () => undefined,
      onStopped: () => events.push('stopped'),
    });

    const completion = shutdown.handleSignal('SIGINT');
    await Promise.resolve();

    expect(requests.beginRequest()).toBe(false);
    expect(requests.activeRequests()).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    events.push('route-finally-cleanup');
    requests.finishRequest();
    await completion;

    expect(events).toEqual(['stop-accepting', 'route-finally-cleanup', 'stopped']);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('warns and exits unsuccessfully when the bounded grace period expires', async () => {
    const drain = deferred();
    const exit = vi.fn();
    const warning = vi.fn();
    let expireGracePeriod: (() => void) | undefined;
    const shutdown = createWebShutdownController({
      stopAccepting: vi.fn(),
      waitForDrain: () => drain.promise,
      exit,
      gracePeriodMs: 2_500,
      scheduleTimeout: (callback) => {
        expireGracePeriod = callback;
        return () => undefined;
      },
      onWarning: warning,
    });

    const completion = shutdown.handleSignal('SIGTERM');
    expireGracePeriod?.();
    await completion;

    expect(warning).toHaveBeenCalledWith(
      'Setup shutdown exceeded the 3s grace period; forcing exit before all cleanup completed.'
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);

    // A late cleanup completion must not request another process exit in tests or production.
    drain.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('treats a second signal as an explicit force-exit request', async () => {
    const drain = deferred();
    const exit = vi.fn();
    const warning = vi.fn();
    const shutdown = createWebShutdownController({
      stopAccepting: vi.fn(),
      waitForDrain: () => drain.promise,
      exit,
      scheduleTimeout: () => () => undefined,
      onWarning: warning,
    });

    const firstSignal = shutdown.handleSignal('SIGINT');
    await shutdown.handleSignal('SIGTERM');

    expect(warning).toHaveBeenCalledWith('Received SIGTERM again; forcing setup shutdown.');
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);

    drain.resolve();
    await firstSignal;
    expect(exit).toHaveBeenCalledOnce();
  });

  it('fails closed if request accounting is decremented twice', () => {
    const requests = createWebRequestDrainController();
    expect(requests.beginRequest()).toBe(true);
    requests.finishRequest();
    expect(() => requests.finishRequest()).toThrow('web_request_drain_counter_underflow');
  });
});
