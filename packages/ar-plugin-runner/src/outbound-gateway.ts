import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { decryptValue, deriveEncryptionKey } from '@authrim/ar-lib-plugin';
import { authorizePluginEgressUrl, type PluginEgressRule } from './egress-policy';
import type { PluginEgressContext, PluginRunnerEnv } from './types';
import { pluginEncryptionKeyringFromEnv, pluginEncryptionSecretFor } from './encryption-keyring';
import {
  isApprovedCredentialInjectionHeader,
  STRIPPED_PLUGIN_EGRESS_HEADERS,
} from './egress-headers';
import { parsePluginExecutionContext } from './execution-context';
import { readBoundedRequestBody, readBoundedResponseBody } from './bounded-response';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RULES = 100;
const MAX_CREDENTIALS = 16;
const OUTBOUND_TIMEOUT_MS = 10_000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_HEADER = /^[A-Za-z0-9-]{1,64}$/u;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_RESULT = /^[a-z][a-z0-9_:-]{0,127}$/u;

interface InstallationRow {
  plugin_id: string;
  backend_kind: 'dynamic_worker' | 'in_process';
  version_digest: string | null;
  config_version: number | string;
  platform_rate_per_minute: number | string;
}

interface EgressRuleRow {
  match_kind: 'exact' | 'suffix_wildcard';
  host_pattern: string;
}

interface CredentialRow {
  config_key: string;
  config_version: number | string;
  injection_kind: 'header' | 'bearer' | 'json_field' | 'form_field';
  injection_name: string;
  encryption_key_id: string;
  encrypted_value: string;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_egress_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string, minimum: number, maximum: number, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

function aad(input: {
  tenantId: string;
  pluginId: string;
  configKey: string;
  configVersion: number;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([input.tenantId, input.pluginId, input.configKey, input.configVersion])
  );
}

async function boundedBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  return readBoundedRequestBody(request, MAX_REQUEST_BYTES, 'plugin_egress_request_too_large');
}

function contentType(headers: Headers): string {
  return ((headers.get('content-type') ?? '').split(';', 1)[0] ?? '').trim().toLowerCase();
}

function decodeBody(body: ArrayBuffer | undefined): string {
  if (!body) throw new Error('plugin_egress_credential_invalid');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new Error('plugin_egress_credential_invalid');
  }
}

function encodeBoundedBody(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new Error('plugin_egress_request_too_large');
  }
  return new Uint8Array(bytes).buffer;
}

export class PluginOutboundGateway {
  constructor(
    private readonly env: PluginRunnerEnv,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly executionContext?: PluginEgressContext
  ) {}

  async fetch(request: Request): Promise<Response> {
    const invocation = parsePluginExecutionContext(
      this.executionContext ?? this.env.AUTHRIM_PLUGIN_EGRESS_CONTEXT
    );
    const now = this.now();
    const session = primary(this.env.PLUGIN_RUNNER_DB);
    const installation = await session
      .prepare(
        `SELECT plugin_id, backend_kind, NULL AS version_digest, config_version,
                platform_rate_per_minute
           FROM plugin_runner_installations
          WHERE installation_id = ? AND tenant_id = ? AND state = 'enabled'
            AND backend_kind IN ('dynamic_worker', 'in_process')`
      )
      .bind(invocation.pluginInstallationId, invocation.tenantId)
      .first<InstallationRow>();
    if (!installation || !SAFE_ID.test(installation.plugin_id)) {
      throw new Error('plugin_egress_installation_unavailable');
    }
    if (installation.backend_kind === 'dynamic_worker') {
      const version = await session
        .prepare(
          `SELECT artifact.version_digest
             FROM plugin_runner_dynamic_worker_artifacts artifact
             JOIN plugin_runner_dynamic_worker_releases release
               ON release.plugin_id = artifact.plugin_id
              AND release.version_digest = artifact.version_digest AND release.state = 'published'
             JOIN plugin_runner_dynamic_worker_manifests manifest
               ON manifest.plugin_id = artifact.plugin_id AND manifest.state = 'active'
            WHERE artifact.installation_id = ? AND artifact.plugin_id = ?
              AND artifact.state = 'active'`
        )
        .bind(invocation.pluginInstallationId, installation.plugin_id)
        .first<{ version_digest: string }>();
      if (!version) throw new Error('plugin_egress_installation_unavailable');
      installation.version_digest = version.version_digest;
    }
    const configVersion = integer(
      installation.config_version,
      1,
      Number.MAX_SAFE_INTEGER,
      'plugin_egress_config_version_invalid'
    );
    const rulesResult = await session
      .prepare(
        installation.backend_kind === 'dynamic_worker'
          ? `SELECT match_kind, host_pattern
               FROM plugin_runner_dynamic_worker_egress_allowed_hosts
              WHERE plugin_id = ? AND version_digest = ? ORDER BY rule_id LIMIT ?`
          : `SELECT match_kind, host_pattern
               FROM plugin_runner_egress_allowed_hosts
              WHERE plugin_id = ? ORDER BY rule_id LIMIT ?`
      )
      .bind(
        ...(installation.backend_kind === 'dynamic_worker'
          ? [installation.plugin_id, installation.version_digest, MAX_RULES + 1]
          : [installation.plugin_id, MAX_RULES + 1])
      )
      .all<EgressRuleRow>();
    if (rulesResult.results.length > MAX_RULES)
      throw new Error('plugin_egress_rule_limit_exceeded');
    const rules: PluginEgressRule[] = rulesResult.results.map((rule) =>
      rule.match_kind === 'exact'
        ? { kind: 'exact', host: rule.host_pattern }
        : { kind: 'suffix_wildcard', suffix: rule.host_pattern }
    );
    let destination: URL;
    try {
      destination = authorizePluginEgressUrl(request.url, rules);
    } catch {
      let deniedHost = 'invalid';
      try {
        const parsed = new URL(request.url);
        if (/^[a-z0-9.-]{1,253}$/u.test(parsed.hostname)) deniedHost = parsed.hostname;
      } catch {
        // The normalized audit value deliberately omits malformed URL text.
      }
      await this.insertAudit({
        session,
        auditId: `egress-${crypto.randomUUID()}`,
        invocation,
        destinationHost: deniedHost,
        credentialInjected: false,
        resultCode: 'host_denied',
        now,
      });
      throw new Error('plugin_egress_host_denied');
    }
    const exactApproved = rules.some(
      (rule) => rule.kind === 'exact' && rule.host === destination.hostname
    );
    if (!exactApproved) {
      await this.insertAudit({
        session,
        auditId: `egress-${crypto.randomUUID()}`,
        invocation,
        destinationHost: destination.hostname,
        credentialInjected: false,
        resultCode: 'host_denied',
        now,
      });
      throw new Error('plugin_egress_wildcard_requires_controlled_proxy');
    }
    if (!ALLOWED_METHODS.has(request.method)) {
      await this.insertAudit({
        session,
        auditId: `egress-${crypto.randomUUID()}`,
        invocation,
        destinationHost: destination.hostname,
        credentialInjected: false,
        resultCode: 'method_denied',
        now,
      });
      throw new Error('plugin_egress_method_denied');
    }
    const rateLimit = integer(
      installation.platform_rate_per_minute,
      1,
      10_000,
      'plugin_egress_rate_limit_invalid'
    );
    let rateLimitAllowed: boolean;
    try {
      rateLimitAllowed = await this.consumeRateLimit({
        session,
        invocation,
        destinationHost: destination.hostname,
        limit: rateLimit,
        now,
      });
    } catch {
      await this.insertAudit({
        session,
        auditId: `egress-${crypto.randomUUID()}`,
        invocation,
        destinationHost: destination.hostname,
        credentialInjected: false,
        resultCode: 'rate_limit_failure',
        now,
      });
      throw new Error('plugin_egress_rate_limit_failed');
    }
    if (!rateLimitAllowed) {
      await this.insertAudit({
        session,
        auditId: `egress-${crypto.randomUUID()}`,
        invocation,
        destinationHost: destination.hostname,
        credentialInjected: false,
        resultCode: 'rate_limited',
        now,
      });
      throw new Error('plugin_egress_rate_limited');
    }
    const credentialsResult = await session
      .prepare(
        installation.backend_kind === 'dynamic_worker'
          ? `SELECT config.config_key, config.config_version, config.injection_kind,
                    config.injection_name, config.encryption_key_id, config.encrypted_value
               FROM plugin_runner_encrypted_configs config
               JOIN plugin_runner_dynamic_worker_credential_slots slot
                 ON slot.plugin_id = ? AND slot.version_digest = ?
                AND slot.config_key = config.config_key
                AND slot.destination_host = config.destination_host
                AND slot.injection_kind = config.injection_kind
                AND lower(slot.injection_name) = lower(config.injection_name)
              WHERE config.installation_id = ? AND config.config_version = ?
                AND config.destination_host = ?
                AND config.reencrypt_state IN ('current', 'verified')
              ORDER BY config.config_key LIMIT ?`
          : `SELECT config_key, config_version, injection_kind, injection_name,
                    encryption_key_id, encrypted_value
               FROM plugin_runner_encrypted_configs
              WHERE installation_id = ? AND config_version = ? AND destination_host = ?
                AND reencrypt_state IN ('current', 'verified')
              ORDER BY config_key LIMIT ?`
      )
      .bind(
        ...(installation.backend_kind === 'dynamic_worker'
          ? [
              installation.plugin_id,
              installation.version_digest,
              invocation.pluginInstallationId,
              configVersion,
              destination.hostname,
              MAX_CREDENTIALS + 1,
            ]
          : [
              invocation.pluginInstallationId,
              configVersion,
              destination.hostname,
              MAX_CREDENTIALS + 1,
            ])
      )
      .all<CredentialRow>();
    if (credentialsResult.results.length > MAX_CREDENTIALS) {
      throw new Error('plugin_egress_credential_limit_exceeded');
    }
    const auditId = `egress-${crypto.randomUUID()}`;
    await this.insertAudit({
      session,
      auditId,
      invocation,
      destinationHost: destination.hostname,
      credentialInjected: false,
      resultCode: 'attempted',
      now,
    });
    let body: ArrayBuffer | undefined;
    try {
      body = await boundedBody(request);
    } catch (error) {
      const tooLarge =
        error instanceof Error && error.message === 'plugin_egress_request_too_large';
      await this.finishAudit(
        session,
        auditId,
        tooLarge ? 'request_too_large' : 'network_failure',
        now
      );
      throw new Error(
        tooLarge ? 'plugin_egress_request_too_large' : 'plugin_egress_transient_failure'
      );
    }
    const headers = new Headers(request.headers);
    try {
      for (const header of STRIPPED_PLUGIN_EGRESS_HEADERS) headers.delete(header);
      const keyring = pluginEncryptionKeyringFromEnv(this.env);
      const derivedKeys = new Map<string, Promise<CryptoKey>>();
      let jsonBody: Record<string, unknown> | null = null;
      let formBody: URLSearchParams | null = null;
      for (const credential of credentialsResult.results) {
        if (
          !SAFE_CONFIG_KEY.test(credential.config_key) ||
          !SAFE_FIELD.test(credential.injection_name) ||
          !['header', 'bearer', 'json_field', 'form_field'].includes(credential.injection_kind) ||
          ((credential.injection_kind === 'header' || credential.injection_kind === 'bearer') &&
            (!SAFE_HEADER.test(credential.injection_name) ||
              !isApprovedCredentialInjectionHeader(
                credential.injection_kind,
                credential.injection_name
              )))
        ) {
          throw new Error('plugin_egress_credential_invalid');
        }
        const version = integer(
          credential.config_version,
          1,
          Number.MAX_SAFE_INTEGER,
          'plugin_egress_config_version_invalid'
        );
        let derivedKey = derivedKeys.get(credential.encryption_key_id);
        if (!derivedKey) {
          derivedKey = deriveEncryptionKey(
            pluginEncryptionSecretFor(keyring, credential.encryption_key_id)
          );
          derivedKeys.set(credential.encryption_key_id, derivedKey);
        }
        const plaintext = await decryptValue(
          credential.encrypted_value,
          await derivedKey,
          aad({
            tenantId: invocation.tenantId,
            pluginId: installation.plugin_id,
            configKey: credential.config_key,
            configVersion: version,
          })
        );
        if (plaintext.length < 1 || plaintext.length > 8_192) {
          throw new Error('plugin_egress_credential_invalid');
        }
        if (credential.injection_kind === 'header' || credential.injection_kind === 'bearer') {
          headers.set(
            credential.injection_name,
            credential.injection_kind === 'bearer' ? `Bearer ${plaintext}` : plaintext
          );
          continue;
        }
        if (credential.injection_kind === 'json_field') {
          if (formBody || contentType(headers) !== 'application/json') {
            throw new Error('plugin_egress_credential_invalid');
          }
          if (!jsonBody) {
            const parsed = JSON.parse(decodeBody(body)) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('plugin_egress_credential_invalid');
            }
            jsonBody = parsed as Record<string, unknown>;
          }
          if (Object.prototype.hasOwnProperty.call(jsonBody, credential.injection_name)) {
            throw new Error('plugin_egress_credential_invalid');
          }
          jsonBody[credential.injection_name] = plaintext;
          continue;
        }
        if (jsonBody || contentType(headers) !== 'application/x-www-form-urlencoded') {
          throw new Error('plugin_egress_credential_invalid');
        }
        formBody ??= new URLSearchParams(decodeBody(body));
        if (formBody.has(credential.injection_name)) {
          throw new Error('plugin_egress_credential_invalid');
        }
        formBody.set(credential.injection_name, plaintext);
      }
      if (jsonBody) body = encodeBoundedBody(JSON.stringify(jsonBody));
      if (formBody) body = encodeBoundedBody(formBody.toString());
      if (credentialsResult.results.length > 0) {
        await this.markCredentialsInjected(session, auditId, now);
      }
    } catch {
      await this.finishAudit(session, auditId, 'configuration_failure', now);
      throw new Error('plugin_egress_configuration_failed');
    }
    let response: Response;
    try {
      const outboundSignal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      ]);
      response = await this.fetcher(
        new Request(destination, {
          method: request.method,
          headers,
          body,
          signal: outboundSignal,
          redirect: 'manual',
        })
      );
    } catch {
      await this.finishAudit(session, auditId, 'network_failure', now);
      throw new Error('plugin_egress_transient_failure');
    }
    let responseBody: ArrayBuffer;
    try {
      responseBody = await readBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        'plugin_egress_response_too_large'
      );
    } catch (error) {
      const tooLarge =
        error instanceof Error && error.message === 'plugin_egress_response_too_large';
      await this.finishAudit(
        session,
        auditId,
        tooLarge ? 'response_too_large' : 'network_failure',
        now
      );
      throw new Error(
        tooLarge ? 'plugin_egress_response_too_large' : 'plugin_egress_transient_failure'
      );
    }
    await this.finishAudit(session, auditId, `http_${response.status}`, now);
    const responseHeaders = new Headers(response.headers);
    for (const name of [
      'connection',
      'content-length',
      'set-cookie',
      'set-cookie2',
      'transfer-encoding',
    ]) {
      responseHeaders.delete(name);
    }
    const responseBodyOrNull =
      response.status === 204 || response.status === 205 || response.status === 304
        ? null
        : responseBody;
    return new Response(responseBodyOrNull, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  private async consumeRateLimit(input: {
    session: D1DatabaseSession;
    invocation: PluginEgressContext;
    destinationHost: string;
    limit: number;
    now: number;
  }): Promise<boolean> {
    const windowStartedAt = Math.floor(input.now / 60) * 60;
    const result = await input.session
      .prepare(
        `INSERT INTO plugin_runner_rate_limit_buckets (
           installation_id, tenant_id, capability, destination_host,
           window_started_at, used_count, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(installation_id, tenant_id, capability, destination_host) DO UPDATE SET
           window_started_at = CASE
             WHEN plugin_runner_rate_limit_buckets.window_started_at = excluded.window_started_at
               THEN plugin_runner_rate_limit_buckets.window_started_at
             ELSE excluded.window_started_at
           END,
           used_count = CASE
             WHEN plugin_runner_rate_limit_buckets.window_started_at = excluded.window_started_at
               THEN plugin_runner_rate_limit_buckets.used_count + 1
             ELSE 1
           END,
           updated_at = excluded.updated_at
         WHERE plugin_runner_rate_limit_buckets.window_started_at <> excluded.window_started_at
            OR plugin_runner_rate_limit_buckets.used_count < ?`
      )
      .bind(
        input.invocation.pluginInstallationId,
        input.invocation.tenantId,
        input.invocation.capability,
        input.destinationHost,
        windowStartedAt,
        input.now,
        input.limit
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  private async markCredentialsInjected(
    session: D1DatabaseSession,
    auditId: string,
    now: number
  ): Promise<void> {
    const result = await session
      .prepare(
        `UPDATE plugin_runner_egress_audit
            SET credential_injected = 1, updated_at = ?
          WHERE audit_id = ? AND result_code = 'attempted' AND credential_injected = 0`
      )
      .bind(now, auditId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_egress_audit_update_failed');
  }

  private async insertAudit(input: {
    session: D1DatabaseSession;
    auditId: string;
    invocation: PluginEgressContext;
    destinationHost: string;
    credentialInjected: boolean;
    resultCode: string;
    now: number;
  }): Promise<void> {
    if (!SAFE_RESULT.test(input.resultCode)) throw new Error('plugin_egress_result_invalid');
    const result = await input.session
      .prepare(
        `INSERT INTO plugin_runner_egress_audit (
           audit_id, installation_id, tenant_id, request_id, capability,
           destination_host, credential_injected, result_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.auditId,
        input.invocation.pluginInstallationId,
        input.invocation.tenantId,
        input.invocation.requestId,
        input.invocation.capability,
        input.destinationHost,
        input.credentialInjected ? 1 : 0,
        input.resultCode,
        input.now,
        input.now
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_egress_audit_failed');
  }

  private async finishAudit(
    session: D1DatabaseSession,
    auditId: string,
    resultCode: string,
    now: number
  ): Promise<void> {
    if (!SAFE_RESULT.test(resultCode)) throw new Error('plugin_egress_result_invalid');
    const result = await session
      .prepare(
        `UPDATE plugin_runner_egress_audit SET result_code = ?, updated_at = ?
          WHERE audit_id = ? AND result_code = 'attempted'`
      )
      .bind(resultCode, now, auditId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('plugin_egress_audit_finish_failed');
  }
}
