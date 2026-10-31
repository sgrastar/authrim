import { describe, expect, it, vi } from 'vitest';
import { waitForReady } from '../core/local/runtime.js';
import { ChildSession, SessionStoppedError } from '../core/local/session.js';

function fakeChild() {
  let stops = 0;
  return {
    stop: vi.fn(async () => {
      stops += 1;
    }),
    stops: () => stops,
  };
}

describe('child session', () => {
  it('starts children while running and stops each of them once', async () => {
    const session = new ChildSession<ReturnType<typeof fakeChild>>();
    const a = session.start(fakeChild);
    const b = session.start(fakeChild);
    await session.stop();
    expect([a.stops(), b.stops()]).toEqual([1, 1]);
  });

  it('does not spawn anything once a stop was requested', async () => {
    const session = new ChildSession<ReturnType<typeof fakeChild>>();
    const first = session.start(fakeChild);
    const stopping = session.stop();
    const spawn = vi.fn(fakeChild);
    // The start sequence is, for example, between the Workers and the Login UI.
    expect(() => session.start(spawn)).toThrow(SessionStoppedError);
    expect(spawn).not.toHaveBeenCalled();
    await stopping;
    expect(first.stops()).toBe(1);
  });

  it('aborts the signal that waits observe as soon as the stop is requested', async () => {
    const session = new ChildSession<ReturnType<typeof fakeChild>>();
    expect(session.signal.aborted).toBe(false);
    void session.stop();
    expect(session.signal.aborted).toBe(true);
    expect(session.isStopping).toBe(true);
    expect(() => session.assertRunning()).toThrow(SessionStoppedError);
  });

  it('makes every stop request wait for the same stop', async () => {
    const session = new ChildSession<ReturnType<typeof fakeChild>>();
    let release!: () => void;
    const slow = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    session.start(() => slow as never);
    const first = session.stop();
    const second = session.stop();
    expect(second).toBe(first);
    let finished = false;
    void second.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    release();
    await second;
    expect(slow.stop).toHaveBeenCalledTimes(1);
    // A late third request returns the finished stop without stopping again.
    await session.stop();
    expect(slow.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a child that was registered while the stop was already in progress', async () => {
    const session = new ChildSession<ReturnType<typeof fakeChild>>();
    let release!: () => void;
    const slow = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    session.start(() => slow as never);
    const stopping = session.stop();
    // Reach into the session the way a spawn that was already running could: the child is
    // registered after the stop began, and must still be stopped.
    const late = fakeChild();
    (session as unknown as { children: unknown[] }).children.push(late);
    release();
    await stopping;
    expect(late.stops()).toBe(1);
  });
});

describe('waiting for a server while the session stops', () => {
  const neverExits = {
    done: new Promise<number>(() => {}),
    hasExited: () => false,
    stop: async () => {},
  };

  it('gives up with SessionStoppedError right after the stop, not after its timeout', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = waitForReady({
      label: 'the Login UI',
      // Nothing listens here, so the wait would otherwise run for minutes.
      url: 'http://127.0.0.1:9/',
      process: neverExits,
      logPath: '/dev/null',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(waiting).rejects.toBeInstanceOf(SessionStoppedError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not even try when the session is already stopping', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForReady({
        label: 'wrangler dev',
        url: 'http://127.0.0.1:9/',
        process: neverExits,
        logPath: '/dev/null',
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(SessionStoppedError);
  });
});
