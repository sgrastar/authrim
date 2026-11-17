import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedCommand } from '../cli/timed-command.js';

const writes: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: vi.fn((_fd: number, text: string) => {
      writes.push(text);
      return text.length;
    }),
  };
});

describe('timedCommand', () => {
  afterEach(() => {
    writes.length = 0;
    process.exitCode = undefined;
  });

  it('reports when the command returns, with its exit code', async () => {
    const before = process.listenerCount('exit');
    const run = timedCommand('update', async (options: { env?: string }) => options.env);
    await expect(run({})).resolves.toBeUndefined();
    expect(process.listenerCount('exit')).toBe(before);
    expect(writes.join('')).toContain('━━━ Timings: update ━━━');
  });

  it('leaves a failure to the exit handler, which records the code the CLI ends with', async () => {
    const before = process.listenerCount('exit');
    const run = timedCommand('deploy', async () => {
      throw new Error('cancelled');
    });
    await expect(run({})).rejects.toThrow('cancelled');
    expect(writes).toEqual([]);
    expect(process.listenerCount('exit')).toBe(before + 1);
    process.emit('exit', 0);
    expect(process.listenerCount('exit')).toBe(before);
    expect(writes.join('')).toContain('━━━ Timings: deploy ━━━');
  });
});
