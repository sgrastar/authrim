import { derivePluginInstallationId, type Env } from '@authrim/ar-lib-core';

export const BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS = new Set([
  'human-verification-cloudflare-turnstile',
  'human-verification-hcaptcha',
  'human-verification-google-recaptcha',
]);

function runner(env: Env): NonNullable<Env['PLUGIN_RUNNER']> {
  if (!env.PLUGIN_RUNNER) throw new Error('human_verification_projection_runner_unavailable');
  return env.PLUGIN_RUNNER;
}

export async function deriveHumanVerificationInstallationId(
  env: Env,
  input: { tenantId: string; pluginId: string }
): Promise<string> {
  if (!env.AUTHRIM_ENVIRONMENT_NAME) {
    throw new Error('human_verification_projection_environment_unavailable');
  }
  return derivePluginInstallationId({
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    purpose: 'human-verification',
  });
}

function stringValue(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function projectTenantHumanVerificationProvider(
  env: Env,
  input: {
    tenantId: string;
    pluginId: string;
    config: Readonly<Record<string, unknown>>;
    operationId?: string;
  }
): Promise<string> {
  if (!BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(input.pluginId)) {
    throw new Error('human_verification_projection_provider_unsupported');
  }
  if (input.config.failurePolicy === 'fail_open') {
    throw new Error('human_verification_projection_fail_open_forbidden');
  }
  const siteKey = stringValue(input.config, 'siteKey');
  const secretKey = stringValue(input.config, 'secretKey');
  if (!siteKey || !secretKey) {
    throw new Error('human_verification_projection_config_unavailable');
  }
  const expectedHostname = stringValue(input.config, 'expectedHostname');
  const widgetMode = stringValue(input.config, 'widgetMode');
  const installationId = await deriveHumanVerificationInstallationId(env, input);
  await runner(env).configureHumanVerificationInstallation({
    operationId: input.operationId ?? `human-verification-config-${crypto.randomUUID()}`,
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    enabled: true,
    config: {
      siteKey,
      secretKey,
      ...(expectedHostname ? { expectedHostname } : {}),
      ...(widgetMode
        ? {
            widgetMode: widgetMode as 'managed' | 'checkbox' | 'invisible' | 'score',
          }
        : {}),
      ...(typeof input.config.scoreThreshold === 'number'
        ? { scoreThreshold: input.config.scoreThreshold }
        : {}),
    },
  });
  return installationId;
}

export async function disableTenantHumanVerificationProvider(
  env: Env,
  input: { tenantId: string; pluginId: string; operationId?: string }
): Promise<void> {
  if (!BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(input.pluginId)) return;
  const installationId = await deriveHumanVerificationInstallationId(env, input);
  await runner(env).configureHumanVerificationInstallation({
    operationId: input.operationId ?? `human-verification-disable-${crypto.randomUUID()}`,
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    enabled: false,
  });
}
