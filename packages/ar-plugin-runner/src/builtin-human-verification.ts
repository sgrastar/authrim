import type { D1DatabaseSession } from '@cloudflare/workers-types';
import { readBoundedResponseBody } from './bounded-response';
import { PluginOutboundGateway } from './outbound-gateway';
import {
  StaticInProcessSyncHookRegistry,
  type InProcessSyncHookHandler,
} from './sync-hook-backend-router';
import type { HumanVerificationHookInput } from './sync-hooks';
import type { PluginRunnerEnv } from './types';

const MAX_RESPONSE_BYTES = 16 * 1024;
const CAPABILITY = 'human_verification.verify';

const PROVIDERS = {
  'human-verification-cloudflare-turnstile': {
    provider: 'turnstile',
    url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    contentType: 'application/json',
  },
  'human-verification-hcaptcha': {
    provider: 'hcaptcha',
    url: 'https://api.hcaptcha.com/siteverify',
    contentType: 'application/x-www-form-urlencoded',
  },
  'human-verification-google-recaptcha': {
    provider: 'recaptcha',
    url: 'https://www.google.com/recaptcha/api/siteverify',
    contentType: 'application/x-www-form-urlencoded',
  },
} as const;

type ProviderId = keyof typeof PROVIDERS;

interface ConfigRow {
  plugin_id: string;
  config_version: number | string;
  provider: string;
  site_key: string;
  expected_hostname: string | null;
  widget_mode: string;
  score_threshold: number | string;
}

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  score?: unknown;
}

function primary(env: PluginRunnerEnv): D1DatabaseSession {
  if (typeof env.PLUGIN_RUNNER_DB.withSession !== 'function') {
    throw new Error('plugin_human_verification_d1_session_required');
  }
  return env.PLUGIN_RUNNER_DB.withSession('first-primary');
}

function inputFor(payload: unknown): HumanVerificationHookInput {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('plugin_sync_rejected');
  }
  return payload as HumanVerificationHookInput;
}

async function loadConfig(
  env: PluginRunnerEnv,
  input: HumanVerificationHookInput
): Promise<ConfigRow> {
  const row = await primary(env)
    .prepare(
      `SELECT installation.plugin_id, installation.config_version,
              config.provider, config.site_key, config.expected_hostname,
              config.widget_mode, config.score_threshold
         FROM plugin_runner_installations installation
         JOIN plugin_runner_human_verification_configs config
           ON config.installation_id = installation.installation_id
          AND config.config_version = installation.config_version
        WHERE installation.installation_id = ? AND installation.tenant_id = ?
          AND installation.state = 'enabled' AND installation.backend_kind = 'in_process'`
    )
    .bind(input.pluginInstallationId, input.tenantId)
    .first<ConfigRow>();
  if (
    !row ||
    !(row.plugin_id in PROVIDERS) ||
    PROVIDERS[row.plugin_id as ProviderId].provider !== row.provider ||
    typeof row.site_key !== 'string' ||
    row.site_key.length < 1 ||
    (row.expected_hostname !== null && typeof row.expected_hostname !== 'string')
  ) {
    throw new Error('plugin_sync_rejected');
  }
  return row;
}

function requestFor(
  providerId: ProviderId,
  config: ConfigRow,
  input: HumanVerificationHookInput,
  signal: AbortSignal
): Request {
  const provider = PROVIDERS[providerId];
  if (provider.provider === 'turnstile') {
    return new Request(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': provider.contentType },
      body: JSON.stringify({
        response: input.responseToken,
        ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
        idempotency_key: crypto.randomUUID(),
      }),
      signal,
    });
  }
  const body = new URLSearchParams({ response: input.responseToken });
  if (provider.provider === 'hcaptcha') body.set('sitekey', config.site_key);
  if (input.remoteIp) body.set('remoteip', input.remoteIp);
  return new Request(provider.url, {
    method: 'POST',
    headers: { 'Content-Type': provider.contentType },
    body,
    signal,
  });
}

function validResponse(
  providerId: ProviderId,
  config: ConfigRow,
  input: HumanVerificationHookInput,
  result: SiteverifyResponse
): boolean {
  if (result.success !== true) return false;
  if (config.expected_hostname && result.hostname !== config.expected_hostname) return false;
  const provider = PROVIDERS[providerId].provider;
  if (provider === 'turnstile') return result.action === `authrim-${input.action}`;
  if (provider !== 'recaptcha' || config.widget_mode !== 'score') return true;
  const threshold = Number(config.score_threshold);
  return (
    Number.isFinite(threshold) &&
    threshold >= 0 &&
    threshold <= 1 &&
    result.action === `authrim_${input.action}` &&
    typeof result.score === 'number' &&
    Number.isFinite(result.score) &&
    result.score >= threshold
  );
}

function handler(env: PluginRunnerEnv, providerId: ProviderId): InProcessSyncHookHandler {
  return async (payload, signal) => {
    const input = inputFor(payload);
    const config = await loadConfig(env, input);
    if (config.plugin_id !== providerId) throw new Error('plugin_sync_rejected');
    const response = await new PluginOutboundGateway({
      ...env,
      AUTHRIM_PLUGIN_EGRESS_CONTEXT: {
        contractVersion: 1,
        tenantId: input.tenantId,
        pluginInstallationId: input.pluginInstallationId,
        capability: CAPABILITY,
        requestId: input.requestId,
      },
    }).fetch(requestFor(providerId, config, input, signal));
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new Error('plugin_sync_transient_failure');
    }
    let result: SiteverifyResponse;
    try {
      const bytes = await readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        'plugin_sync_response_too_large'
      );
      result = JSON.parse(new TextDecoder().decode(bytes)) as SiteverifyResponse;
    } catch {
      throw new Error('plugin_sync_transient_failure');
    }
    return validResponse(providerId, config, input, result)
      ? { decision: 'allow', reasonCode: 'verification_succeeded' }
      : { decision: 'deny', reasonCode: 'verification_failed' };
  };
}

export function createBuiltinHumanVerificationRegistry(
  env: PluginRunnerEnv
): StaticInProcessSyncHookRegistry {
  return new StaticInProcessSyncHookRegistry(
    new Map(
      (Object.keys(PROVIDERS) as ProviderId[]).map((pluginId) => [
        `${pluginId}:${CAPABILITY}`,
        handler(env, pluginId),
      ])
    )
  );
}
