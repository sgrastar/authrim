import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleNotifierPlugin, ConsoleNotifierConfigSchema } from '../builtin/notifier/console';
import { CapabilityRegistry } from '../core/registry';
import type { PluginContext } from '../core/types';

function register(config: Record<string, unknown> = {}) {
  const registry = new CapabilityRegistry();
  consoleNotifierPlugin.register(registry, ConsoleNotifierConfigSchema.parse(config));
  return registry;
}

const note = { channel: 'email', to: 'a@example.test', body: 'hello' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('console notifier plugin', () => {
  it('describes itself as an official development-only plugin', () => {
    expect(consoleNotifierPlugin.id).toBe('notifier-console');
    expect(consoleNotifierPlugin.version).toBe('1.0.0');
    expect(consoleNotifierPlugin.official).toBe(true);
    expect(consoleNotifierPlugin.capabilities).toEqual([
      'notifier.email',
      'notifier.sms',
      'notifier.push',
    ]);
    expect(consoleNotifierPlugin.meta).toMatchObject({
      name: 'Console Notifier',
      category: 'notification',
      license: 'MIT',
      icon: 'terminal',
      tags: ['console', 'debug', 'development', 'testing', 'mock'],
      repositoryUrl: 'https://github.com/sgrastar/authrim',
      minAuthrimVersion: '1.0.0',
      stability: 'stable',
      hidden: false,
    });
    expect(consoleNotifierPlugin.meta.adminNotes).toContain('Development Only Plugin');
    expect(consoleNotifierPlugin.meta.adminNotes).toContain('## Production Environment');
  });

  it('registers one handler for every channel', () => {
    const registry = register();
    const email = registry.getNotifier('email');
    expect(email).toBeDefined();
    expect(registry.getNotifier('sms')).toBe(email);
    expect(registry.getNotifier('push')).toBe(email);
    expect(registry.getCapabilityOwner('notifier.email')).toBe('notifier-console');
    expect(registry.getCapabilityOwner('notifier.sms')).toBe('notifier-console');
    expect(registry.getCapabilityOwner('notifier.push')).toBe('notifier-console');
  });

  it('is always healthy', async () => {
    await expect(consoleNotifierPlugin.healthCheck?.({} as never, {} as never)).resolves.toEqual({
      status: 'healthy',
      message: 'Console notifier is always healthy (logs to console)',
    });
  });

  it('has the documented configuration defaults and limits', () => {
    expect(ConsoleNotifierConfigSchema.parse({})).toEqual({
      prefix: '[AUTHRIM-NOTIFY]',
      includeTimestamp: true,
      logLevel: 'info',
      prettyPrint: true,
      simulateDelayMs: 0,
      simulateFailureRate: 0,
    });
    for (const [field, value, valid] of [
      ['simulateDelayMs', -1, false],
      ['simulateDelayMs', 5000, true],
      ['simulateDelayMs', 5001, false],
      ['simulateFailureRate', -0.1, false],
      ['simulateFailureRate', 1, true],
      ['simulateFailureRate', 1.1, false],
      ['logLevel', 'error', false],
    ] as const) {
      expect(ConsoleNotifierConfigSchema.safeParse({ [field]: value }).success).toBe(valid);
    }
  });
});

describe('console notifier initialization', () => {
  const context = (environment?: string) =>
    ({ env: { ENVIRONMENT: environment } }) as unknown as PluginContext;

  it.each([
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
  ] as const)('logs its start-up at the %s level', async (logLevel, method) => {
    const spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    };
    const config = ConsoleNotifierConfigSchema.parse({
      logLevel,
      prefix: '[X]',
      simulateDelayMs: 5,
    });
    await consoleNotifierPlugin.initialize?.(context('test'), config);
    expect(spies[method]).toHaveBeenCalledWith('[X] Console Notifier initialized', {
      channels: ['email', 'sms', 'push'],
      config: {
        includeTimestamp: true,
        logLevel,
        simulateDelayMs: 5,
        simulateFailureRate: 0,
      },
    });
    for (const other of ['debug', 'info', 'warn'] as const) {
      if (other !== method) expect(spies[other]).not.toHaveBeenCalled();
    }
  });

  it('warns loudly only in production', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = ConsoleNotifierConfigSchema.parse({ prefix: '[X]' });
    await consoleNotifierPlugin.initialize?.(context('staging'), config);
    expect(warn).not.toHaveBeenCalled();
    await consoleNotifierPlugin.initialize?.(context('production'), config);
    expect(warn).toHaveBeenCalledWith(
      '[X] ⚠️ WARNING: Console Notifier is enabled in production! No actual notifications will be sent. This is likely a configuration error.'
    );
  });
});

describe('console notifier delivery details', () => {
  it('gives each delivery a console-prefixed id with a millisecond time and eight hex digits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handler = register().getNotifier('email');
    const result = await handler?.send(note);
    expect(result?.messageId).toMatch(/^console-1700000000000-[0-9a-f]{8}$/u);
    expect(result?.success).toBe(true);
  });

  it('fills the random part from the secure random source with zero padding', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
      array.set([0, 1, 15, 255]);
      return array;
    }) as unknown as typeof crypto.getRandomValues);
    const result = await register().getNotifier('email')?.send(note);
    expect(result?.messageId?.endsWith('-00010fff')).toBe(true);
  });

  it('logs the body in full up to 200 characters and cuts longer ones', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handler = register({ includeTimestamp: false }).getNotifier('email');
    await handler?.send({ ...note, body: 'b'.repeat(200) });
    await handler?.send({ ...note, body: 'b'.repeat(201) });
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      bodyPreview: 'b'.repeat(200),
      bodyLength: 200,
    });
    expect(info.mock.calls[1]?.[1]).toMatchObject({
      bodyPreview: `${'b'.repeat(200)}...`,
      bodyLength: 201,
    });
  });

  it('leaves out the optional log fields a notification does not have', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await register({ includeTimestamp: false }).getNotifier('email')?.send({
      channel: 'sms',
      to: '+1555',
      body: '',
    });
    const data = info.mock.calls[0]?.[1] as Record<string, unknown>;
    for (const key of ['bodyPreview', 'bodyLength', 'templateId', 'templateVars', 'metadata']) {
      expect(data).not.toHaveProperty(key);
    }
    expect(data).toMatchObject({ channel: 'sms', to: '+1555' });
  });

  it('uses the prefix and an empty timestamp slot when timestamps are off', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await register({ prefix: '[P]', includeTimestamp: false }).getNotifier('email')?.send(note);
    expect(info.mock.calls[0]?.[0]).toBe('[P]  📧 NOTIFICATION SENT');
  });

  it('keeps structured log data as objects when pretty printing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await register({ includeTimestamp: false })
      .getNotifier('email')
      ?.send({
        ...note,
        templateVars: { a: 1 },
        metadata: { b: 2 },
      });
    expect(info.mock.calls[0]?.[1]).toMatchObject({ templateVars: { a: 1 }, metadata: { b: 2 } });
  });

  describe('failure simulation', () => {
    const failing = (rate: number) =>
      register({ simulateFailureRate: rate, includeTimestamp: false });

    it('never fails with a zero failure rate', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect((await failing(0).getNotifier('email')?.send(note))?.success).toBe(true);
    });

    it('fails while the random draw is below the rate, and succeeds at the rate', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const draw = vi.spyOn(Math, 'random');
      draw.mockReturnValue(0.49);
      expect((await failing(0.5).getNotifier('email')?.send(note))?.success).toBe(false);
      draw.mockReturnValue(0.5);
      expect((await failing(0.5).getNotifier('email')?.send(note))?.success).toBe(true);
    });

    it('logs the failed delivery with its channel, recipient and reason', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(Math, 'random').mockReturnValue(0);
      await failing(1).getNotifier('email')?.send(note);
      expect(info).toHaveBeenCalledWith('[AUTHRIM-NOTIFY]  ❌ NOTIFICATION FAILED', {
        channel: 'email',
        to: 'a@example.test',
        error: 'Simulated failure (simulateFailureRate is configured)',
      });
    });
  });

  it('does not wait when no delay is configured', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await register().getNotifier('email')?.send(note);
    expect(result?.success).toBe(true);
  });
});
