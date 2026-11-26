import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloudflareEmailPlugin,
  CloudflareNotifierConfigSchema,
} from '../builtin/notifier/cloudflare';
import { CapabilityRegistry } from '../core/registry';
import type { PluginContext } from '../core/types';

type Runtime = {
  __authrimWorkerEnv?: Record<string, unknown>;
  send(notification: unknown): Promise<Record<string, unknown>>;
};

const config = CloudflareNotifierConfigSchema.parse({ defaultFrom: 'noreply@example.com' });
const note = { channel: 'email', to: 'user@example.com', subject: 'S', body: '<p>B</p>' };

function runtime(
  overrides: Record<string, unknown> = {},
  binding: unknown = { send: vi.fn(async () => ({ messageId: 'm1' })) }
) {
  const registry = new CapabilityRegistry();
  cloudflareEmailPlugin.register(
    registry,
    CloudflareNotifierConfigSchema.parse({ defaultFrom: 'noreply@example.com', ...overrides })
  );
  const handler = registry.getNotifier('email') as unknown as Runtime;
  handler.__authrimWorkerEnv = { EMAIL: binding };
  return handler;
}

function ctx(env: Record<string, unknown> | undefined) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger, ctx: { logger, env } as unknown as PluginContext };
}

afterEach(() => vi.useRealTimers());

describe('Cloudflare email binding detection', () => {
  const MISSING = 'Cloudflare Email Service binding `EMAIL` is not configured';

  it.each([
    ['a null binding', null],
    ['a string binding', 'EMAIL'],
    ['a binding without send', {}],
    ['a binding whose send is not a function', { send: 'x' }],
  ])('refuses to send with %s at runtime', async (_label, binding) => {
    const result = await runtime({}, binding).send(note);
    expect(result).toEqual({ success: false, error: MISSING, retryable: false });
  });

  it('refuses to send when the handler has no worker environment at all', async () => {
    const handler = runtime();
    delete handler.__authrimWorkerEnv;
    expect(await handler.send(note)).toEqual({ success: false, error: MISSING, retryable: false });
  });

  it.each([
    ['an environment without EMAIL', {}],
    ['a null binding', { EMAIL: null }],
    ['a string binding', { EMAIL: 'x' }],
    ['a binding without send', { EMAIL: {} }],
    ['a binding whose send is not a function', { EMAIL: { send: 1 } }],
  ])('fails to initialise with %s', async (_label, env) => {
    await expect(cloudflareEmailPlugin.initialize?.(ctx(env).ctx, config)).rejects.toThrow(MISSING);
  });

  it('fails to initialise without any environment', async () => {
    await expect(cloudflareEmailPlugin.initialize?.(ctx(undefined).ctx, config)).rejects.toThrow(
      MISSING
    );
  });

  it('logs the sender settings when initialised', async () => {
    const { logger, ctx: context } = ctx({ EMAIL: { send: vi.fn() } });
    await cloudflareEmailPlugin.initialize?.(
      context,
      CloudflareNotifierConfigSchema.parse({ defaultFrom: 'a@example.com', fromName: 'Acme' })
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[cloudflare-email] Cloudflare Email Service notifier initialized',
      { defaultFrom: 'a@example.com', fromName: 'Acme', maxRecipientsPerRequest: 50 }
    );
  });
});

describe('Cloudflare email health', () => {
  it('needs a configuration and a usable binding', async () => {
    await expect(cloudflareEmailPlugin.healthCheck?.(undefined, undefined)).resolves.toEqual({
      status: 'unhealthy',
      message: 'Configuration not available',
    });
    await expect(cloudflareEmailPlugin.healthCheck?.(ctx({}).ctx, config)).resolves.toEqual({
      status: 'unhealthy',
      message: 'Cloudflare Email Service binding `EMAIL` is missing',
    });
  });

  it('reports a usable binding with the default sender and a timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
    await expect(
      cloudflareEmailPlugin.healthCheck?.(ctx({ EMAIL: { send: vi.fn() } }).ctx, config)
    ).resolves.toEqual({
      status: 'healthy',
      message: 'Cloudflare Email Service binding is available',
      checks: {
        binding: { status: 'pass', message: 'EMAIL binding is configured' },
        sender: { status: 'pass', message: 'Default sender: noreply@example.com' },
      },
      timestamp: Date.parse('2026-05-06T07:08:09.000Z'),
    });
  });
});

describe('Cloudflare email sending', () => {
  it('describes the plugin', () => {
    expect(cloudflareEmailPlugin.id).toBe('notifier-cloudflare');
    expect(cloudflareEmailPlugin.version).toBe('1.0.0');
    expect(cloudflareEmailPlugin.official).toBe(true);
    expect(cloudflareEmailPlugin.capabilities).toEqual(['notifier.email']);
    expect(cloudflareEmailPlugin.meta).toMatchObject({
      name: 'Cloudflare Email Service',
      category: 'notification',
      icon: 'mail',
      license: 'MIT',
      stability: 'beta',
      minAuthrimVersion: '1.0.0',
      tags: ['email', 'cloudflare', 'workers', 'transactional', 'otp'],
    });
    expect(cloudflareEmailPlugin.meta.adminNotes).toContain('## Setup Steps');
    expect(cloudflareEmailPlugin.meta.adminNotes).toContain('## Notes');
  });

  it('refuses other channels and a missing subject with fixed messages', async () => {
    const handler = runtime();
    expect(await handler.send({ ...note, channel: 'sms' })).toEqual({
      success: false,
      error: 'Cloudflare Email Service only supports email notifications',
      retryable: false,
    });
    expect(await handler.send({ ...note, subject: undefined })).toEqual({
      success: false,
      error: 'Email subject is required',
      retryable: false,
    });
  });

  it('limits the recipients to the configured maximum, counting the primary, cc and bcc', async () => {
    const handler = runtime({ maxRecipientsPerRequest: 3 });
    expect((await handler.send({ ...note, cc: ['a@x.test'], bcc: ['b@x.test'] })).success).toBe(
      true
    );
    expect(
      await handler.send({ ...note, cc: ['a@x.test', 'c@x.test'], bcc: ['b@x.test'] })
    ).toEqual({
      success: false,
      error: 'Recipient count exceeds configured maximum (3)',
      retryable: false,
    });
  });

  it('sends the message the binding expects', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-1' }));
    const handler = runtime({ fromName: 'Acme', replyTo: 'cfg@example.com' }, { send });
    const result = await handler.send({
      ...note,
      from: 'sender@example.com',
      replyTo: 'msg@example.com',
      cc: ['c@x.test', 'c@x.test', 'd@x.test'],
      bcc: [],
      templateVars: { name: 'Ann' },
      body: 'Hi {{name}}',
      metadata: { textBody: 'Hi Ann', headers: { 'X-A': '1' } },
    });
    expect(result).toEqual({
      success: true,
      messageId: 'cf-1',
      providerResponse: { messageId: 'cf-1' },
    });
    expect(send).toHaveBeenCalledWith({
      to: 'user@example.com',
      from: { email: 'sender@example.com', name: 'Acme' },
      subject: 'S',
      html: 'Hi Ann',
      text: 'Hi Ann',
      cc: ['c@x.test', 'd@x.test'],
      bcc: undefined,
      replyTo: { email: 'msg@example.com', name: 'Acme' },
      headers: { 'X-A': '1' },
    });
  });

  it('uses plain addresses without a display name and the configured defaults', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-2' }));
    const handler = runtime({ replyTo: 'cfg@example.com' }, { send });
    await handler.send({ ...note, metadata: { textBody: 5, headers: 'nope' } });
    expect(send).toHaveBeenCalledWith({
      to: 'user@example.com',
      from: 'noreply@example.com',
      subject: 'S',
      html: '<p>B</p>',
      text: undefined,
      cc: undefined,
      bcc: undefined,
      replyTo: 'cfg@example.com',
      headers: undefined,
    });
  });

  it('sends no reply-to when none is configured', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-3' }));
    await runtime({}, { send }).send(note);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ replyTo: undefined });
  });

  it('keeps the body as is without template variables', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-4' }));
    await runtime({}, { send }).send({ ...note, body: 'Hi {{name}}' });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ html: 'Hi {{name}}' });
  });

  it('makes up a message id when the binding returns none', async () => {
    const handler = runtime({}, { send: vi.fn(async () => ({})) });
    const result = await handler.send(note);
    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('reports a binding failure as retryable, with its message when it has one', async () => {
    const failing = runtime(
      {},
      {
        send: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
      }
    );
    expect(await failing.send(note)).toEqual({
      success: false,
      error: 'quota exceeded',
      retryable: true,
    });
    const odd = runtime(
      {},
      {
        send: vi.fn(async () => {
          throw 'weird';
        }),
      }
    );
    expect(await odd.send(note)).toEqual({
      success: false,
      error: 'Cloudflare email send failed',
      retryable: true,
    });
  });
});
