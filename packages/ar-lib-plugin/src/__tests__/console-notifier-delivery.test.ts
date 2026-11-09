import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleNotifierPlugin, ConsoleNotifierConfigSchema } from '../builtin/notifier/console';
import { CapabilityRegistry } from '../core/registry';

function notifier(config: Record<string, unknown> = {}) {
  const registry = new CapabilityRegistry();
  consoleNotifierPlugin.register(registry, ConsoleNotifierConfigSchema.parse(config));
  const handler = registry.getNotifier('email');
  if (!handler) throw new Error('console notifier was not registered');
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('console notifier delivery', () => {
  it('logs a bounded body preview and returns a delivery identifier', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = notifier({ prefix: '[DEV]', includeTimestamp: true });
    const body = 'x'.repeat(240);

    const result = await handler.send({
      channel: 'email',
      to: 'person@example.test',
      subject: 'Welcome',
      body,
      templateId: 'welcome-email',
      templateVars: { name: 'Ada' },
      metadata: { requestId: 'request-a' },
    });

    expect(result).toMatchObject({ success: true, messageId: expect.stringMatching(/^console-/u) });
    expect(log).toHaveBeenCalledWith(
      '[DEV] 2026-01-01T00:00:00.000Z 📧 NOTIFICATION SENT',
      expect.objectContaining({
        messageId: result.messageId,
        channel: 'email',
        to: 'person@example.test',
        subject: 'Welcome',
        bodyPreview: `${'x'.repeat(200)}...`,
        bodyLength: 240,
        templateId: 'welcome-email',
        templateVars: { name: 'Ada' },
        metadata: { requestId: 'request-a' },
      })
    );
    expect(handler.supports?.({})).toBe(true);
  });

  it('serializes supplemental log data when pretty printing is disabled', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const handler = notifier({ logLevel: 'debug', prettyPrint: false, includeTimestamp: false });

    await expect(
      handler.send({
        channel: 'email',
        to: 'person@example.test',
        templateVars: { name: 'Ada' },
        metadata: { attempt: 2 },
      })
    ).resolves.toMatchObject({ success: true });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('NOTIFICATION SENT'),
      expect.objectContaining({
        templateVars: '{"name":"Ada"}',
        metadata: '{"attempt":2}',
      })
    );
  });

  it('waits for configured delay before reporting a simulated failure', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = notifier({
      logLevel: 'warn',
      simulateDelayMs: 100,
      simulateFailureRate: 1,
      includeTimestamp: false,
    });
    const result = handler.send({ channel: 'sms', to: '+15551234567' });
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({
      success: false,
      error: 'Simulated failure (simulateFailureRate is configured)',
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('NOTIFICATION FAILED'),
      expect.objectContaining({ channel: 'sms', to: '+15551234567' })
    );
  });
});
