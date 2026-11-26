import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../core/registry';
import type { AuthrimPlugin, PluginContext } from '../core/types';
import {
  builtinSecurityPlugins,
  cloudflareTurnstilePlugin,
  CloudflareTurnstileConfigSchema,
  googleReCaptchaPlugin,
  hcaptchaPlugin,
  HCaptchaConfigSchema,
  ReCaptchaConfigSchema,
  TurnstileFailurePolicySchema,
} from '../builtin/security';

afterEach(() => vi.useRealTimers());

type AnyPlugin = AuthrimPlugin<never>;

const cases = [
  {
    plugin: cloudflareTurnstilePlugin as unknown as AnyPlugin,
    id: 'human-verification-cloudflare-turnstile',
    capability: 'human_verification.turnstile',
    name: 'Cloudflare Turnstile',
    docs: 'https://developers.cloudflare.com/turnstile/',
    tags: ['cloudflare', 'turnstile', 'captcha', 'bot-protection', 'login-ui'],
    healthy: 'Turnstile configuration is present',
    dependency: 'Cloudflare Turnstile',
    notes: ['Create a Turnstile widget in Cloudflare.', 'cf-turnstile-response'],
  },
  {
    plugin: hcaptchaPlugin as unknown as AnyPlugin,
    id: 'human-verification-hcaptcha',
    capability: 'human_verification.hcaptcha',
    name: 'hCaptcha',
    docs: 'https://docs.hcaptcha.com/',
    tags: ['hcaptcha', 'captcha', 'bot-protection', 'login-ui'],
    healthy: 'hCaptcha configuration is present',
    dependency: 'hCaptcha',
    notes: ['Create an hCaptcha sitekey.', 'Authrim validates hCaptcha tokens on the server.'],
  },
  {
    plugin: googleReCaptchaPlugin as unknown as AnyPlugin,
    id: 'human-verification-google-recaptcha',
    capability: 'human_verification.recaptcha',
    name: 'Google reCAPTCHA',
    docs: 'https://developers.google.com/recaptcha',
    tags: ['google', 'recaptcha', 'captcha', 'bot-protection', 'login-ui'],
    healthy: 'Google reCAPTCHA configuration is present',
    dependency: 'Google reCAPTCHA',
    notes: [
      'Create a reCAPTCHA key in the Google reCAPTCHA admin console.',
      'Authrim validates reCAPTCHA tokens on the server.',
    ],
  },
];

describe.each(cases)('$name plugin', (entry) => {
  const { plugin } = entry;

  it('identifies itself as an official, configuration-only plugin', () => {
    expect(plugin.id).toBe(entry.id);
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.capabilities).toEqual([entry.capability]);
    expect(plugin.official).toBe(true);
    const registry = new CapabilityRegistry();
    plugin.register(registry, {} as never);
    expect(registry.listCapabilities()).toEqual([]);
  });

  it('describes itself for the Admin UI', () => {
    expect(plugin.meta).toMatchObject({
      name: entry.name,
      category: 'security',
      author: { name: 'Authrim', url: 'https://authrim.com' },
      license: 'MIT',
      icon: 'shield-check',
      tags: entry.tags,
      documentationUrl: entry.docs,
      repositoryUrl: 'https://github.com/sgrastar/authrim',
      minAuthrimVersion: '1.0.0',
      stability: 'beta',
    });
    expect(plugin.meta.description).toContain('Login UI');
    expect(plugin.meta.externalDependencies).toHaveLength(1);
    expect(plugin.meta.externalDependencies?.[0]).toMatchObject({
      name: entry.dependency,
      required: true,
    });
    expect(plugin.meta.externalDependencies?.[0]?.url).toMatch(/^https:\/\//u);
    expect(plugin.meta.externalDependencies?.[0]?.description).toContain('key');
    for (const phrase of entry.notes) expect(plugin.meta.adminNotes).toContain(phrase);
    expect(plugin.meta.adminNotes).toContain('The secret key is never returned to Login UI.');
    expect(plugin.meta.adminNotes?.startsWith('\n## Setup')).toBe(true);
  });

  it('reports health from the presence of both keys', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));
    const ctx = {} as PluginContext;
    const health = (config: unknown) =>
      plugin.healthCheck?.(ctx, config as never) as Promise<{
        status: string;
        message: string;
        timestamp: number;
      }>;
    const timestamp = Date.parse('2026-02-03T04:05:06.000Z');
    await expect(health({ siteKey: 'a', secretKey: 'b' })).resolves.toEqual({
      status: 'healthy',
      message: entry.healthy,
      timestamp,
    });
    for (const config of [
      { siteKey: 'a' },
      { secretKey: 'b' },
      { siteKey: '', secretKey: 'b' },
      {},
      undefined,
    ]) {
      await expect(health(config)).resolves.toEqual({
        status: 'unhealthy',
        message: 'Missing site key or secret key',
        timestamp,
      });
    }
  });
});

describe('security plugin catalogue', () => {
  it('lists the three built-in plugins in order', () => {
    expect(builtinSecurityPlugins.map((plugin) => plugin.id)).toEqual([
      'human-verification-cloudflare-turnstile',
      'human-verification-hcaptcha',
      'human-verification-google-recaptcha',
    ]);
  });
});

describe('security plugin configuration', () => {
  const base = { siteKey: 's', secretKey: 'k' };

  it('applies the documented defaults', () => {
    expect(CloudflareTurnstileConfigSchema.parse(base)).toEqual({
      ...base,
      failurePolicy: 'fail_closed',
      timeoutMs: 5000,
    });
    expect(HCaptchaConfigSchema.parse(base)).toEqual({
      ...base,
      widgetMode: 'checkbox',
      failurePolicy: 'fail_closed',
      timeoutMs: 5000,
    });
    expect(ReCaptchaConfigSchema.parse(base)).toEqual({
      ...base,
      widgetMode: 'checkbox',
      scoreThreshold: 0.5,
      failurePolicy: 'fail_closed',
      timeoutMs: 5000,
    });
  });

  it.each([
    ['Turnstile', CloudflareTurnstileConfigSchema],
    ['hCaptcha', HCaptchaConfigSchema],
    ['reCAPTCHA', ReCaptchaConfigSchema],
  ])('%s requires both keys and bounds the timeout to 1-10 seconds', (_name, schema) => {
    expect(schema.safeParse({ secretKey: 'k' }).success).toBe(false);
    expect(schema.safeParse({ siteKey: 's' }).success).toBe(false);
    expect(schema.safeParse({ siteKey: '', secretKey: 'k' }).success).toBe(false);
    expect(schema.safeParse({ siteKey: 's', secretKey: '' }).success).toBe(false);
    for (const [timeoutMs, valid] of [
      [999, false],
      [1000, true],
      [10000, true],
      [10001, false],
      [1500.5, false],
    ] as const) {
      expect(schema.safeParse({ ...base, timeoutMs }).success).toBe(valid);
    }
  });

  it('accepts only fail_closed as the failure policy', () => {
    expect(TurnstileFailurePolicySchema.safeParse('fail_closed').success).toBe(true);
    expect(TurnstileFailurePolicySchema.safeParse('fail_open').success).toBe(false);
    expect(
      CloudflareTurnstileConfigSchema.safeParse({ ...base, failurePolicy: 'fail_open' }).success
    ).toBe(false);
  });

  it('knows the widget modes of each service and the score range of reCAPTCHA', () => {
    for (const mode of ['checkbox', 'invisible']) {
      expect(HCaptchaConfigSchema.safeParse({ ...base, widgetMode: mode }).success).toBe(true);
    }
    expect(HCaptchaConfigSchema.safeParse({ ...base, widgetMode: 'score' }).success).toBe(false);
    for (const mode of ['checkbox', 'invisible', 'score']) {
      expect(ReCaptchaConfigSchema.safeParse({ ...base, widgetMode: mode }).success).toBe(true);
    }
    for (const [scoreThreshold, valid] of [
      [-0.01, false],
      [0, true],
      [1, true],
      [1.01, false],
    ] as const) {
      expect(ReCaptchaConfigSchema.safeParse({ ...base, scoreThreshold }).success).toBe(valid);
    }
  });

  it('keeps the expected hostname optional', () => {
    expect(
      CloudflareTurnstileConfigSchema.parse({ ...base, expectedHostname: 'a.example' })
        .expectedHostname
    ).toBe('a.example');
    expect(CloudflareTurnstileConfigSchema.parse(base)).not.toHaveProperty('expectedHostname');
  });
});
