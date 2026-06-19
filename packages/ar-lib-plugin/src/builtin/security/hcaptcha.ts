/**
 * hCaptcha Human Verification Plugin
 *
 * Provides bot verification configuration for Login UI surfaces. Runtime
 * validation is performed by Authrim server endpoints via hCaptcha Siteverify.
 */

import { z } from 'zod';
import type { AuthrimPlugin, HealthStatus } from '../../core/types';
import { TurnstileFailurePolicySchema } from './turnstile';

export const HCaptchaWidgetModeSchema = z.enum(['checkbox', 'invisible']);

export const HCaptchaConfigSchema = z.object({
  siteKey: z.string().min(1, 'Site key is required').describe('hCaptcha sitekey used by Login UI'),
  secretKey: z
    .string()
    .min(1, 'Secret key is required')
    .describe('hCaptcha secret key used only for server-side Siteverify'),
  expectedHostname: z
    .string()
    .optional()
    .describe('Expected hostname returned by Siteverify. Leave blank to skip hostname matching.'),
  widgetMode: HCaptchaWidgetModeSchema.default('checkbox').describe(
    'How the hCaptcha widget is displayed in Login UI'
  ),
  failurePolicy: TurnstileFailurePolicySchema.default('fail_closed').describe(
    'When Siteverify is unavailable: fail_closed rejects the authentication request, fail_open allows it'
  ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(10000)
    .default(5000)
    .describe('Siteverify request timeout in milliseconds'),
});

export type HCaptchaConfig = z.infer<typeof HCaptchaConfigSchema>;
export type HCaptchaWidgetMode = z.infer<typeof HCaptchaWidgetModeSchema>;

export const hcaptchaPlugin: AuthrimPlugin<HCaptchaConfig> = {
  id: 'human-verification-hcaptcha',
  version: '1.0.0',
  capabilities: ['human_verification.hcaptcha'],
  official: true,
  configSchema: HCaptchaConfigSchema,
  meta: {
    name: 'hCaptcha',
    description: 'Human verification for Login UI flows using hCaptcha and server-side Siteverify.',
    category: 'security',
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',
    icon: 'shield-check',
    tags: ['hcaptcha', 'captcha', 'bot-protection', 'login-ui'],
    documentationUrl: 'https://docs.hcaptcha.com/',
    repositoryUrl: 'https://github.com/sgrastar/authrim',
    externalDependencies: [
      {
        name: 'hCaptcha',
        url: 'https://docs.hcaptcha.com/',
        required: true,
        description: 'Requires an hCaptcha sitekey and secret key from the hCaptcha dashboard.',
      },
    ],
    minAuthrimVersion: '1.0.0',
    stability: 'beta',
    adminNotes: `
## Setup
1. Create an hCaptcha sitekey.
2. Add your Login UI hostnames to the hCaptcha site configuration.
3. Configure the sitekey and secret key here.
4. Enable Login, Signup, or Re-authentication usage in Authentication Methods.

## Runtime
Authrim validates hCaptcha tokens on the server. The secret key is never returned to Login UI.
`,
  },
  register(): void {
    // Configuration-only plugin. Runtime validation is handled by Authrim auth endpoints.
  },
  async healthCheck(_ctx, config): Promise<HealthStatus> {
    const configured = Boolean(config?.siteKey && config?.secretKey);
    return {
      status: configured ? 'healthy' : 'unhealthy',
      message: configured ? 'hCaptcha configuration is present' : 'Missing site key or secret key',
      timestamp: Date.now(),
    };
  },
};

export default hcaptchaPlugin;
