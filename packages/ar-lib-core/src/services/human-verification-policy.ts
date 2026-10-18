import type { Env } from '../types/env';

/**
 * One decision for "does this flow need human verification, and can the provider verify?".
 *
 * The login UI's `/api/auth/authentication-methods` (whether to show the widget) and the servers
 * that check the token (`verifyHumanVerificationWithRunner`) both decide here, so the widget and
 * the check cannot disagree. The admin guards (disabling a provider, turning a flow on) use the
 * same pieces.
 *
 * The provider switch is the plugin admin API's `plugins:enabled:<id>[:tenant:<t>]`; a value that
 * was never written means the provider is DISABLED: a provider is on only after an admin enabled
 * it (which also projects its credentials to the runner), the same default the plugin admin API
 * reports. A required flow whose provider is not available is refused (fail closed).
 */

export type HumanVerificationFlow = 'login' | 'signup' | 'reauth';

export const HUMAN_VERIFICATION_FLOWS: readonly HumanVerificationFlow[] = [
  'login',
  'signup',
  'reauth',
];

export const DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID = 'human-verification-cloudflare-turnstile';

export const HUMAN_VERIFICATION_SETTING_PREFIX = 'authentication-methods.human_verification.';

export const HUMAN_VERIFICATION_SETTINGS_INVALID = 'human_verification_settings_invalid';

/**
 * Why a flow cannot be completed: the provider is switched off (or never switched on), it has no
 * credentials, or the tenant's settings cannot be read (the servers refuse every attempt then).
 */
export type HumanVerificationUnavailableReason =
  | 'provider_disabled'
  | 'provider_unconfigured'
  | 'settings_unreadable';

export interface HumanVerificationSelection {
  pluginId: string;
  /** Per flow: the tenant's settings ask for a token. */
  required: Readonly<Record<HumanVerificationFlow, boolean>>;
}

export interface HumanVerificationDecision {
  /** The flow needs a token. */
  required: boolean;
  /** The provider can verify one (enabled, and configured when that is known). */
  available: boolean;
  /** Set when `available` is false. */
  reason: HumanVerificationUnavailableReason | null;
}

function enabledValue(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** The selection a tenant's `authentication-methods` document holds (`null`: none saved). */
export function humanVerificationSelectionFromSettings(
  settings: Readonly<Record<string, unknown>> | null | undefined
): HumanVerificationSelection {
  const provider = settings?.[`${HUMAN_VERIFICATION_SETTING_PREFIX}provider`];
  const required = {} as Record<HumanVerificationFlow, boolean>;
  for (const flow of HUMAN_VERIFICATION_FLOWS) {
    required[flow] = enabledValue(
      settings?.[`${HUMAN_VERIFICATION_SETTING_PREFIX}${flow}_enabled`]
    );
  }
  return {
    pluginId:
      typeof provider === 'string' && provider.trim()
        ? provider.trim()
        : DEFAULT_HUMAN_VERIFICATION_PLUGIN_ID,
    required,
  };
}

/** Throws `human_verification_settings_invalid` for a document that is not an object. */
export function parseHumanVerificationSettingsDocument(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(HUMAN_VERIFICATION_SETTINGS_INVALID);
  }
  return parsed as Record<string, unknown>;
}

export function humanVerificationSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:authentication-methods`;
}

/** Reads the tenant's selection. Throws when the saved document cannot be read (fail closed). */
export async function readHumanVerificationSelection(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string
): Promise<HumanVerificationSelection> {
  const raw = await env.SETTINGS?.get(humanVerificationSettingsKey(tenantId));
  return humanVerificationSelectionFromSettings(parseHumanVerificationSettingsDocument(raw));
}

/** Whether any of the flows asks for a token. */
export function isHumanVerificationRequired(
  selection: HumanVerificationSelection,
  flows: readonly HumanVerificationFlow[]
): boolean {
  return flows.some((flow) => selection.required[flow]);
}

/** The flows whose settings ask for a token. */
export function requiredHumanVerificationFlows(
  selection: HumanVerificationSelection
): HumanVerificationFlow[] {
  return HUMAN_VERIFICATION_FLOWS.filter((flow) => selection.required[flow]);
}

function filledIn(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The static limits on a provider's configuration. The runner refuses to project (and so to verify
 * with) anything outside them, so every side that decides "this provider is usable" must apply the
 * same ones: the settings API, the admin guards, the projection and the runner itself all use this.
 */
export const HUMAN_VERIFICATION_LIMITS = {
  siteKeyMaxLength: 2_048,
  secretKeyMaxLength: 8_192,
} as const;

/** A hostname the provider's response may name (lower case, dotted labels). */
export const HUMAN_VERIFICATION_HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export type HumanVerificationWidgetMode = 'managed' | 'checkbox' | 'invisible' | 'score';

/** Per built-in provider: the widget mode used when none is set, and the modes it accepts. */
export const HUMAN_VERIFICATION_PROVIDER_WIDGET_MODES: Readonly<
  Record<
    string,
    { default: HumanVerificationWidgetMode; allowed: readonly HumanVerificationWidgetMode[] }
  >
> = {
  'human-verification-cloudflare-turnstile': { default: 'managed', allowed: ['managed'] },
  'human-verification-hcaptcha': { default: 'checkbox', allowed: ['checkbox', 'invisible'] },
  'human-verification-google-recaptcha': {
    default: 'checkbox',
    allowed: ['checkbox', 'invisible', 'score'],
  },
};

/**
 * Whether a provider's configuration has both keys, ignoring surrounding whitespace: what the
 * projection to the runner and the runner itself require, so a key of spaces is not configured.
 * This is only the presence test; {@link humanVerificationConfigValid} applies every limit.
 */
export function humanVerificationCredentialsConfigured(
  config: { siteKey?: unknown; secretKey?: unknown } | null | undefined
): boolean {
  return filledIn(config?.siteKey) && filledIn(config?.secretKey);
}

/**
 * Whether the runner would accept this configuration for the built-in provider: both keys within
 * their length limits after trimming, a well-formed expected hostname (trimmed, lower-cased) when
 * one is set, a widget mode the provider supports, a score threshold between 0 and 1, and no
 * `fail_open` policy. A configuration that fails this reports as unusable, not as configured.
 */
export function humanVerificationConfigValid(
  pluginId: string,
  config: Readonly<Record<string, unknown>> | null | undefined
): boolean {
  // Own properties only: 'toString', 'constructor' and '__proto__' are not providers.
  const modes = Object.hasOwn(HUMAN_VERIFICATION_PROVIDER_WIDGET_MODES, pluginId)
    ? HUMAN_VERIFICATION_PROVIDER_WIDGET_MODES[pluginId]
    : undefined;
  if (!modes || !config) return false;
  if (!humanVerificationCredentialsConfigured(config)) return false;
  const siteKey = (config.siteKey as string).trim();
  const secretKey = (config.secretKey as string).trim();
  if (siteKey.length > HUMAN_VERIFICATION_LIMITS.siteKeyMaxLength) return false;
  if (secretKey.length > HUMAN_VERIFICATION_LIMITS.secretKeyMaxLength) return false;
  if (config.failurePolicy === 'fail_open') return false;
  const hostname = config.expectedHostname;
  if (hostname !== undefined && hostname !== null) {
    if (typeof hostname !== 'string') return false;
    const normalized = hostname.trim().toLowerCase();
    if (normalized && !HUMAN_VERIFICATION_HOSTNAME_PATTERN.test(normalized)) return false;
  }
  const mode = config.widgetMode;
  if (mode !== undefined && mode !== null) {
    if (typeof mode !== 'string') return false;
    const trimmed = mode.trim();
    if (trimmed && !(modes.allowed as readonly string[]).includes(trimmed)) return false;
  }
  const threshold = config.scoreThreshold;
  if (threshold !== undefined && threshold !== null) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return false;
    if (threshold < 0 || threshold > 1) return false;
  }
  return true;
}

/**
 * Whether the provider is switched on for the tenant: the tenant's flag, else the global flag,
 * else off (never enabled).
 */
export async function isHumanVerificationPluginEnabled(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string,
  pluginId: string
): Promise<boolean> {
  const tenantValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenantValue !== null && tenantValue !== undefined) return tenantValue === 'true';
  const globalValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}`);
  if (globalValue !== null && globalValue !== undefined) return globalValue === 'true';
  return false;
}

/**
 * Whether a provider can verify, and why not. `configured` is only known where the credentials are
 * readable (the settings API); the verifying side leaves it out and the runner checks it.
 */
export function humanVerificationProviderAvailability(input: {
  pluginEnabled: boolean;
  configured?: boolean;
}): { available: boolean; reason: HumanVerificationUnavailableReason | null } {
  if (!input.pluginEnabled) return { available: false, reason: 'provider_disabled' };
  if (input.configured === false) return { available: false, reason: 'provider_unconfigured' };
  return { available: true, reason: null };
}

/** The decision for a flow (or the flows one operation performs). */
export function decideHumanVerification(input: {
  selection: HumanVerificationSelection;
  flows: readonly HumanVerificationFlow[];
  pluginEnabled: boolean;
  configured?: boolean;
}): HumanVerificationDecision {
  return {
    required: isHumanVerificationRequired(input.selection, input.flows),
    ...humanVerificationProviderAvailability(input),
  };
}
