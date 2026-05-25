import { readFile } from 'node:fs/promises';
import { parseConfig, type AuthrimConfig } from './config.js';
import { resolveIssuerUrl, resolveSharedLoginUiBaseUrl } from './url-config.js';
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
  path?: string;
  resolveUrl?: (baseUrl: string, config: AuthrimConfig) => string;
  expectedStatuses?: number[];
  requireJson?: boolean;
  validate?: (payload: unknown, baseUrl: string, config: AuthrimConfig) => string[];
  validateResponse?: (
    response: Awaited<ReturnType<typeof fetchJsonWithTimeout>>,
    baseUrl: string,
    config: AuthrimConfig
  ) => string[];
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

export function buildApiSmokeLoginProtocolBaseUrl(config: AuthrimConfig, baseUrl: string): string {
  if (config.tenant.multiTenant || config.urls?.loginUi?.sameAsApi === true) {
    return baseUrl;
  }
  return resolveSharedLoginUiBaseUrl(config, { env: config.environment.prefix });
}

export function validateRouterHealthPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload is not an object'];
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
    return ['payload is not an object'];
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
    return ['payload is not an object'];
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
    failures.push('response_types_supported is not an array');
  }
  if (!Array.isArray(payload.grant_types_supported)) {
    failures.push('grant_types_supported is not an array');
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
    return ['payload is not an object'];
  }
  const { keys } = payload;
  if (!Array.isArray(keys)) {
    return ['keys is not an array'];
  }
  if (keys.length === 0) {
    return ['keys is empty'];
  }
  const firstKey = keys[0];
  if (!isRecord(firstKey)) {
    return ['keys[0] is not an object'];
  }
  const failures: string[] = [];
  if (typeof firstKey.kid !== 'string' || !firstKey.kid) {
    failures.push('keys[0].kid is missing');
  }
  if (typeof firstKey.kty !== 'string' || !firstKey.kty) {
    failures.push('keys[0].kty is missing');
  }
  return failures;
}

export function validateLoginMethodsPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload is not an object'];
  }
  const failures: string[] = [];
  const methods = payload.methods;
  const ui = payload.ui;
  const meta = payload.meta;

  if (!isRecord(methods)) {
    failures.push('methods is not an object');
  } else {
    if (!isRecord(methods.passkey) || typeof methods.passkey.enabled !== 'boolean') {
      failures.push('methods.passkey.enabled is invalid');
    }
    if (!isRecord(methods.emailCode) || typeof methods.emailCode.enabled !== 'boolean') {
      failures.push('methods.emailCode.enabled is invalid');
    }
    if (!isRecord(methods.external) || !Array.isArray(methods.external.providers)) {
      failures.push('methods.external.providers is invalid');
    }
  }

  if (!isRecord(ui)) {
    failures.push('ui is not an object');
  } else {
    if (!isRecord(ui.branding) || typeof ui.branding.brandName !== 'string') {
      failures.push('ui.branding.brandName is invalid');
    }
    if (!Array.isArray(ui.supportedLocales)) {
      failures.push('ui.supportedLocales is not an array');
    }
  }

  if (!isRecord(meta) || typeof meta.cacheTTL !== 'number') {
    failures.push('meta.cacheTTL is invalid');
  }

  return failures;
}

export function validateInvalidRequestPayload(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return ['payload is not an object'];
  }
  const failures: string[] = [];
  if (payload.error !== 'invalid_request') {
    failures.push(`error expected=invalid_request actual=${String(payload.error)}`);
  }
  if (typeof payload.error_description !== 'string' || payload.error_description.length === 0) {
    failures.push('error_description is missing');
  }
  return failures;
}

export function validateAuthorizeInvalidRequestResponse(
  response: Awaited<ReturnType<typeof fetchJsonWithTimeout>>
): string[] {
  const bodyText = response.bodyText ?? '';
  const failures: string[] = [];
  if (!bodyText.includes('invalid_request')) {
    failures.push('body does not include invalid_request');
  }
  if (!bodyText.includes('response_type is required')) {
    failures.push('body does not include response_type is required');
  }
  if (bodyText.includes('Authrim Router Worker')) {
    failures.push('request was handled by router 404 instead of OP_AUTH');
  }
  return failures;
}

function buildBrowserOidcTargets(config: AuthrimConfig): ApiSmokeTarget[] {
  const targets: ApiSmokeTarget[] = [
    {
      id: 'oidc-authorize-invalid-request',
      title: 'OIDC authorize endpoint reaches OP_AUTH',
      path: '/authorize',
      expectedStatuses: [400],
      requireJson: false,
      validateResponse: (response) => validateAuthorizeInvalidRequestResponse(response),
    },
    {
      id: 'oidc-login-challenge-invalid-request',
      title: 'OIDC login challenge endpoint reaches OP_AUTH',
      path: '/auth/login-challenge?challenge_id=authrim-validation-missing',
      expectedStatuses: [400],
      validate: (payload) => validateInvalidRequestPayload(payload),
    },
  ];

  if (config.components.loginUi) {
    targets.push(
      {
        id: 'login-ui-oidc-authorize-proxy',
        title: 'Login UI OIDC authorize proxy reaches OP_AUTH',
        resolveUrl: (baseUrl, currentConfig) =>
          `${buildApiSmokeLoginProtocolBaseUrl(currentConfig, baseUrl)}/authorize`,
        expectedStatuses: [400],
        requireJson: false,
        validateResponse: (response) => validateAuthorizeInvalidRequestResponse(response),
      },
      {
        id: 'login-ui-oidc-login-challenge-proxy',
        title: 'Login UI OIDC login challenge proxy reaches OP_AUTH',
        resolveUrl: (baseUrl, currentConfig) =>
          `${buildApiSmokeLoginProtocolBaseUrl(
            currentConfig,
            baseUrl
          )}/auth/login-challenge?challenge_id=authrim-validation-missing`,
        expectedStatuses: [400],
        validate: (payload) => validateInvalidRequestPayload(payload),
      }
    );
  }

  return targets;
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
    ...buildBrowserOidcTargets(config),
  ];
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number
): Promise<{
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
    const url = targetCheck.resolveUrl
      ? targetCheck.resolveUrl(baseUrl, config)
      : `${baseUrl}${targetCheck.path}`;
    const check = makeCheck(targetCheck, url);
    const response = await fetchJsonWithTimeout(url, timeoutMs);
    check.httpStatus = response.status;
    const expectedStatuses = targetCheck.expectedStatuses ?? [];

    if (expectedStatuses.length > 0 && !expectedStatuses.includes(response.status)) {
      fail(check, `HTTP status expected=${expectedStatuses.join('|')} actual=${response.status}`);
      if (response.bodyText) {
        fail(check, response.bodyText.slice(0, 400));
      }
      checks.push(check);
      continue;
    }

    if (expectedStatuses.length === 0 && !response.ok) {
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

    if (targetCheck.validateResponse) {
      const failures = targetCheck.validateResponse(response, baseUrl, config);
      if (failures.length > 0) {
        for (const message of failures) {
          fail(check, message);
        }
        checks.push(check);
        continue;
      }
    }

    if (targetCheck.requireJson !== false && !response.contentType?.includes('application/json')) {
      fail(
        check,
        `content-type expected=application/json actual=${response.contentType ?? '(missing)'}`
      );
      checks.push(check);
      continue;
    }

    if (targetCheck.validate) {
      const failures = targetCheck.validate(response.payload, baseUrl, config);
      if (failures.length > 0) {
        for (const message of failures) {
          fail(check, message);
        }
        checks.push(check);
        continue;
      }
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
