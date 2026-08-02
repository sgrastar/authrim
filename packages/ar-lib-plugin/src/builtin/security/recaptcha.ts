/**
 * Google reCAPTCHA Human Verification Plugin
 *
 * Provides bot verification configuration for Login UI surfaces. Runtime
 * validation is performed by Authrim server endpoints via Google Siteverify.
 */

import { z } from 'zod';
import type { AuthrimPlugin, HealthStatus } from '../../core/types';
import { secretField } from '../../core/security';
import { TurnstileFailurePolicySchema } from './turnstile';

export const ReCaptchaWidgetModeSchema = z.enum(['checkbox', 'invisible', 'score']);

export const ReCaptchaConfigSchema = z.object({
  siteKey: z
    .string()
    .min(1, 'Site key is required')
    .describe('Google reCAPTCHA site key used by Login UI'),
  secretKey: secretField(
    z
      .string()
      .min(1, 'Secret key is required')
      .describe('Google reCAPTCHA secret key used only for server-side Siteverify')
  ),
  expectedHostname: z
    .string()
    .optional()
    .describe('Expected hostname returned by Siteverify. Leave blank to skip hostname matching.'),
  widgetMode: ReCaptchaWidgetModeSchema.default('checkbox').describe(
    'Use checkbox for reCAPTCHA v2, invisible for reCAPTCHA v2 invisible, or score for reCAPTCHA v3'
  ),
  scoreThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Minimum accepted score when widgetMode is score'),
  failurePolicy: TurnstileFailurePolicySchema.default('fail_closed').describe(
    'Siteverify failure always rejects the authentication request'
  ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(10000)
    .default(5000)
    .describe('Siteverify request timeout in milliseconds'),
});

export type ReCaptchaConfig = z.infer<typeof ReCaptchaConfigSchema>;
export type ReCaptchaWidgetMode = z.infer<typeof ReCaptchaWidgetModeSchema>;

export const googleReCaptchaPlugin: AuthrimPlugin<ReCaptchaConfig> = {
  id: 'human-verification-google-recaptcha',
  version: '1.0.0',
  capabilities: ['human_verification.recaptcha'],
  official: true,
  configSchema: ReCaptchaConfigSchema,
  meta: {
    name: 'Google reCAPTCHA',
    description:
      'Human verification for Login UI flows using Google reCAPTCHA and server-side Siteverify.',
    category: 'security',
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',
    icon: 'shield-check',
    tags: ['google', 'recaptcha', 'captcha', 'bot-protection', 'login-ui'],
    documentationUrl: 'https://developers.google.com/recaptcha',
    repositoryUrl: 'https://github.com/sgrastar/authrim',
    externalDependencies: [
      {
        name: 'Google reCAPTCHA',
        url: 'https://developers.google.com/recaptcha',
        required: true,
        description:
          'Requires a reCAPTCHA site key and secret key from the Google reCAPTCHA admin console.',
      },
    ],
    minAuthrimVersion: '1.0.0',
    stability: 'beta',
    adminNotes: `
## Setup
1. Create a reCAPTCHA key in the Google reCAPTCHA admin console.
2. Add your Login UI hostnames to the key configuration.
3. Configure the site key and secret key here.
4. Enable Login, Signup, or Re-authentication usage in Authentication Methods.

## Runtime
Authrim validates reCAPTCHA tokens on the server. The secret key is never returned to Login UI.
`,
  },
  register(): void {
    // Configuration-only plugin. Runtime validation is handled by Authrim auth endpoints.
  },
  async healthCheck(_ctx, config): Promise<HealthStatus> {
    const configured = Boolean(config?.siteKey && config?.secretKey);
    return {
      status: configured ? 'healthy' : 'unhealthy',
      message: configured
        ? 'Google reCAPTCHA configuration is present'
        : 'Missing site key or secret key',
      timestamp: Date.now(),
    };
  },
};

export default googleReCaptchaPlugin;
