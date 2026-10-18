import type { Env, HumanVerificationHookInput } from '../types/env';
import { derivePluginInstallationId } from './plugin-installation-id';
import {
  decideHumanVerification,
  isHumanVerificationPluginEnabled,
  isHumanVerificationRequired,
  readHumanVerificationSelection,
} from './human-verification-policy';

const MAX_TOKEN_LENGTH = 4_096;

export type HumanVerificationAction = HumanVerificationHookInput['action'];

export interface HumanVerificationRunnerInput {
  tenantId: string;
  /** The screen the token was issued for; the token must match it. */
  action: HumanVerificationAction;
  /**
   * Further actions this operation performs (a sign-up asked from the login screen): a token is
   * required when any of their settings, or the screen's, asks for one.
   */
  alsoRequiredFor?: readonly HumanVerificationAction[];
  responseToken: unknown;
  remoteIp?: string;
}

export interface HumanVerificationRunnerResult {
  required: boolean;
  verified: boolean;
}

export async function verifyHumanVerificationWithRunner(
  env: Env,
  input: HumanVerificationRunnerInput
): Promise<HumanVerificationRunnerResult> {
  const selection = await readHumanVerificationSelection(env, input.tenantId);
  const flows = [input.action, ...(input.alsoRequiredFor ?? [])];
  if (!isHumanVerificationRequired(selection, flows)) return { required: false, verified: true };

  const token = typeof input.responseToken === 'string' ? input.responseToken.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) return { required: true, verified: false };
  // The same decision the login UI shows the widget by: a provider that is not available fails
  // closed here, and the UI says so instead of showing a widget (human-verification-policy.ts).
  const decision = decideHumanVerification({
    selection,
    flows,
    pluginEnabled: await isHumanVerificationPluginEnabled(env, input.tenantId, selection.pluginId),
  });
  if (!decision.available || !env.PLUGIN_RUNNER || !env.AUTHRIM_ENVIRONMENT_NAME) {
    return { required: true, verified: false };
  }

  const pluginInstallationId = await derivePluginInstallationId({
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    tenantId: input.tenantId,
    pluginId: selection.pluginId,
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
