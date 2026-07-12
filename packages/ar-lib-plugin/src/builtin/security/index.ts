/**
 * Security Plugins
 *
 * Built-in security plugins for Authrim.
 */

export {
  cloudflareTurnstilePlugin,
  CloudflareTurnstileConfigSchema,
  TurnstileFailurePolicySchema,
} from './turnstile';
export type { CloudflareTurnstileConfig, TurnstileFailurePolicy } from './turnstile';
export { hcaptchaPlugin, HCaptchaConfigSchema, HCaptchaWidgetModeSchema } from './hcaptcha';
export type { HCaptchaConfig, HCaptchaWidgetMode } from './hcaptcha';
export {
  googleReCaptchaPlugin,
  ReCaptchaConfigSchema,
  ReCaptchaWidgetModeSchema,
} from './recaptcha';
export type { ReCaptchaConfig, ReCaptchaWidgetMode } from './recaptcha';
export {
  verifyHumanVerificationToken,
  verifyTurnstileToken,
  type HumanVerificationAction,
  type HumanVerificationOptions,
  type HumanVerificationResult,
  type TurnstileVerificationOptions,
  type TurnstileVerificationResult,
} from './turnstile-runtime';

import { cloudflareTurnstilePlugin } from './turnstile';
import { hcaptchaPlugin } from './hcaptcha';
import { googleReCaptchaPlugin } from './recaptcha';

export const builtinSecurityPlugins = [
  cloudflareTurnstilePlugin,
  hcaptchaPlugin,
  googleReCaptchaPlugin,
] as const;
