import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig, type AuthrimConfig } from './config.js';
import { resolveGeneratedEnvValidationTarget } from './generated-env-validator.js';
import { findKeysDirectory } from './paths.js';
import { resolveIssuerUrl } from './url-config.js';

export type SmokeCheckStatus = 'pass' | 'warn' | 'fail';

export interface SmokeCheck {
  id: string;
  title: string;
  status: SmokeCheckStatus;
  details: string[];
  httpStatus?: number;
  url?: string;
}

export interface GeneratedSmokeOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  timeoutMs?: number;
}

export interface ResolvedGeneratedSmokeTarget {
  env: string;
  baseDir: string;
  configPath: string;
  baseUrl: string;
  config: AuthrimConfig;
  tenantId: string;
}

export interface HttpResponseSnapshot {
  ok: boolean;
  status: number;
  contentType: string | null;
  payload?: unknown;
  bodyText?: string;
  error?: string;
}

export interface RegisteredSmokeClient {
  clientId: string;
  clientSecret: string;
  registrationAccessToken: string;
  registrationClientUri: string;
  redirectUri: string;
  clientName: string;
}

export interface TemporaryInitialAccessToken {
  token: string;
  tokenHash: string;
}

export interface TenantDcrSettingsSnapshot {
  version: string;
  values: Record<string, unknown>;
  sources: Record<string, string>;
}

export interface TemporaryDcrEnableState {
  changed: boolean;
  originalSource: string;
}

export interface RegisterSmokeClientOptions {
  baseUrl: string;
  timeoutMs: number;
  tenantId?: string;
  initialAccessToken?: string;
  redirectUri?: string;
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  clientCredentialsAllowed?: boolean;
  allowedScopes?: string[];
  defaultScope?: string;
  defaultAudience?: string;
  clientNamePrefix?: string;
}

export interface SmokeClientRegistrationDefaults {
  grantTypes: string[];
  responseTypes: string[];
  supportsClientCredentials: boolean;
}

export function makeSmokeCheck(id: string, title: string, url?: string): SmokeCheck {
  return {
    id,
    title,
    status: 'pass',
    details: [],
    url,
  };
}

export function addPass(check: SmokeCheck, detail: string): void {
  check.details.push(detail);
}

export function addWarn(check: SmokeCheck, detail: string): void {
  check.status = check.status === 'fail' ? 'fail' : 'warn';
  check.details.push(detail);
}

export function addFail(check: SmokeCheck, detail: string): void {
  check.status = 'fail';
  check.details.push(detail);
}

export function finalizeCheck(check: SmokeCheck, fallbackDetail: string): SmokeCheck {
  if (check.details.length === 0) {
    check.details.push(fallbackDetail);
  }
  return check;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSmokeSuccessful(checks: SmokeCheck[]): boolean {
  return checks.every((check) => check.status !== 'fail');
}

export async function resolveGeneratedSmokeTarget(
  options: GeneratedSmokeOptions
): Promise<ResolvedGeneratedSmokeTarget> {
  const target = resolveGeneratedEnvValidationTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
  });
  const config = parseConfig(JSON.parse(await readFile(target.configPath, 'utf-8')));
  return {
    env: target.env,
    baseDir: target.baseDir,
    configPath: target.configPath,
    baseUrl: resolveIssuerUrl(config, { env: target.env }),
    config,
    tenantId: config.tenant.name,
  };
}

export function resolveSmokeClientRegistrationDefaults(
  config: AuthrimConfig
): SmokeClientRegistrationDefaults {
  const grantTypes =
    config.oidc.grantTypes.filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    ) || [];
  const responseTypes =
    config.oidc.responseTypes.filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    ) || [];

  return {
    grantTypes: grantTypes.length > 0 ? grantTypes : ['authorization_code', 'refresh_token'],
    responseTypes: responseTypes.length > 0 ? responseTypes : ['code'],
    supportsClientCredentials: grantTypes.includes('client_credentials'),
  };
}

export function withTenantHeader(
  headers: Record<string, string>,
  tenantId?: string
): Record<string, string> {
  return tenantId ? { ...headers, 'X-Tenant-Id': tenantId } : headers;
}

export async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  init?: globalThis.RequestInit
): Promise<HttpResponseSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
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

export async function readGeneratedAdminApiSecret(options: {
  baseDir: string;
  env: string;
  adminSecret?: string;
  adminSecretPath?: string;
}): Promise<{ secret: string; path: string }> {
  if (options.adminSecret && options.adminSecret.trim()) {
    return { secret: options.adminSecret.trim(), path: '(inline)' };
  }

  const explicitPath =
    options.adminSecretPath ||
    findKeysDirectory({
      env: options.env,
      sourceDir: options.baseDir,
      keysBaseDir: options.baseDir,
    })?.path;

  if (!explicitPath) {
    throw new Error('admin_api_secret_not_found');
  }

  const secretPath = options.adminSecretPath || join(explicitPath, 'admin_api_secret.txt');
  const secret = (await readFile(secretPath, 'utf-8')).trim();
  if (!secret) {
    throw new Error(`admin_api_secret_empty:${secretPath}`);
  }

  return { secret, path: secretPath };
}

function getAdminJsonHeaders(secret: string, tenantId?: string): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    tenantId
  );
}

export async function getTenantDcrSettings(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
}): Promise<TenantDcrSettingsSnapshot> {
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/tenants/${encodeURIComponent(options.tenantId)}/settings/dcr`,
    options.timeoutMs,
    {
      method: 'GET',
      headers: getAdminJsonHeaders(options.adminSecret, options.tenantId),
    }
  );

  if (!response.ok || !isRecord(response.payload)) {
    throw new Error(
      `smoke_dcr_settings_get_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }

  const version = typeof response.payload.version === 'string' ? response.payload.version : '';
  const values = isRecord(response.payload.values) ? response.payload.values : null;
  const sources = isRecord(response.payload.sources) ? response.payload.sources : null;

  if (!version || !values || !sources) {
    throw new Error('smoke_dcr_settings_get_response_invalid');
  }

  return {
    version,
    values,
    sources: Object.fromEntries(
      Object.entries(sources).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : 'unknown',
      ])
    ),
  };
}

export async function patchTenantDcrSettings(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  ifMatch: string;
  set?: Record<string, unknown>;
  clear?: string[];
}): Promise<{ version: string; applied: string[]; rejected: Record<string, string> }> {
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/tenants/${encodeURIComponent(options.tenantId)}/settings/dcr`,
    options.timeoutMs,
    {
      method: 'PATCH',
      headers: getAdminJsonHeaders(options.adminSecret, options.tenantId),
      body: JSON.stringify({
        ifMatch: options.ifMatch,
        ...(options.set ? { set: options.set } : {}),
        ...(options.clear ? { clear: options.clear } : {}),
      }),
    }
  );

  if (!response.ok || !isRecord(response.payload)) {
    throw new Error(
      `smoke_dcr_settings_patch_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }

  const version = typeof response.payload.version === 'string' ? response.payload.version : '';
  const applied = Array.isArray(response.payload.applied)
    ? response.payload.applied.filter((value): value is string => typeof value === 'string')
    : [];
  const rejected = isRecord(response.payload.rejected)
    ? Object.fromEntries(
        Object.entries(response.payload.rejected).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : String(value),
        ])
      )
    : {};

  if (!version) {
    throw new Error('smoke_dcr_settings_patch_response_invalid');
  }

  return { version, applied, rejected };
}

export async function ensureTemporaryDcrEnabled(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
}): Promise<TemporaryDcrEnableState> {
  const snapshot = await getTenantDcrSettings(options);
  const enabled = snapshot.values['dcr.enabled'] === true;
  const originalSource = snapshot.sources['dcr.enabled'] ?? 'unknown';

  if (enabled) {
    return { changed: false, originalSource };
  }

  if (originalSource === 'env') {
    throw new Error('smoke_dcr_settings_env_locked');
  }

  const patch = await patchTenantDcrSettings({
    ...options,
    ifMatch: snapshot.version,
    set: { 'dcr.enabled': true },
  });

  if (!patch.applied.includes('dcr.enabled')) {
    const rejection = patch.rejected['dcr.enabled'];
    throw new Error(`smoke_dcr_settings_enable_rejected:${rejection ?? 'not_applied'}`);
  }

  return { changed: true, originalSource };
}

export async function restoreTemporaryDcrEnabled(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  state: TemporaryDcrEnableState;
}): Promise<HttpResponseSnapshot> {
  if (!options.state.changed) {
    return {
      ok: true,
      status: 200,
      contentType: 'application/json',
      payload: { skipped: true },
    };
  }

  const snapshot = await getTenantDcrSettings(options);
  await patchTenantDcrSettings({
    ...options,
    ifMatch: snapshot.version,
    ...(options.state.originalSource === 'kv'
      ? { set: { 'dcr.enabled': false } }
      : { clear: ['dcr.enabled'] }),
  });

  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    payload: { restored: true },
  };
}

export async function createTemporaryInitialAccessToken(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId?: string;
  description?: string;
}): Promise<TemporaryInitialAccessToken> {
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/iat-tokens`,
    options.timeoutMs,
    {
      method: 'POST',
      headers: withTenantHeader(
        {
          authorization: `Bearer ${options.adminSecret}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        options.tenantId
      ),
      body: JSON.stringify({
        description: options.description ?? `Portability Smoke IAT ${Date.now()}`,
        expiresInDays: 1,
        single_use: true,
      }),
    }
  );

  if (!response.ok || !isRecord(response.payload)) {
    throw new Error(
      `smoke_iat_create_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }

  const token = typeof response.payload.token === 'string' ? response.payload.token : '';
  const tokenHash =
    typeof response.payload.tokenHash === 'string' ? response.payload.tokenHash : '';

  if (!token || !tokenHash) {
    throw new Error('smoke_iat_create_response_invalid');
  }

  return { token, tokenHash };
}

export async function revokeTemporaryInitialAccessToken(options: {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tokenHash: string;
  tenantId?: string;
}): Promise<HttpResponseSnapshot> {
  return fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/iat-tokens/${encodeURIComponent(options.tokenHash)}`,
    options.timeoutMs,
    {
      method: 'DELETE',
      headers: withTenantHeader(
        {
          authorization: `Bearer ${options.adminSecret}`,
          accept: 'application/json',
        },
        options.tenantId
      ),
    }
  );
}

export async function registerTemporarySmokeClient(
  options: RegisterSmokeClientOptions
): Promise<RegisteredSmokeClient> {
  const redirectUri = options.redirectUri ?? 'https://portability-smoke.example.invalid/callback';
  const clientName = `${options.clientNamePrefix ?? 'Portability Smoke Client'} ${Date.now()}`;
  const response = await fetchJsonWithTimeout(`${options.baseUrl}/register`, options.timeoutMs, {
    method: 'POST',
    headers: withTenantHeader(
      {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(options.initialAccessToken
          ? { authorization: `Bearer ${options.initialAccessToken}` }
          : {}),
      },
      options.tenantId
    ),
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: options.grantTypes ?? [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ],
      response_types: options.responseTypes ?? ['code'],
      token_endpoint_auth_method: options.tokenEndpointAuthMethod ?? 'client_secret_basic',
      client_credentials_allowed: options.clientCredentialsAllowed ?? true,
      allowed_scopes: options.allowedScopes ?? ['openid'],
      default_scope: options.defaultScope ?? 'openid',
      default_audience: options.defaultAudience ?? `${options.baseUrl}/resource/smoke`,
    }),
  });

  if (!response.ok || !isRecord(response.payload)) {
    throw new Error(
      `smoke_client_register_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }

  const payload = response.payload;
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  const clientSecret = typeof payload.client_secret === 'string' ? payload.client_secret : '';
  const registrationAccessToken =
    typeof payload.registration_access_token === 'string' ? payload.registration_access_token : '';
  const registrationClientUri =
    typeof payload.registration_client_uri === 'string' ? payload.registration_client_uri : '';

  if (!clientId || !clientSecret || !registrationAccessToken || !registrationClientUri) {
    throw new Error('smoke_client_register_response_invalid');
  }

  return {
    clientId,
    clientSecret,
    registrationAccessToken,
    registrationClientUri,
    redirectUri,
    clientName,
  };
}

export async function deleteTemporarySmokeClient(
  client: RegisteredSmokeClient,
  timeoutMs: number
): Promise<HttpResponseSnapshot> {
  return fetchJsonWithTimeout(client.registrationClientUri, timeoutMs, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${client.registrationAccessToken}`,
      accept: 'application/json',
    },
  });
}
