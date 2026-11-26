import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, safeFetch };
});

import { resendEmailPlugin, ResendNotifierConfigSchema } from '../builtin/notifier/resend';
import { CapabilityRegistry } from '../core/registry';
import type { PluginContext, SendResult } from '../core/types';

type Overrides = Record<string, unknown>;

function config(overrides: Overrides = {}) {
  return ResendNotifierConfigSchema.parse({
    apiKey: 're_secret123',
    defaultFrom: 'noreply@example.com',
    ...overrides,
  });
}

function handler(overrides: Overrides = {}) {
  const registry = new CapabilityRegistry();
  resendEmailPlugin.register(registry, config(overrides));
  const registered = registry.getNotifier('email');
  if (!registered) throw new Error('email notifier not registered');
  return registered;
}

function json(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function sentRequest(): Record<string, unknown> {
  const init = (safeFetch.mock.calls[0] as [string, { body: string }])[1];
  return JSON.parse(init.body) as Record<string, unknown>;
}

const note = { channel: 'email' as const, to: 'user@example.com', subject: 'S', body: '<p>B</p>' };

describe('Resend health check', () => {
  beforeEach(() => safeFetch.mockReset());
  const health = (cfg: ReturnType<typeof config> | undefined) =>
    resendEmailPlugin.healthCheck?.(undefined, cfg) as Promise<{ status: string; message: string }>;

  it('is unhealthy without configuration', async () => {
    await expect(health(undefined)).resolves.toEqual({
      status: 'unhealthy',
      message: 'Configuration not available',
    });
  });

  it('asks the domains endpoint over HTTPS with the API key and a short timeout', async () => {
    safeFetch.mockResolvedValue(json(200, {}));
    await expect(health(config())).resolves.toEqual({
      status: 'healthy',
      message: 'Resend API is reachable',
    });
    expect(safeFetch).toHaveBeenCalledWith('https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: 'Bearer re_secret123' },
      requireHttps: true,
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
    });
  });

  it('is degraded for a rejected API key and for any other status', async () => {
    safeFetch.mockResolvedValueOnce(json(401, {}));
    await expect(health(config())).resolves.toEqual({
      status: 'degraded',
      message: 'API key may be invalid',
    });
    safeFetch.mockResolvedValueOnce(json(503, {}));
    await expect(health(config())).resolves.toEqual({
      status: 'degraded',
      message: 'Resend API returned status 503',
    });
  });

  it('is unhealthy when the API cannot be reached, naming the reason', async () => {
    safeFetch.mockRejectedValueOnce(new Error('dns failure'));
    await expect(health(config())).resolves.toEqual({
      status: 'unhealthy',
      message: 'Failed to reach Resend API: dns failure',
    });
    safeFetch.mockRejectedValueOnce('boom');
    await expect(health(config())).resolves.toEqual({
      status: 'unhealthy',
      message: 'Failed to reach Resend API: Unknown error',
    });
  });
});

describe('Resend initialization', () => {
  const context = (environment: string | undefined) => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    return {
      logger,
      ctx: { logger, env: { ENVIRONMENT: environment } } as unknown as PluginContext,
    };
  };

  it('warns about a key that does not look like a Resend key', async () => {
    const odd = context('staging');
    await resendEmailPlugin.initialize?.(odd.ctx, config({ apiKey: 'sk_other' }));
    expect(odd.logger.warn).toHaveBeenCalledWith(
      '[resend] API key does not start with "re_" - this may not be a valid Resend key'
    );
    const fine = context('staging');
    await resendEmailPlugin.initialize?.(fine.ctx, config());
    expect(fine.logger.warn).not.toHaveBeenCalled();
  });

  it('warns only when sandbox mode runs in production', async () => {
    const prod = context('production');
    await resendEmailPlugin.initialize?.(prod.ctx, config({ sandboxMode: true }));
    expect(prod.logger.warn).toHaveBeenCalledWith(
      '[resend] Sandbox mode is enabled in production - emails will not be delivered!'
    );
    for (const [environment, sandboxMode] of [
      ['staging', true],
      ['production', false],
    ] as const) {
      const quiet = context(environment);
      await resendEmailPlugin.initialize?.(quiet.ctx, config({ sandboxMode }));
      expect(quiet.logger.warn).not.toHaveBeenCalled();
    }
  });

  it('logs the settings it starts with', async () => {
    const started = context(undefined);
    await resendEmailPlugin.initialize?.(started.ctx, config({ timeoutMs: 2000 }));
    expect(started.logger.info).toHaveBeenCalledWith('[resend] Resend Email notifier initialized', {
      defaultFrom: 'noreply@example.com',
      sandboxMode: false,
      timeoutMs: 2000,
    });
  });
});

describe('Resend request building', () => {
  beforeEach(() => {
    safeFetch.mockReset();
    safeFetch.mockImplementation(async () => json(200, { id: 'e1' }));
  });

  it('posts to the emails endpoint with the key and the configured limits', async () => {
    const result = await handler({ timeoutMs: 2000 }).send(note);
    expect(result).toMatchObject({ success: true, messageId: 'e1' });
    expect(safeFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer re_secret123', 'Content-Type': 'application/json' },
        requireHttps: true,
        timeoutMs: 2000,
        // The size is enforced while reading the body, so an oversize 429/5xx keeps its status.
        maxResponseSize: 0,
      })
    );
  });

  it('rejects a success body over the limit while reading it', async () => {
    safeFetch.mockResolvedValue(json(200, { id: 'e1', pad: 'x'.repeat(65 * 1024) }));
    expect(await handler().send(note)).toMatchObject({ success: false });
  });

  it('sends the plain message with no optional fields', async () => {
    await handler().send(note);
    expect(sentRequest()).toEqual({
      from: 'noreply@example.com',
      to: 'user@example.com',
      subject: 'S',
      html: '<p>B</p>',
    });
  });

  it('sends empty strings for a missing subject or body', async () => {
    await handler().send({ channel: 'email', to: 'user@example.com' } as never);
    expect(sentRequest()).toMatchObject({ subject: '', html: '' });
  });

  it('renders templates only when variables are given', async () => {
    await handler().send({ ...note, subject: 'Hi {{name}}', body: '{{name}}!' });
    expect(sentRequest()).toMatchObject({ subject: 'Hi {{name}}', html: '{{name}}!' });
    safeFetch.mockClear();
    await handler().send({
      ...note,
      subject: 'Hi {{name}}',
      body: '{{name}}!',
      templateVars: { name: 'Ann' },
    });
    expect(sentRequest()).toMatchObject({ subject: 'Hi Ann', html: 'Ann!' });
  });

  it('prefers the message reply-to over the configured one', async () => {
    await handler({ replyTo: 'cfg@example.com' }).send({ ...note, replyTo: 'msg@example.com' });
    expect(sentRequest().reply_to).toBe('msg@example.com');
    safeFetch.mockClear();
    await handler({ replyTo: 'cfg@example.com' }).send(note);
    expect(sentRequest().reply_to).toBe('cfg@example.com');
    safeFetch.mockClear();
    await handler().send({ ...note, replyTo: 'msg@example.com' });
    expect(sentRequest().reply_to).toBe('msg@example.com');
    safeFetch.mockClear();
    await handler().send(note);
    expect(sentRequest()).not.toHaveProperty('reply_to');
  });

  it('ignores cc and bcc that are not lists', async () => {
    await handler().send({ ...note, cc: 'a@example.com', bcc: 'b@example.com' } as never);
    const request = sentRequest();
    expect(request).not.toHaveProperty('cc');
    expect(request).not.toHaveProperty('bcc');
  });

  it('takes the text body and headers from metadata only when they have the right type', async () => {
    await handler().send({ ...note, metadata: { textBody: 5, headers: 'x' } });
    const request = sentRequest();
    expect(request).not.toHaveProperty('text');
    expect(request).not.toHaveProperty('headers');
    expect(request.tags).toEqual([]);
  });

  it('sends the other string metadata as at most ten tags, and no tags without metadata', async () => {
    const metadata: Record<string, unknown> = { textBody: 't', headers: { H: 'v' }, n: 1 };
    for (let i = 0; i < 12; i += 1) metadata[`k${i}`] = `v${i}`;
    await handler().send({ ...note, metadata });
    const request = sentRequest();
    expect(request.text).toBe('t');
    expect(request.headers).toEqual({ H: 'v' });
    expect((request.tags as unknown[]).length).toBe(10);
    expect((request.tags as Array<{ name: string }>)[0]).toEqual({ name: 'k0', value: 'v0' });
    safeFetch.mockClear();
    await handler().send(note);
    expect(sentRequest()).not.toHaveProperty('tags');
  });
});

describe('Resend recipient limit and results', () => {
  beforeEach(() => {
    safeFetch.mockReset();
    safeFetch.mockImplementation(async () => json(200, { id: 'e1' }));
  });

  it('counts to, cc and bcc together against the limit', async () => {
    const send = handler({ maxRecipientsPerRequest: 4 }).send;
    const ok = await send({
      ...note,
      to: ['a@x.test', 'b@x.test'],
      cc: ['c@x.test'],
      bcc: ['d@x.test'],
    });
    expect(ok.success).toBe(true);
    const over = await send({
      ...note,
      to: ['a@x.test', 'b@x.test'],
      cc: ['c@x.test'],
      bcc: ['d@x.test', 'e@x.test'],
    });
    expect(over).toEqual({ success: false, error: 'Too many recipients (5 > 4)' });
    const single = await handler({ maxRecipientsPerRequest: 1 }).send(note);
    expect(single.success).toBe(true);
    const singleWithCc = await handler({ maxRecipientsPerRequest: 1 }).send({
      ...note,
      cc: ['c@x.test'],
    });
    expect(singleWithCc).toEqual({ success: false, error: 'Too many recipients (2 > 1)' });
  });

  it('refuses other channels', async () => {
    const result = await handler().send({ ...note, channel: 'sms' } as never);
    expect(result).toEqual({ success: false, error: 'Resend plugin only supports email channel' });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('supports every message', () => {
    expect(handler().supports?.({})).toBe(true);
  });

  it('returns the message id of an accepted email', async () => {
    await expect(handler().send(note)).resolves.toEqual({
      success: true,
      messageId: 'e1',
      providerResponse: { id: 'e1' },
    });
  });
});

describe('Resend failures', () => {
  beforeEach(() => safeFetch.mockReset());

  const failWith = async (status: number, body: unknown): Promise<SendResult> => {
    safeFetch.mockResolvedValue(json(status, body));
    return handler().send(note);
  };

  it.each([
    [400, false],
    [429, true],
    [499, false],
    [500, true],
    [503, true],
  ])('answers API status %s with retryable=%s', async (status, retryable) => {
    expect(await failWith(status, { message: 'm', name: 'n' })).toEqual({
      success: false,
      error: 'm',
      errorCode: 'n',
      retryable,
    });
  });

  it('keeps the retry decision when the error body cannot be read', async () => {
    expect(await failWith(502, '<html>bad gateway</html>')).toEqual({
      success: false,
      error: 'Resend API error: 502',
      errorCode: undefined,
      retryable: true,
    });
    expect(await failWith(422, '<html>')).toMatchObject({
      error: 'Resend API error: 422',
      retryable: false,
    });
  });

  it('keeps the retry decision when the error body is too large to read', async () => {
    const huge = 'x'.repeat(17 * 1024);
    expect(await failWith(503, huge)).toEqual({
      success: false,
      error: 'Resend API error: 503',
      errorCode: undefined,
      retryable: true,
    });
    expect(await failWith(400, huge)).toEqual({
      success: false,
      error: 'Resend API error: 400',
      errorCode: undefined,
      retryable: false,
    });
  });

  it('keeps the retry decision when reading the error body fails', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream broke'));
      },
    });
    safeFetch.mockResolvedValue(new Response(broken, { status: 429 }));
    expect(await handler().send(note)).toEqual({
      success: false,
      error: 'Resend API error: 429',
      errorCode: undefined,
      retryable: true,
    });
  });

  it.each([429, 503])(
    'keeps the status default and the retry decision for a %i body whose fields are not strings',
    async (status) => {
      for (const body of [
        { message: 123, name: 'n' },
        { message: { nested: 'x' }, name: ['n'] },
        { message: 'ok message', name: 42 },
        null,
        [1, 2],
      ]) {
        const result = await failWith(status, body);
        expect(result.success).toBe(false);
        expect(result.retryable).toBe(true);
        expect(typeof result.error).toBe('string');
        expect(result.errorCode === undefined || typeof result.errorCode === 'string').toBe(true);
      }
      expect(await failWith(status, { message: 123, name: { a: 1 } })).toEqual({
        success: false,
        error: `Resend API error: ${status}`,
        errorCode: undefined,
        retryable: true,
      });
      expect(await failWith(status, { message: 'ok message', name: 42 })).toMatchObject({
        error: 'ok message',
        errorCode: undefined,
      });
    }
  );

  it('falls back to the status message for an error body without a message', async () => {
    expect(await failWith(400, { name: 'validation_error' })).toMatchObject({
      error: 'Resend API error: 400',
      errorCode: 'validation_error',
    });
  });

  it('redacts API keys and truncates long API messages at 200 characters', async () => {
    expect((await failWith(400, { message: 'bad key re_abc123XYZ here' })).error).toBe(
      'bad key [REDACTED] here'
    );
    const exact = 'x'.repeat(200);
    expect((await failWith(400, { message: exact })).error).toBe(exact);
    expect((await failWith(400, { message: `${exact}y` })).error).toBe(`${exact}...`);
  });

  describe('thrown errors', () => {
    const throwing = async (error: unknown): Promise<SendResult> => {
      safeFetch.mockRejectedValueOnce(error);
      return handler().send(note);
    };
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    it.each([
      ['an abort', abort, 'Email sending timed out', true],
      ['a timeout message', new Error('Request TIMEOUT'), 'Failed to send email', true],
      ['a network message', new Error('Network unreachable'), 'Failed to send email', true],
      ['a connection message', new Error('Connection reset'), 'Failed to send email', true],
      ['a fetch message', new Error('fetch failed'), 'Failed to connect to email service', true],
      ['another error', new Error('boom'), 'Failed to send email', false],
    ])('classifies %s', async (_label, error, message, retryable) => {
      expect(await throwing(error)).toEqual({ success: false, error: message, retryable });
    });

    it('does not describe a thrown value that is not an Error', async () => {
      expect(await throwing('oops')).toEqual({
        success: false,
        error: 'Unknown email sending error',
        retryable: false,
      });
    });
  });
});
