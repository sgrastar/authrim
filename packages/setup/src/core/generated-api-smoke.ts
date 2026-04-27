import { readFile } from 'node:fs/promises';
import { parseConfig, type AuthrimConfig } from './config.js';
import { resolveIssuerUrl } from './url-config.js';
import { resolveGeneratedEnvValidationTarget } from './generated-env-validator.js';

type CheckStatus = 'pass' | 'fail';

export interface ApiSmokeCheck {
  id: string;
  title: string;
  url: string;
  status: CheckStatus;
  details: string[];
  httpStatus?: number;
}

export interface GeneratedApiSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  checks: ApiSmokeCheck[];
}

export interface GeneratedApiSmokeOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  timeoutMs?: number;
}

interface ApiSmokeTarget {
  id: string;
  title: string;
  path: string;
  validate: (payload: unknown, baseUrl: string, config: AuthrimConfig) => string[];
}

function makeCheck(target: ApiSmokeTarget, url: string): ApiSmokeCheck {
  return {
    id: target.id,
    title: target.title,
    url,
    status: 'pass',
    details: [],
  };
}

function fail(check: ApiSmokeCheck, detail: string): void {
  check.status = 'fail';
  check.details.push(detail);
}

function pass(check: ApiSmokeCheck, detail: string): void {
  check.details.push(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildApiSmokeBaseUrl(config: AuthrimConfig): string {
  return resolveIssuerUrl(config, { env: config.environment.prefix });
}

export function validateRouterHealthPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload が object ではありません'];
  }
  const failures: string[] = [];
  if (payload.status !== 'ok') {
    failures.push(`status expected=ok actual=${String(payload.status)}`);
  }
  if (payload.service !== 'authrim-router') {
    failures.push(`service expected=authrim-router actual=${String(payload.service)}`);
  }
  return failures;
}

export function validateAuthHealthPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload が object ではありません'];
  }
  const failures: string[] = [];
  if (payload.status !== 'ok') {
    failures.push(`status expected=ok actual=${String(payload.status)}`);
  }
  if (payload.service !== 'ar-auth') {
    failures.push(`service expected=ar-auth actual=${String(payload.service)}`);
  }
  return failures;
}

export function validateDiscoveryPayload(
  payload: unknown,
  baseUrl: string,
  config: AuthrimConfig
): string[] {
  if (!isRecord(payload)) {
    return ['payload が object ではありません'];
  }
  const failures: string[] = [];

  const expectedFields: Array<[string, string]> = [
    ['issuer', baseUrl],
    ['authorization_endpoint', `${baseUrl}/authorize`],
    ['token_endpoint', `${baseUrl}/token`],
    ['userinfo_endpoint', `${baseUrl}/userinfo`],
    ['jwks_uri', `${baseUrl}/.well-known/jwks.json`],
    ['registration_endpoint', `${baseUrl}/register`],
  ];

  for (const [field, expected] of expectedFields) {
    if (payload[field] !== expected) {
      failures.push(`${field} expected=${expected} actual=${String(payload[field])}`);
    }
  }

  if (!Array.isArray(payload.response_types_supported)) {
    failures.push('response_types_supported が配列ではありません');
  }
  if (!Array.isArray(payload.grant_types_supported)) {
    failures.push('grant_types_supported が配列ではありません');
  }
  if (config.components.async) {
    if (payload.device_authorization_endpoint !== `${baseUrl}/device_authorization`) {
      failures.push(
        `device_authorization_endpoint expected=${baseUrl}/device_authorization actual=${String(payload.device_authorization_endpoint)}`
      );
    }
    if (payload.backchannel_authentication_endpoint !== `${baseUrl}/bc-authorize`) {
      failures.push(
        `backchannel_authentication_endpoint expected=${baseUrl}/bc-authorize actual=${String(payload.backchannel_authentication_endpoint)}`
      );
    }
  }

  return failures;
}

export function validateJwksPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload が object ではありません'];
  }
  const { keys } = payload;
  if (!Array.isArray(keys)) {
    return ['keys が配列ではありません'];
  }
  if (keys.length === 0) {
    return ['keys が空です'];
  }
  const firstKey = keys[0];
  if (!isRecord(firstKey)) {
    return ['keys[0] が object ではありません'];
  }
  const failures: string[] = [];
  if (typeof firstKey.kid !== 'string' || !firstKey.kid) {
    failures.push('keys[0].kid がありません');
  }
  if (typeof firstKey.kty !== 'string' || !firstKey.kty) {
    failures.push('keys[0].kty がありません');
  }
  return failures;
}

export function validateLoginMethodsPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload が object ではありません'];
  }
  const failures: string[] = [];
  const methods = payload.methods;
  const ui = payload.ui;
  const meta = payload.meta;

  if (!isRecord(methods)) {
    failures.push('methods が object ではありません');
  } else {
    if (!isRecord(methods.passkey) || typeof methods.passkey.enabled !== 'boolean') {
      failures.push('methods.passkey.enabled が不正です');
    }
    if (!isRecord(methods.emailCode) || typeof methods.emailCode.enabled !== 'boolean') {
      failures.push('methods.emailCode.enabled が不正です');
    }
    if (!isRecord(methods.social) || !Array.isArray(methods.social.providers)) {
      failures.push('methods.social.providers が不正です');
    }
  }

  if (!isRecord(ui)) {
    failures.push('ui が object ではありません');
  } else {
    if (!isRecord(ui.branding) || typeof ui.branding.brandName !== 'string') {
      failures.push('ui.branding.brandName が不正です');
    }
    if (!Array.isArray(ui.supportedLocales)) {
      failures.push('ui.supportedLocales が配列ではありません');
    }
  }

  if (!isRecord(meta) || typeof meta.cacheTTL !== 'number') {
    failures.push('meta.cacheTTL が不正です');
  }

  return failures;
}

export function buildApiSmokeTargets(config: AuthrimConfig): ApiSmokeTarget[] {
  return [
    {
      id: 'router-health',
      title: 'router health endpoint',
      path: '/api/health',
      validate: (payload) => validateRouterHealthPayload(payload),
    },
    {
      id: 'oidc-discovery',
      title: 'OIDC discovery endpoint',
      path: '/.well-known/openid-configuration',
      validate: (payload, baseUrl, currentConfig) =>
        validateDiscoveryPayload(payload, baseUrl, currentConfig),
    },
    {
      id: 'jwks',
      title: 'JWKS endpoint',
      path: '/.well-known/jwks.json',
      validate: (payload) => validateJwksPayload(payload),
    },
    {
      id: 'auth-health',
      title: 'auth health endpoint',
      path: '/api/auth/health',
      validate: (payload) => validateAuthHealthPayload(payload),
    },
    {
      id: 'login-methods',
      title: 'login methods endpoint',
      path: '/api/auth/login-methods',
      validate: (payload) => validateLoginMethodsPayload(payload),
    },
  ];
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<{
  ok: boolean;
  status: number;
  contentType: string | null;
  payload?: unknown;
  bodyText?: string;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const contentType = response.headers.get('content-type');
    const bodyText = await response.text();
    let payload: unknown;
    if (contentType?.includes('application/json')) {
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        return {
          ok: false,
          status: response.status,
          contentType,
          bodyText,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      payload,
      bodyText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConfig(configPath: string): Promise<AuthrimConfig> {
  return parseConfig(JSON.parse(await readFile(configPath, 'utf-8')));
}

export async function runGeneratedApiSmoke(
  options: GeneratedApiSmokeOptions
): Promise<GeneratedApiSmokeResult> {
  const target = resolveGeneratedEnvValidationTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
  });
  const config = await loadConfig(target.configPath);
  const baseUrl = buildApiSmokeBaseUrl(config);
  const checks: ApiSmokeCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;

  for (const targetCheck of buildApiSmokeTargets(config)) {
    const url = `${baseUrl}${targetCheck.path}`;
    const check = makeCheck(targetCheck, url);
    const response = await fetchJsonWithTimeout(url, timeoutMs);
    check.httpStatus = response.status;

    if (!response.ok) {
      fail(
        check,
        response.status > 0
          ? `HTTP ${response.status}${response.error ? `: ${response.error}` : ''}`
          : `request failed: ${response.error ?? 'unknown error'}`
      );
      if (response.bodyText) {
        fail(check, response.bodyText.slice(0, 400));
      }
      checks.push(check);
      continue;
    }

    if (!response.contentType?.includes('application/json')) {
      fail(check, `content-type expected=application/json actual=${response.contentType ?? '(missing)'}`);
      checks.push(check);
      continue;
    }

    const failures = targetCheck.validate(response.payload, baseUrl, config);
    if (failures.length > 0) {
      for (const message of failures) {
        fail(check, message);
      }
      checks.push(check);
      continue;
    }

    pass(check, `HTTP ${response.status}`);
    checks.push(check);
  }

  return {
    ok: checks.every((check) => check.status === 'pass'),
    env: target.env,
    baseUrl,
    configPath: target.configPath,
    checks,
  };
}
