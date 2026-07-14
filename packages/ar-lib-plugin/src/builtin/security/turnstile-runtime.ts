import {
  decryptSecretFields,
  getPluginEncryptionKey,
  type EncryptedConfig,
} from '../../core/security';

const TURNSTILE_PLUGIN_ID = 'human-verification-cloudflare-turnstile';
const HCAPTCHA_PLUGIN_ID = 'human-verification-hcaptcha';
const RECAPTCHA_PLUGIN_ID = 'human-verification-google-recaptcha';
const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HCAPTCHA_SITEVERIFY_URL = 'https://api.hcaptcha.com/siteverify';
const RECAPTCHA_SITEVERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const MAX_TOKEN_LENGTH = 4096;

export type HumanVerificationAction = 'login' | 'signup' | 'reauth';
export type HumanVerificationFailurePolicy = 'fail_closed' | 'fail_open';
export type TurnstileFailurePolicy = HumanVerificationFailurePolicy;

type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha';

interface HumanVerificationRuntimeEnv {
  SETTINGS?: KVNamespace;
  PLUGIN_ENCRYPTION_KEY?: string;
}

interface AuthenticationMethodKVSettings {
  'authentication-methods.human_verification.provider'?: string;
  'authentication-methods.human_verification.login_enabled'?: boolean | string;
  'authentication-methods.human_verification.signup_enabled'?: boolean | string;
  'authentication-methods.human_verification.reauth_enabled'?: boolean | string;
}

interface ProviderConfig {
  siteKey?: unknown;
  secretKey?: unknown;
  expectedHostname?: unknown;
  widgetMode?: unknown;
  scoreThreshold?: unknown;
  failurePolicy?: unknown;
  timeoutMs?: unknown;
}

interface SiteverifyResponse {
  success?: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  score?: number;
  'error-codes'?: string[];
}

export interface HumanVerificationOptions {
  env: HumanVerificationRuntimeEnv;
  tenantId: string;
  actions: HumanVerificationAction | HumanVerificationAction[];
  response: unknown;
  remoteIp?: string;
}

export type HumanVerificationResult =
  | { ok: true; action: HumanVerificationAction | null; required: boolean }
  | { ok: false; reason: 'missing_or_invalid_token' | 'verification_failed'; required: true };

export interface TurnstileVerificationOptions {
  env: HumanVerificationRuntimeEnv;
  tenantId: string;
  actions: HumanVerificationAction | HumanVerificationAction[];
  token: unknown;
  remoteIp?: string;
}

export type TurnstileVerificationResult = HumanVerificationResult;

interface RequiredHumanVerificationPolicy {
  provider: HumanVerificationProvider;
  pluginId: string;
  enabledActions: HumanVerificationAction[];
  siteKey: string;
  secretKey: string;
  expectedHostname: string | null;
  failurePolicy: HumanVerificationFailurePolicy;
  timeoutMs: number;
  widgetMode: string;
  scoreThreshold: number;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function actionEnabled(settings: AuthenticationMethodKVSettings, action: HumanVerificationAction) {
  switch (action) {
    case 'login':
      return parseBoolean(
        settings['authentication-methods.human_verification.login_enabled'],
        false
      );
    case 'signup':
      return parseBoolean(
        settings['authentication-methods.human_verification.signup_enabled'],
        false
      );
    case 'reauth':
      return parseBoolean(
        settings['authentication-methods.human_verification.reauth_enabled'],
        false
      );
  }
}

async function decryptConfigIfNeeded(
  env: HumanVerificationRuntimeEnv,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const encrypted = config as EncryptedConfig;
  if (!encrypted._encrypted || encrypted._encrypted.length === 0) return config;

  try {
    const key = await getPluginEncryptionKey(env);
    return await decryptSecretFields(encrypted, key);
  } catch {
    const encryptedFields = new Set(encrypted._encrypted);
    return Object.fromEntries(
      Object.entries(config).filter(
        ([field]) => field !== '_encrypted' && !encryptedFields.has(field)
      )
    );
  }
}

async function readJsonConfig(
  env: HumanVerificationRuntimeEnv,
  key: string
): Promise<Record<string, unknown>> {
  const raw = await env.SETTINGS?.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return decryptConfigIfNeeded(env, parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

async function isPluginEnabled(
  env: HumanVerificationRuntimeEnv,
  pluginId: string,
  tenantId: string
): Promise<boolean> {
  const tenantValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenantValue !== null && tenantValue !== undefined) return tenantValue === 'true';

  const globalValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}`);
  if (globalValue !== null && globalValue !== undefined) return globalValue === 'true';

  return true;
}

function providerFromPluginId(pluginId: string): HumanVerificationProvider | null {
  if (pluginId === TURNSTILE_PLUGIN_ID) return 'turnstile';
  if (pluginId === HCAPTCHA_PLUGIN_ID) return 'hcaptcha';
  if (pluginId === RECAPTCHA_PLUGIN_ID) return 'recaptcha';
  return null;
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === 'number' && value >= 1000 && value <= 10000 ? Math.floor(value) : 5000;
}

function normalizeScoreThreshold(value: unknown): number {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : 0.5;
}

async function resolveRequiredHumanVerificationPolicy(
  env: HumanVerificationRuntimeEnv,
  tenantId: string,
  actions: HumanVerificationAction[]
): Promise<RequiredHumanVerificationPolicy | null> {
  const settingsRaw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  const settings = settingsRaw
    ? (JSON.parse(settingsRaw) as AuthenticationMethodKVSettings)
    : ({} as AuthenticationMethodKVSettings);
  const enabledActions = actions.filter((action) => actionEnabled(settings, action));
  if (enabledActions.length === 0) return null;

  const pluginId =
    typeof settings['authentication-methods.human_verification.provider'] === 'string'
      ? settings['authentication-methods.human_verification.provider']
      : TURNSTILE_PLUGIN_ID;
  const provider = providerFromPluginId(pluginId);
  if (!provider) {
    return {
      provider: 'turnstile',
      pluginId,
      enabledActions,
      siteKey: '',
      secretKey: '',
      expectedHostname: null,
      failurePolicy: 'fail_closed',
      timeoutMs: 5000,
      widgetMode: 'checkbox',
      scoreThreshold: 0.5,
    };
  }
  if (!(await isPluginEnabled(env, pluginId, tenantId))) return null;

  const [globalConfig, tenantConfig] = await Promise.all([
    readJsonConfig(env, `plugins:config:${pluginId}`),
    readJsonConfig(env, `plugins:config:${pluginId}:tenant:${tenantId}`),
  ]);
  const config: ProviderConfig = { ...globalConfig, ...tenantConfig };
  const siteKey = typeof config.siteKey === 'string' ? config.siteKey.trim() : '';
  const secretKey = typeof config.secretKey === 'string' ? config.secretKey.trim() : '';

  return {
    provider,
    pluginId,
    enabledActions,
    siteKey,
    secretKey,
    expectedHostname:
      typeof config.expectedHostname === 'string' && config.expectedHostname.trim()
        ? config.expectedHostname.trim()
        : null,
    failurePolicy: config.failurePolicy === 'fail_open' ? 'fail_open' : 'fail_closed',
    timeoutMs: normalizeTimeoutMs(config.timeoutMs),
    widgetMode: typeof config.widgetMode === 'string' ? config.widgetMode : 'checkbox',
    scoreThreshold: normalizeScoreThreshold(config.scoreThreshold),
  };
}

function isServiceFailure(result: SiteverifyResponse): boolean {
  const codes = result['error-codes'] ?? [];
  return codes.includes('internal-error');
}

function actionFromWidgetAction(value: unknown): HumanVerificationAction | null {
  if (value === 'authrim-login') return 'login';
  if (value === 'authrim-signup') return 'signup';
  if (value === 'authrim-reauth') return 'reauth';
  if (value === 'authrim_login') return 'login';
  if (value === 'authrim_signup') return 'signup';
  if (value === 'authrim_reauth') return 'reauth';
  return null;
}

function validateCommonResult(
  policy: RequiredHumanVerificationPolicy,
  result: SiteverifyResponse
): HumanVerificationResult | null {
  if (!result.success) {
    return isServiceFailure(result) && policy.failurePolicy === 'fail_open'
      ? { ok: true, action: null, required: true }
      : { ok: false, reason: 'verification_failed', required: true };
  }
  if (policy.expectedHostname && result.hostname !== policy.expectedHostname) {
    return { ok: false, reason: 'verification_failed', required: true };
  }
  return null;
}

async function postFormSiteverify(
  url: string,
  body: URLSearchParams,
  timeoutMs: number
): Promise<{ response: Response; result: SiteverifyResponse }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    return { response, result: (await response.json()) as SiteverifyResponse };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTurnstileWithPolicy(
  policy: RequiredHumanVerificationPolicy,
  normalizedToken: string,
  remoteIp: string | undefined
): Promise<HumanVerificationResult> {
  const allowedActions = new Set(policy.enabledActions.map((action) => `authrim-${action}`));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: policy.secretKey,
        response: normalizedToken,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: controller.signal,
    });
    const result = (await response.json()) as SiteverifyResponse;

    if (!response.ok && policy.failurePolicy === 'fail_open') {
      return { ok: true, action: null, required: true };
    }
    const common = validateCommonResult(policy, result);
    if (common) return common;
    if (!allowedActions.has(result.action ?? '')) {
      return { ok: false, reason: 'verification_failed', required: true };
    }

    return { ok: true, action: actionFromWidgetAction(result.action), required: true };
  } catch {
    return policy.failurePolicy === 'fail_open'
      ? { ok: true, action: null, required: true }
      : { ok: false, reason: 'verification_failed', required: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyHCaptchaWithPolicy(
  policy: RequiredHumanVerificationPolicy,
  normalizedToken: string,
  remoteIp: string | undefined
): Promise<HumanVerificationResult> {
  const body = new URLSearchParams({
    secret: policy.secretKey,
    response: normalizedToken,
    sitekey: policy.siteKey,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const { response, result } = await postFormSiteverify(
      HCAPTCHA_SITEVERIFY_URL,
      body,
      policy.timeoutMs
    );
    if (!response.ok && policy.failurePolicy === 'fail_open') {
      return { ok: true, action: null, required: true };
    }
    return validateCommonResult(policy, result) ?? { ok: true, action: null, required: true };
  } catch {
    return policy.failurePolicy === 'fail_open'
      ? { ok: true, action: null, required: true }
      : { ok: false, reason: 'verification_failed', required: true };
  }
}

async function verifyReCaptchaWithPolicy(
  policy: RequiredHumanVerificationPolicy,
  normalizedToken: string,
  remoteIp: string | undefined
): Promise<HumanVerificationResult> {
  const body = new URLSearchParams({
    secret: policy.secretKey,
    response: normalizedToken,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const { response, result } = await postFormSiteverify(
      RECAPTCHA_SITEVERIFY_URL,
      body,
      policy.timeoutMs
    );
    if (!response.ok && policy.failurePolicy === 'fail_open') {
      return { ok: true, action: null, required: true };
    }
    const common = validateCommonResult(policy, result);
    if (common) return common;

    if (policy.widgetMode === 'score') {
      const allowedActions = new Set(policy.enabledActions.map((action) => `authrim_${action}`));
      if (!allowedActions.has(result.action ?? '') || (result.score ?? 0) < policy.scoreThreshold) {
        return { ok: false, reason: 'verification_failed', required: true };
      }
      return { ok: true, action: actionFromWidgetAction(result.action), required: true };
    }

    return { ok: true, action: null, required: true };
  } catch {
    return policy.failurePolicy === 'fail_open'
      ? { ok: true, action: null, required: true }
      : { ok: false, reason: 'verification_failed', required: true };
  }
}

export async function verifyHumanVerificationToken(
  options: HumanVerificationOptions
): Promise<HumanVerificationResult> {
  const actions = Array.isArray(options.actions) ? options.actions : [options.actions];
  const resolved = await resolveRequiredHumanVerificationPolicy(
    options.env,
    options.tenantId,
    actions
  );
  if (!resolved) return { ok: true, action: null, required: false };

  const normalizedToken = typeof options.response === 'string' ? options.response.trim() : '';
  if (
    !normalizedToken ||
    normalizedToken.length > MAX_TOKEN_LENGTH ||
    !resolved.secretKey ||
    !resolved.siteKey
  ) {
    return { ok: false, reason: 'missing_or_invalid_token', required: true };
  }

  switch (resolved.provider) {
    case 'turnstile':
      return verifyTurnstileWithPolicy(resolved, normalizedToken, options.remoteIp);
    case 'hcaptcha':
      return verifyHCaptchaWithPolicy(resolved, normalizedToken, options.remoteIp);
    case 'recaptcha':
      return verifyReCaptchaWithPolicy(resolved, normalizedToken, options.remoteIp);
  }
}

export async function verifyTurnstileToken(
  options: TurnstileVerificationOptions
): Promise<TurnstileVerificationResult> {
  return verifyHumanVerificationToken({
    env: options.env,
    tenantId: options.tenantId,
    actions: options.actions,
    response: options.token,
    remoteIp: options.remoteIp,
  });
}
