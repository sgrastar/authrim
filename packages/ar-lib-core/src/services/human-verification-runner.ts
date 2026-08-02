import type { Env, HumanVerificationHookInput } from '../types/env';
import { derivePluginInstallationId } from './plugin-installation-id';

const DEFAULT_PLUGIN_ID = 'human-verification-cloudflare-turnstile';
const MAX_TOKEN_LENGTH = 4_096;

export type HumanVerificationAction = HumanVerificationHookInput['action'];

interface AuthenticationMethodSettings {
  'authentication-methods.human_verification.provider'?: unknown;
  'authentication-methods.human_verification.login_enabled'?: unknown;
  'authentication-methods.human_verification.signup_enabled'?: unknown;
  'authentication-methods.human_verification.reauth_enabled'?: unknown;
}

export interface HumanVerificationRunnerInput {
  tenantId: string;
  action: HumanVerificationAction;
  responseToken: unknown;
  remoteIp?: string;
}

export interface HumanVerificationRunnerResult {
  required: boolean;
  verified: boolean;
}

function enabled(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

async function selection(
  env: Env,
  tenantId: string,
  action: HumanVerificationAction
): Promise<{ required: boolean; pluginId: string }> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  if (!raw) return { required: false, pluginId: DEFAULT_PLUGIN_ID };
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('human_verification_settings_invalid');
  }
  const settings = parsed as AuthenticationMethodSettings;
  const provider = settings['authentication-methods.human_verification.provider'];
  return {
    required: enabled(settings[`authentication-methods.human_verification.${action}_enabled`]),
    pluginId: typeof provider === 'string' && provider.trim() ? provider.trim() : DEFAULT_PLUGIN_ID,
  };
}

async function pluginEnabled(env: Env, tenantId: string, pluginId: string): Promise<boolean> {
  const tenantValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenantValue !== null && tenantValue !== undefined) return tenantValue === 'true';
  const globalValue = await env.SETTINGS?.get(`plugins:enabled:${pluginId}`);
  if (globalValue !== null && globalValue !== undefined) return globalValue === 'true';
  return true;
}

export async function verifyHumanVerificationWithRunner(
  env: Env,
  input: HumanVerificationRunnerInput
): Promise<HumanVerificationRunnerResult> {
  const selected = await selection(env, input.tenantId, input.action);
  if (!selected.required) return { required: false, verified: true };

  const token = typeof input.responseToken === 'string' ? input.responseToken.trim() : '';
  if (
    !token ||
    token.length > MAX_TOKEN_LENGTH ||
    !(await pluginEnabled(env, input.tenantId, selected.pluginId)) ||
    !env.PLUGIN_RUNNER ||
    !env.AUTHRIM_ENVIRONMENT_NAME
  ) {
    return { required: true, verified: false };
  }

  const pluginInstallationId = await derivePluginInstallationId({
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    tenantId: input.tenantId,
    pluginId: selected.pluginId,
    purpose: 'human-verification',
  });
  const result = await env.PLUGIN_RUNNER.runHumanVerification({
    tenantId: input.tenantId,
    pluginInstallationId,
    requestId: crypto.randomUUID(),
    action: input.action,
    responseToken: token,
    ...(input.remoteIp ? { remoteIp: input.remoteIp } : {}),
  });
  return { required: true, verified: result.decision === 'allow' };
}
