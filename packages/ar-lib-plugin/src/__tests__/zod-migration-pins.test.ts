/**
 * zod 3 → zod 4 migration pins.
 *
 * The fixture holds what the built-in plugins produced under zod 3: the JSON Schema
 * stored in KV for the Admin UI, the plugin-config validation errors, the parsed
 * defaults and the secret-field markers. The zod 4 code must keep producing the same
 * values; any intentional difference has to be a visible fixture change.
 *
 * Regenerate (only for an intentional change): UPDATE_ZOD_PINS=1 npx vitest run zod-migration-pins
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthrimPlugin } from '../core/types';
import {
  extractFormFieldHints,
  extractPluginSchema,
  validatePluginConfig,
  zodToJSONSchema,
} from '../core/schema';
import { extractSecretFields } from '../core/security';
import {
  legacyZodErrorMessage,
  legacyZodIssueCode,
} from '@authrim/ar-lib-core/utils/zod-legacy-errors';
import { cloudflareEmailPlugin } from '../builtin/notifier/cloudflare';
import { consoleNotifierPlugin } from '../builtin/notifier/console';
import { resendEmailPlugin } from '../builtin/notifier/resend';
import {
  EmailNotificationSchema,
  NotificationSchema,
  PushNotificationSchema,
  SMSNotificationSchema,
} from '../builtin/notifier/types';
import { totpAuthenticatorPlugin } from '../builtin/authenticator/totp';
import { hcaptchaPlugin } from '../builtin/security/hcaptcha';
import { googleReCaptchaPlugin } from '../builtin/security/recaptcha';
import { cloudflareTurnstilePlugin } from '../builtin/security/turnstile';

const FIXTURE_PATH = fileURLToPath(
  new URL('./__fixtures__/zod-migration-pins.json', import.meta.url)
);

const PLUGINS: AuthrimPlugin<unknown>[] = [
  cloudflareEmailPlugin,
  consoleNotifierPlugin,
  resendEmailPlugin,
  totpAuthenticatorPlugin,
  hcaptchaPlugin,
  googleReCaptchaPlugin,
  cloudflareTurnstilePlugin,
] as AuthrimPlugin<unknown>[];

/** Inputs that exercise every validation the built-in config schemas carry. */
const INVALID_CONFIGS: Record<string, unknown[]> = {
  'notifier-cloudflare': [
    {},
    null,
    { defaultFrom: 'not-an-email', replyTo: 'x', maxRecipients: 0 },
    { defaultFrom: 'a@example.com', maxRecipients: 1.5 },
    { defaultFrom: 'a@example.com', maxRecipients: '10' },
  ],
  'notifier-console': [
    { logLevel: 'trace' },
    { prefix: 1, includeTimestamp: 'yes', simulateDelay: -1, failureRate: 2 },
  ],
  'notifier-resend': [
    {},
    { apiKey: '', defaultFrom: 'a@example.com' },
    { apiKey: 're_x', defaultFrom: 'bad', timeout: 10, apiBaseUrl: 'not a url' },
    { apiKey: 're_x', defaultFrom: 'a@example.com', maxRetries: 99, sandboxMode: 'no' },
  ],
  'authenticator-totp': [
    { algorithm: 'md5', digits: 7, period: 5, window: 99, secretLength: 1 },
    { issuer: '', digits: 'six' },
  ],
  'human-verification-hcaptcha': [
    {},
    { siteKey: 's', secretKey: 'k', widgetMode: 'score', failurePolicy: 'fail_open' },
    { siteKey: 's', secretKey: 'k', timeoutMs: 1 },
  ],
  'human-verification-google-recaptcha': [
    {},
    { siteKey: 's', secretKey: 'k', widgetMode: 'enterprise', scoreThreshold: 2 },
    { siteKey: 's', secretKey: 'k', timeoutMs: 999999 },
  ],
  'human-verification-cloudflare-turnstile': [
    {},
    { siteKey: 's', secretKey: 'k', failurePolicy: 'fail_open', timeoutMs: 'x' },
  ],
};

/** Minimal valid configs: parsing them shows which defaults the schema fills in. */
const MINIMAL_CONFIGS: Record<string, unknown> = {
  'notifier-cloudflare': { defaultFrom: 'noreply@example.com' },
  'notifier-console': {},
  'notifier-resend': { apiKey: 're_test', defaultFrom: 'noreply@example.com' },
  'authenticator-totp': {},
  'human-verification-hcaptcha': { siteKey: 'site', secretKey: 'secret' },
  'human-verification-google-recaptcha': { siteKey: 'site', secretKey: 'secret' },
  'human-verification-cloudflare-turnstile': { siteKey: 'site', secretKey: 'secret' },
};

const NOTIFICATION_INPUTS: Array<[string, unknown]> = [
  [
    'email-valid',
    { channel: 'email', to: 'a@example.com', subject: 's', body: 'b', templateVars: { a: 1 } },
  ],
  ['email-invalid', { channel: 'email', to: 'nope', cc: ['x'], templateVars: 'x', metadata: [] }],
  ['sms-invalid', { channel: 'sms', to: '0123', body: '', templateVars: null }],
  ['push-invalid', { channel: 'push', to: 1, badge: -1.5, data: 'x' }],
  ['union-valid', { channel: 'sms', to: '+10000000000', body: 'b' }],
  ['union-bad-discriminator', { channel: 'fax', to: 'x' }],
  ['union-missing-discriminator', { to: 'x' }],
];

function serializeResult(result: { success: boolean; data?: unknown; error?: unknown }) {
  if (result.success) {
    return { success: true, data: result.data };
  }
  const error = result.error as { issues: Array<Record<string, unknown>> };
  return {
    success: false,
    issues: error.issues.map((issue) => ({
      code: legacyZodIssueCode(issue),
      path: issue.path,
      message: issue.message,
    })),
  };
}

function computePins() {
  const plugins: Record<string, unknown> = {};
  for (const plugin of PLUGINS) {
    const jsonSchema = zodToJSONSchema(plugin.configSchema);
    plugins[plugin.id] = {
      jsonSchema,
      pluginSchema: extractPluginSchema(plugin).configSchema,
      formFieldHints: extractFormFieldHints(jsonSchema),
      secretFields: extractSecretFields(plugin.configSchema),
      defaults: validatePluginConfig(plugin.configSchema, MINIMAL_CONFIGS[plugin.id]),
      invalid: (INVALID_CONFIGS[plugin.id] ?? []).map((input) => ({
        input,
        result: validatePluginConfig(plugin.configSchema, input),
      })),
    };
  }

  const notifications: Record<string, unknown> = {};
  const schemas = {
    email: EmailNotificationSchema,
    sms: SMSNotificationSchema,
    push: PushNotificationSchema,
    union: NotificationSchema,
  };
  for (const [name, input] of NOTIFICATION_INPUTS) {
    const kind = name.split('-')[0] as keyof typeof schemas;
    // ar-plugin-runner only reads success; compare messages in the zod 3 vocabulary.
    notifications[name] = serializeResult(
      schemas[kind].safeParse(input, { error: legacyZodErrorMessage, reportInput: true })
    );
  }

  return { plugins, notifications };
}

/** Stable key order so fixture diffs show only real changes. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

describe('zod migration pins (ar-lib-plugin)', () => {
  const pins = computePins();

  if (process.env.UPDATE_ZOD_PINS === '1') {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(sortKeys(pins), null, 2)}\n`);
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ReturnType<typeof computePins>;

  it('covers every built-in plugin', () => {
    expect(Object.keys(pins.plugins).sort()).toEqual(Object.keys(fixture.plugins).sort());
  });

  for (const plugin of PLUGINS) {
    it(`keeps the ${plugin.id} config schema, defaults and errors`, () => {
      expect(JSON.parse(JSON.stringify(pins.plugins[plugin.id]))).toEqual(
        fixture.plugins[plugin.id]
      );
    });
  }

  it('keeps notification payload validation', () => {
    expect(JSON.parse(JSON.stringify(pins.notifications))).toEqual(fixture.notifications);
  });
});
