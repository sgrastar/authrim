/**
 * The children of one `local up` session and the "stopping" state they share.
 *
 * A stop request (Ctrl+C, SIGTERM, a crashed child) can arrive at any point of a slow start. From
 * that moment nothing new may be spawned, anything waiting must give up, and every child that
 * already exists must be stopped, however many times the stop is requested.
 */

export interface StoppableChild {
  stop: () => Promise<void>;
}

/** Thrown by work that was interrupted because the session is stopping. Not a failure. */
export class SessionStoppedError extends Error {
  constructor() {
    super('The local session is stopping.');
    this.name = 'SessionStoppedError';
  }
}

export class ChildSession<T extends StoppableChild> {
  private readonly children: T[] = [];
  private stopping: Promise<void> | null = null;
  private readonly controller = new AbortController();

  /** Aborted as soon as a stop is requested; pass it to anything that waits. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isStopping(): boolean {
    return this.stopping !== null;
  }

  /** Throws when the session is stopping, so a start sequence unwinds at its next checkpoint. */
  assertRunning(): void {
    if (this.stopping !== null) throw new SessionStoppedError();
  }

  /**
   * Spawn a child unless the session is stopping. The check and the registration happen with no
   * await in between, so a stop can never run after the spawn but before the child is tracked.
   */
  start(spawn: () => T): T {
    this.assertRunning();
    const child = spawn();
    this.children.push(child);
    return child;
  }

  /** Stop every child. Every call waits for the same stop; later children are stopped too. */
  stop(): Promise<void> {
    if (this.stopping === null) {
      this.controller.abort();
      this.stopping = this.stopAll();
    }
    return this.stopping;
  }

  private async stopAll(): Promise<void> {
    const stopped = new Set<T>();
    for (;;) {
      const pending = this.children.filter((child) => !stopped.has(child));
      if (pending.length === 0) return;
      for (const child of pending) stopped.add(child);
      await Promise.all(pending.map((child) => child.stop()));
    }
  }
}
