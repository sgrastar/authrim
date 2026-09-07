import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, safeFetch };
});

import { cloudflareEmailPlugin } from '../builtin/notifier/cloudflare';
import { consoleNotifierPlugin } from '../builtin/notifier/console';
import { resendEmailPlugin, ResendNotifierConfigSchema } from '../builtin/notifier/resend';
import { CapabilityRegistry } from '../core/registry';

const email = {
  channel: 'email' as const,
  to: 'user@example.com',
  subject: 'Hello {{name}}',
  body: '<p>Welcome {{name}}</p>',
};

function response(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('built-in notifier plugins', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    safeFetch.mockReset();
  });

  it('keeps Resend sandbox mode entirely offline', async () => {
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 're_test',
      defaultFrom: 'noreply@example.com',
      sandboxMode: true,
    });
    const registry = new CapabilityRegistry();
    resendEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')!;

    await expect(handler.send(email)).resolves.toMatchObject({
      success: true,
      messageId: expect.stringMatching(/^resend-sandbox-/),
      providerResponse: { sandbox: true },
    });
    expect(safeFetch).not.toHaveBeenCalled();
    expect(handler.supports?.({})).toBe(true);
  });

  it('renders and sends a bounded Resend request with optional email fields', async () => {
    safeFetch.mockResolvedValueOnce(response(200, { id: 'email-1' }));
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 're_test',
      defaultFrom: 'noreply@example.com',
      replyTo: 'support@example.com',
      maxRecipientsPerRequest: 5,
    });
    const registry = new CapabilityRegistry();
    resendEmailPlugin.register(registry, config);
    const result = await registry.getNotifier('email')!.send({
      ...email,
      to: 'primary@example.com',
      from: 'sender@example.com',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      templateVars: { name: 'Alice' },
      metadata: {
        textBody: 'Welcome Alice',
        headers: { 'X-Entity-Ref-ID': 'otp-1' },
        category: 'authentication',
        ignored: 42,
      },
    });

    expect(result).toEqual({
      success: true,
      messageId: 'email-1',
      providerResponse: { id: 'email-1' },
    });
    const request = JSON.parse(String(safeFetch.mock.calls[0][1].body));
    expect(request).toMatchObject({
      from: 'sender@example.com',
      subject: 'Hello Alice',
      html: '<p>Welcome Alice</p>',
      text: 'Welcome Alice',
      reply_to: 'support@example.com',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      headers: { 'X-Entity-Ref-ID': 'otp-1' },
      tags: [{ name: 'category', value: 'authentication' }],
    });
  });

  it('rejects unsupported channels and excessive recipient fan-out before network use', async () => {
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 're_test',
      defaultFrom: 'noreply@example.com',
      maxRecipientsPerRequest: 2,
    });
    const registry = new CapabilityRegistry();
    resendEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')!;

    await expect(
      handler.send({ channel: 'sms', to: '+819000000000', body: 'code' })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('only supports') });
    await expect(
      handler.send({ ...email, cc: ['a@example.com'], bcc: ['b@example.com'] })
    ).resolves.toMatchObject({ success: false, error: 'Too many recipients (3 > 2)' });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('sanitizes Resend API errors and classifies retryability', async () => {
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 're_secret',
      defaultFrom: 'noreply@example.com',
    });
    const registry = new CapabilityRegistry();
    resendEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')!;

    safeFetch.mockResolvedValueOnce(
      response(429, {
        message: `rate limited for re_secret ${'x'.repeat(240)}`,
        name: 'rate_limit',
      })
    );
    const limited = await handler.send(email);
    expect(limited).toMatchObject({ success: false, errorCode: 'rate_limit', retryable: true });
    expect((limited as { error: string }).error).not.toContain('re_secret');
    expect((limited as { error: string }).error.length).toBeLessThanOrEqual(203);

    safeFetch.mockResolvedValueOnce(response(400, 'not-json'));
    await expect(handler.send(email)).resolves.toEqual({
      success: false,
      error: 'Resend API error: 400',
      errorCode: undefined,
      retryable: false,
    });
  });

  it('masks transport exceptions while preserving retry classification', async () => {
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 're_test',
      defaultFrom: 'noreply@example.com',
    });
    const registry = new CapabilityRegistry();
    resendEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')!;
    const abort = new Error('aborted');
    abort.name = 'AbortError';

    safeFetch.mockRejectedValueOnce(abort);
    await expect(handler.send(email)).resolves.toMatchObject({
      success: false,
      error: 'Email sending timed out',
      retryable: true,
    });
    safeFetch.mockRejectedValueOnce(new Error('fetch failed with secret details'));
    await expect(handler.send(email)).resolves.toMatchObject({
      success: false,
      error: 'Failed to connect to email service',
      retryable: true,
    });
    safeFetch.mockRejectedValueOnce('unexpected');
    await expect(handler.send(email)).resolves.toMatchObject({
      success: false,
      error: 'Unknown email sending error',
      retryable: false,
    });
  });

  it('reports Resend initialization warnings and health states without leaking the key', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = ResendNotifierConfigSchema.parse({
      apiKey: 'invalid-key',
      defaultFrom: 'noreply@example.com',
      sandboxMode: true,
    });
    await resendEmailPlugin.initialize?.(
      { logger, env: { ENVIRONMENT: 'production' } } as never,
      config
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
    await expect(resendEmailPlugin.healthCheck?.()).resolves.toMatchObject({
      status: 'unhealthy',
    });
    safeFetch.mockResolvedValueOnce(response(200, {}));
    await expect(resendEmailPlugin.healthCheck?.(undefined, config)).resolves.toMatchObject({
      status: 'healthy',
    });
    safeFetch.mockResolvedValueOnce(response(401, {}));
    await expect(resendEmailPlugin.healthCheck?.(undefined, config)).resolves.toMatchObject({
      status: 'degraded',
      message: 'API key may be invalid',
    });
    safeFetch.mockResolvedValueOnce(response(503, {}));
    await expect(resendEmailPlugin.healthCheck?.(undefined, config)).resolves.toMatchObject({
      status: 'degraded',
      message: 'Resend API returned status 503',
    });
    safeFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(resendEmailPlugin.healthCheck?.(undefined, config)).resolves.toMatchObject({
      status: 'unhealthy',
      message: 'Failed to reach Resend API: offline',
    });
  });

  it('uses the Cloudflare EMAIL binding and validates requests before delivery', async () => {
    const registry = new CapabilityRegistry();
    const config = {
      defaultFrom: 'noreply@example.com',
      fromName: 'Authrim',
      replyTo: 'support@example.com',
      maxRecipientsPerRequest: 3,
    };
    cloudflareEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')! as typeof registry extends never
      ? never
      : { __authrimWorkerEnv?: Record<string, unknown>; send: typeof registry.getNotifier };
    const send = vi.fn().mockResolvedValue({ messageId: 'cf-email-1' });

    await expect(
      (handler as never as { send(n: unknown): Promise<unknown> }).send(email)
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('EMAIL'),
    });
    (handler as never as { __authrimWorkerEnv: Record<string, unknown> }).__authrimWorkerEnv = {
      EMAIL: { send },
    };
    const runtimeHandler = handler as never as { send(n: unknown): Promise<unknown> };
    await expect(runtimeHandler.send({ ...email, channel: 'sms' })).resolves.toMatchObject({
      success: false,
      retryable: false,
    });
    await expect(runtimeHandler.send({ ...email, subject: '' })).resolves.toMatchObject({
      success: false,
      error: 'Email subject is required',
    });
    await expect(
      runtimeHandler.send({
        ...email,
        cc: ['a@example.com', 'b@example.com'],
        bcc: ['c@example.com'],
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('maximum') });

    await expect(
      runtimeHandler.send({
        ...email,
        templateVars: { name: 'Bob' },
        cc: ['cc@example.com', 'cc@example.com'],
        bcc: [],
        metadata: { textBody: 'Welcome Bob', headers: { 'X-Test': '1' } },
      })
    ).resolves.toMatchObject({ success: true, messageId: 'cf-email-1' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { email: 'noreply@example.com', name: 'Authrim' },
        replyTo: { email: 'support@example.com', name: 'Authrim' },
        html: '<p>Welcome Bob</p>',
        text: 'Welcome Bob',
        cc: ['cc@example.com'],
        bcc: undefined,
      })
    );
  });

  it('checks Cloudflare binding health and handles provider failures', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { defaultFrom: 'noreply@example.com', maxRecipientsPerRequest: 50 };
    await expect(
      cloudflareEmailPlugin.initialize?.({ logger, env: {} } as never, config)
    ).rejects.toThrow('EMAIL');
    await expect(cloudflareEmailPlugin.healthCheck?.(undefined, config)).resolves.toMatchObject({
      status: 'unhealthy',
    });
    const ctx = { logger, env: { EMAIL: { send: vi.fn() } } } as never;
    await cloudflareEmailPlugin.initialize?.(ctx, config);
    await expect(cloudflareEmailPlugin.healthCheck?.(ctx, config)).resolves.toMatchObject({
      status: 'healthy',
      checks: { binding: { status: 'pass' }, sender: { status: 'pass' } },
    });

    const registry = new CapabilityRegistry();
    cloudflareEmailPlugin.register(registry, config);
    const handler = registry.getNotifier('email')! as never as {
      __authrimWorkerEnv: Record<string, unknown>;
      send(n: unknown): Promise<unknown>;
    };
    handler.__authrimWorkerEnv = { EMAIL: { send: vi.fn().mockRejectedValue(new Error('quota')) } };
    await expect(handler.send(email)).resolves.toMatchObject({
      success: false,
      error: 'quota',
      retryable: true,
    });
  });

  it('registers console delivery for all channels and supports deterministic failures', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new CapabilityRegistry();
    const config = {
      prefix: '[TEST]',
      includeTimestamp: false,
      logLevel: 'info' as const,
      prettyPrint: false,
      simulateDelayMs: 0,
      simulateFailureRate: 1,
    };
    consoleNotifierPlugin.register(registry, config);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await expect(registry.getNotifier('email')!.send(email)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Simulated failure'),
    });
    expect(registry.getNotifier('sms')).toBeDefined();
    expect(registry.getNotifier('push')).toBeDefined();

    await consoleNotifierPlugin.initialize?.(
      { env: { ENVIRONMENT: 'production' } } as never,
      config
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('enabled in production'));
    await expect(consoleNotifierPlugin.healthCheck?.()).resolves.toMatchObject({
      status: 'healthy',
    });
  });
});
