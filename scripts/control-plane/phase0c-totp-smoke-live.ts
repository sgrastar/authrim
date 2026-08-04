#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateTotpCode,
  getTotpTimeStep,
  type TotpProfile,
} from '../../packages/ar-lib-core/src/utils/totp.js';
import {
  buildSetupMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  ensureSetupMachineKeyFiles,
  loadSetupMachinePublicJwk,
  requestAdminMachineAccessToken,
} from '../../packages/setup/src/core/admin-machine-access.js';
import { executeD1Command } from '../../packages/setup/src/core/cloudflare.js';
import {
  findPhase0cClientIdsByExactName,
  findPhase0cUserIdByExactEmail,
  hasExactPhase0cScope,
  phase0cAdminJson,
  readPhase0cJson,
  strictPhase0cAdminDatabaseName,
  strictPhase0cLiveConfig,
} from './phase0c-mail-otp-live.js';
import { resolvePhase0cTenantApiBaseUrl } from './phase0c-live-url.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_CONFIG_PATH = resolve(REPO_ROOT, '.authrim/test/config.json');
const TEST_LOCK_PATH = resolve(REPO_ROOT, '.authrim/test/lock.json');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const RUN_ID_PATTERN = /^phase0c-totp-[0-9]{14}-[a-f0-9]{6}$/u;
const RESULT_PATH_PATTERN = /^\/(?:private\/)?tmp\/[^\0]+\.json$/u;
const TOTP_SETTING_KEYS = [
  'authentication-methods.totp.login_enabled',
  'authentication-methods.totp.signup_enabled',
  'authentication-methods.totp.preset',
  'authentication-methods.human_verification.signup_enabled',
] as const;
const MACHINE_PERMISSIONS = [
  'admin:clients:*',
  'admin:users:*',
  'admin:security:write',
  'admin:settings:read',
  'admin:settings:write',
] as const;
const CLEANUP_ERROR_CODES = new Set([
  'machine_token_refresh_failed',
  'user_cleanup_failed',
  'user_reconciliation_lookup_failed',
  'user_reconciliation_delete_failed',
  'user_absence_check_timeout',
  'user_absence_check_request_failed',
  'client_reconciliation_failed',
  'client_cleanup_failed',
  'settings_cleanup_failed',
  'machine_principal_cleanup_failed',
]);
const TOTP_EXECUTION_STAGES = [
  'machine_bootstrap',
  'machine_token',
  'settings_read',
  'settings_patch',
  'settings_wait',
  'client_create',
  'client_settings_read',
  'client_settings_patch',
  'trust_policy_upsert',
  'user_create',
  'full_login',
] as const;
const PHASE0C_AUTH_TIMING_NAMES = new Set([
  'auth_redirect_https',
  'auth_request_context',
  'auth_body_limit',
  'auth_diagnostic_logging',
  'auth_secure_headers',
  'auth_cors',
  'auth_csrf',
  'auth_rate_limit_profile',
  'auth_rate_limit',
  'auth_authorize_client',
  'auth_authorize_tenant_profile',
  'auth_authorize_security_settings',
  'auth_authorize_sso_settings',
  'auth_authorize_session_read',
  'auth_authorize_account_route',
  'auth_authorize_trust_policy',
  'auth_authorize_consent_lookup',
  'auth_authorize_consent_grant',
  'auth_authorize_consent_management_config',
  'auth_authorize_consent_user_claims',
  'auth_authorize_consent_requirements',
  'auth_authorize_consent_satisfaction',
  'auth_authorize_code_shard_config',
  'auth_authorize_code_store',
  'auth_totp_usage_policy',
  'auth_totp_account_route',
  'auth_totp_user_lookup',
  'auth_totp_credential_lookup',
  'auth_totp_challenge_store',
  'auth_totp_challenge_consume',
  'auth_totp_identity_read',
  'auth_totp_session_create',
  'auth_handler_downstream',
  'auth_total',
]);

const PHASE0C_TOKEN_TIMING_NAMES = new Set([
  'token_logger',
  'token_request_context',
  'token_diagnostic_logging',
  'token_plugin_context',
  'token_secure_headers',
  'token_cors',
  'token_rate_limit_profile',
  'token_rate_limit',
  'token_client',
  'token_tenant_profile',
  'token_security_settings',
  'token_client_auth_policy',
  'token_client_secret_verify',
  'token_code_shard_config',
  'token_code_consume',
  'token_optional_features',
  'token_signing_key',
  'token_access_ttl',
  'token_account_route',
  'token_refresh_ttl',
  'token_subject_account',
  'token_rbac_config',
  'token_rbac_claims',
  'token_access_create',
  'token_custom_claim_schema',
  'token_identity_mapping',
  'token_attribute_consent',
  'token_id_create',
  'token_refresh_family',
  'token_refresh_create',
  'token_code_register',
  'token_handler_downstream',
  'token_total',
]);

export function isPhase0cAuthTimingName(value: string): boolean {
  return PHASE0C_AUTH_TIMING_NAMES.has(value);
}

export function isPhase0cTokenTimingName(value: string): boolean {
  return PHASE0C_TOKEN_TIMING_NAMES.has(value);
}
type TotpExecutionStage = (typeof TOTP_EXECUTION_STAGES)[number];

export interface Phase0cTotpSmokeOptions {
  environment: 'test';
  confirmTestData: true;
  resultPath: string;
}

export interface Phase0cTotpCategorySettings {
  category: string;
  version: string;
  values: Record<string, unknown>;
  sources: Record<string, 'env' | 'kv' | 'default'>;
}

interface TotpSignupOptions {
  challenge_id: string;
  secret: string;
  profile: TotpProfile;
}

interface TotpSignupResult {
  success: true;
  user: { id: string };
}

interface ProvisioningAccepted {
  status: 'provisioning';
  provisioning_token: string;
  status_endpoint: '/api/v1/auth/account-provisioning/status';
  retry_after_ms: number;
}

export interface Phase0cTotpFullLoginEvidence {
  success: true;
  latencyMs: {
    authorizeInit: number;
    totpStart: number;
    totpVerify: number;
    authorizeCode: number;
    token: number;
    totpCompletion: number;
    fullFlow: number;
  };
  diagnosticTimingMs?: {
    authorizeInit: Record<string, number>;
    totpStart: Record<string, number>;
    totpVerify: Record<string, number>;
    authorizeCode: Record<string, number>;
    token: Record<string, number>;
  };
}

interface SmokeEvidence extends Phase0cTotpFullLoginEvidence {
  schemaVersion: 1;
  runId: string;
  tenantId: string;
  scenario: 'production_totp_full_login_smoke';
  iterations: 1;
  authenticationBypass: false;
  testInbox: false;
  readReplication: 'disabled';
  cleanup: {
    user: 'absent';
    client: 'deleted';
    settings: 'restored';
    machinePrincipal: 'deleted';
  };
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function safeResultPath(value: string): string {
  const path = resolve(value);
  if (!RESULT_PATH_PATTERN.test(path)) {
    throw new Error('phase0c_totp_result_must_use_temporary_json_path');
  }
  return path;
}

export function parsePhase0cTotpSmokeArgs(argv: string[]): Phase0cTotpSmokeOptions {
  let environment: string | undefined;
  let resultPath: string | undefined;
  let confirmTestData = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--env') environment = argv[++index];
    else if (argument === '--result') resultPath = argv[++index];
    else if (argument === '--confirm-test-data') confirmTestData = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (environment !== 'test') throw new Error('phase0c_totp_test_environment_required');
  if (!confirmTestData) throw new Error('phase0c_totp_test_data_confirmation_required');
  if (!resultPath) throw new Error('phase0c_totp_result_path_required');
  return {
    environment: 'test',
    confirmTestData: true,
    resultPath: safeResultPath(resultPath),
  };
}

export function createPhase0cTotpRunId(now = new Date(), nonce = randomUUID()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14);
  const suffix = nonce
    .replace(/[^a-f0-9]/giu, '')
    .slice(0, 6)
    .toLowerCase();
  return `phase0c-totp-${timestamp}-${suffix}`;
}

export function phase0cTotpActivationTimeStep(now: number, profile: TotpProfile): number {
  const current = getTotpTimeStep(now, profile.period);
  return profile.window > 0 && current > 0 ? current - 1 : current;
}

export function phase0cTotpServerClockOffsetMs(
  serverDateHeader: string | null,
  localNow = Date.now()
): number {
  const serverNow = serverDateHeader ? Date.parse(serverDateHeader) : Number.NaN;
  return Number.isFinite(serverNow) ? serverNow - localNow : 0;
}

export function isPhase0cTotpEntrypoint(
  argv1: string | undefined,
  repositoryRoot = REPO_ROOT
): boolean {
  return (
    argv1 !== undefined &&
    resolve(argv1) === resolve(repositoryRoot, 'scripts/control-plane/phase0c-totp-smoke-live.ts')
  );
}

export function safePhase0cTotpExecutionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const authorizationRedirect =
    /^(phase0c_totp_authorization_code_missing):([a-z][a-z0-9_]{0,63}):(client|authrim|other)$/u.exec(
      message
    );
  if (authorizationRedirect) return authorizationRedirect[0];

  const direct = /^(phase0c_totp_[a-z0-9_]+)(?::(\d{3}))?$/u.exec(message);
  if (direct) return direct[2] ? `${direct[1]}:${direct[2]}` : direct[1];

  const publicRequest =
    /^phase0c_totp_public_request_failed:(\/api\/(?:auth\/totp\/(?:signup\/(?:options|activate)|login\/(?:start|verify))|v1\/auth\/account-provisioning\/status)):(\d{3})(?::(AR\d{6}|[a-z][a-z0-9_]{0,63}))?$/u.exec(
      message
    );
  if (publicRequest) {
    const errorCode = publicRequest[3] ? `:${publicRequest[3]}` : '';
    return `phase0c_totp_public_request_failed:${publicRequest[1]}:${publicRequest[2]}${errorCode}`;
  }

  const adminRequest =
    /^phase0c_mail_admin_request_failed:(GET|POST|PUT|PATCH|DELETE):[^:]+:(\d{3})(?::|$)/u.exec(
      message
    );
  if (adminRequest) {
    return `phase0c_totp_admin_request_failed:${adminRequest[1]}:${adminRequest[2]}`;
  }

  const cleanup = /^phase0c_totp_cleanup_incomplete:([a-z0-9_,]+)(?::(.+))?$/u.exec(message);
  if (cleanup) {
    const cleanupCodes = cleanup[1].split(',');
    if (cleanupCodes.every((code) => CLEANUP_ERROR_CODES.has(code))) {
      const execution = cleanup[2]
        ? `:${safePhase0cTotpExecutionError(new Error(cleanup[2]))}`
        : '';
      return `phase0c_totp_cleanup_incomplete:${cleanupCodes.join(',')}${execution}`;
    }
  }

  return 'phase0c_totp_execution_failed';
}

export function strictPhase0cTotpCategorySettings(value: unknown): Phase0cTotpCategorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('phase0c_totp_settings_response_invalid');
  }
  const settings = value as Partial<Phase0cTotpCategorySettings>;
  if (
    settings.category !== 'authentication-methods' ||
    typeof settings.version !== 'string' ||
    !settings.version ||
    !settings.values ||
    typeof settings.values !== 'object' ||
    Array.isArray(settings.values) ||
    !settings.sources ||
    typeof settings.sources !== 'object' ||
    Array.isArray(settings.sources)
  ) {
    throw new Error('phase0c_totp_settings_response_invalid');
  }
  for (const key of TOTP_SETTING_KEYS) {
    if (!['env', 'kv', 'default'].includes(String(settings.sources[key]))) {
      throw new Error('phase0c_totp_settings_source_invalid');
    }
  }
  return settings as Phase0cTotpCategorySettings;
}

function settingsMatchSmokeProfile(settings: Phase0cTotpCategorySettings): boolean {
  return (
    settings.values['authentication-methods.totp.login_enabled'] === true &&
    settings.values['authentication-methods.totp.signup_enabled'] === true &&
    settings.values['authentication-methods.totp.preset'] === 'compatible' &&
    settings.values['authentication-methods.human_verification.signup_enabled'] === false
  );
}

function settingsMatchSnapshot(
  original: Phase0cTotpCategorySettings,
  restored: Phase0cTotpCategorySettings
): boolean {
  return TOTP_SETTING_KEYS.every(
    (key) =>
      restored.sources[key] === original.sources[key] &&
      JSON.stringify(restored.values[key]) === JSON.stringify(original.values[key])
  );
}

export async function waitForPhase0cTotpSettings(input: {
  baseUrl: string;
  tenantId: string;
  token: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settings = strictPhase0cTotpCategorySettings(
      await phase0cAdminJson({
        baseUrl: input.baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(input.tenantId)}/settings/authentication-methods`,
        token: input.token,
        tenantId: input.tenantId,
      })
    );
    if (settingsMatchSmokeProfile(settings)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('phase0c_totp_settings_not_applied');
}

export async function waitForRestoredPhase0cTotpSettings(input: {
  baseUrl: string;
  tenantId: string;
  token: string;
  original: Phase0cTotpCategorySettings;
}): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settings = strictPhase0cTotpCategorySettings(
      await phase0cAdminJson({
        baseUrl: input.baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(input.tenantId)}/settings/authentication-methods`,
        token: input.token,
        tenantId: input.tenantId,
      })
    );
    if (settingsMatchSnapshot(input.original, settings)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('phase0c_totp_settings_restore_unverified');
}

export async function waitForPhase0cTotpUserAbsent(input: {
  baseUrl: string;
  tenantId: string;
  token: string;
  email: string;
}): Promise<void> {
  let successfulRead = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const found = await findPhase0cUserIdByExactEmail(input);
      successfulRead = true;
      if (!found) return;
    } catch {
      // A transient Admin read must not turn an already completed deletion into a false failure.
    }
    if (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error(
    successfulRead
      ? 'phase0c_totp_user_cleanup_timeout'
      : 'phase0c_totp_user_cleanup_request_failed'
  );
}

export async function cleanupPhase0cMachinePrincipal(input: {
  adminDatabaseName: string;
  clientId: string;
  principalId: string;
  principalType: string;
  attempts?: number;
  retryDelayMs?: number;
  execute?: typeof executeD1Command;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const attempts = input.attempts ?? 3;
  const retryDelayMs = input.retryDelayMs ?? 250;
  const execute = input.execute ?? executeD1Command;
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await execute(
        input.adminDatabaseName,
        buildSetupMachineAccessCleanupSql({
          clientId: input.clientId,
          principalId: input.principalId,
          principalType: input.principalType,
        })
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(retryDelayMs * attempt);
      }
    }
  }
  throw lastError;
}

export function buildTotpSettingsRestorePatch(
  original: Phase0cTotpCategorySettings,
  currentVersion: string
): { ifMatch: string; set?: Record<string, unknown>; clear?: string[] } {
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const key of TOTP_SETTING_KEYS) {
    if (original.sources[key] === 'kv') set[key] = original.values[key];
    else clear.push(key);
  }
  return {
    ifMatch: currentVersion,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(clear.length > 0 ? { clear } : {}),
  };
}

function strictTotpProfile(value: unknown): TotpProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('phase0c_totp_profile_invalid');
  }
  const profile = value as Partial<TotpProfile>;
  if (
    !['SHA1', 'SHA256'].includes(String(profile.algorithm)) ||
    ![6, 8].includes(Number(profile.digits)) ||
    !Number.isSafeInteger(profile.period) ||
    Number(profile.period) < 15 ||
    Number(profile.period) > 300 ||
    !Number.isSafeInteger(profile.window) ||
    Number(profile.window) < 0 ||
    Number(profile.window) > 2
  ) {
    throw new Error('phase0c_totp_profile_invalid');
  }
  return profile as TotpProfile;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('phase0c_totp_response_too_large');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('phase0c_totp_response_too_large');
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

async function publicJson(input: {
  baseUrl: string;
  path: string;
  tenantId: string;
  body: Record<string, unknown>;
  acceptedStatuses: readonly number[];
  diagnosticSessionId?: string;
}): Promise<{ response: Response; payload: unknown; durationMs: number }> {
  const startedAt = performance.now();
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: input.baseUrl,
      'X-Tenant-Id': input.tenantId,
      ...(input.diagnosticSessionId
        ? { 'X-Diagnostic-Session-Id': input.diagnosticSessionId }
        : {}),
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const durationMs = performance.now() - startedAt;
  const payload = await readBoundedJson(response).catch(() => ({}));
  if (!input.acceptedStatuses.includes(response.status)) {
    const errorPayload =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const candidateErrorCode =
      typeof errorPayload.error_code === 'string'
        ? errorPayload.error_code
        : typeof errorPayload.error === 'string'
          ? errorPayload.error
          : '';
    const errorCode = /^(?:AR\d{6}|[a-z][a-z0-9_]{0,63})$/u.test(candidateErrorCode)
      ? `:${candidateErrorCode}`
      : '';
    throw new Error(
      `phase0c_totp_public_request_failed:${input.path}:${response.status}${errorCode}`
    );
  }
  return { response, payload, durationMs };
}

function strictProvisioningAccepted(value: unknown): ProvisioningAccepted {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('phase0c_totp_provisioning_response_invalid');
  }
  const accepted = value as Partial<ProvisioningAccepted>;
  if (
    accepted.status !== 'provisioning' ||
    typeof accepted.provisioning_token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(accepted.provisioning_token) ||
    accepted.status_endpoint !== '/api/v1/auth/account-provisioning/status' ||
    typeof accepted.retry_after_ms !== 'number' ||
    accepted.retry_after_ms < 100 ||
    accepted.retry_after_ms > 5_000
  ) {
    throw new Error('phase0c_totp_provisioning_response_invalid');
  }
  return accepted as ProvisioningAccepted;
}

async function waitForProvisioning(input: {
  baseUrl: string;
  tenantId: string;
  accepted: ProvisioningAccepted;
}): Promise<void> {
  const deadline = Date.now() + 120_000;
  let retryAfterMs = input.accepted.retry_after_ms;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryAfterMs));
    const status = await publicJson({
      baseUrl: input.baseUrl,
      path: input.accepted.status_endpoint,
      tenantId: input.tenantId,
      body: { provisioning_token: input.accepted.provisioning_token },
      acceptedStatuses: [200],
    });
    if (!status.payload || typeof status.payload !== 'object' || Array.isArray(status.payload)) {
      throw new Error('phase0c_totp_provisioning_status_invalid');
    }
    const value = status.payload as Record<string, unknown>;
    if (value.status === 'ready') return;
    if (value.status !== 'pending') throw new Error('phase0c_totp_provisioning_failed');
    retryAfterMs =
      typeof value.retry_after_ms === 'number' && value.retry_after_ms >= 100
        ? Math.min(5_000, value.retry_after_ms)
        : retryAfterMs;
  }
  throw new Error('phase0c_totp_provisioning_timeout');
}

export async function createPhase0cTotpUser(input: {
  baseUrl: string;
  tenantId: string;
  email: string;
}): Promise<{ userId: string; secret: string; profile: TotpProfile }> {
  let options: Awaited<ReturnType<typeof publicJson>> | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      options = await publicJson({
        baseUrl: input.baseUrl,
        path: '/api/auth/totp/signup/options',
        tenantId: input.tenantId,
        body: { email: input.email, label: 'Phase 0c production TOTP smoke' },
        acceptedStatuses: [201],
      });
      break;
    } catch (error) {
      if (
        attempt < 7 &&
        error instanceof Error &&
        error.message ===
          'phase0c_totp_public_request_failed:/api/auth/totp/signup/options:500:AR900001'
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  if (!options) throw new Error('phase0c_totp_signup_options_retry_exhausted');
  if (!options.payload || typeof options.payload !== 'object' || Array.isArray(options.payload)) {
    throw new Error('phase0c_totp_signup_options_invalid');
  }
  const value = options.payload as Partial<TotpSignupOptions>;
  const challengeId = requiredString(value.challenge_id, 'phase0c_totp_challenge_missing');
  const secret = requiredString(value.secret, 'phase0c_totp_secret_missing');
  if (!/^[A-Z2-7]{16,128}$/u.test(secret)) throw new Error('phase0c_totp_secret_invalid');
  const profile = strictTotpProfile(value.profile);
  const serverClockOffsetMs = phase0cTotpServerClockOffsetMs(options.response.headers.get('date'));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = await generateTotpCode(
      secret,
      profile,
      phase0cTotpActivationTimeStep(Date.now() + serverClockOffsetMs, profile)
    );
    let activated: Awaited<ReturnType<typeof publicJson>>;
    try {
      activated = await publicJson({
        baseUrl: input.baseUrl,
        path: '/api/auth/totp/signup/activate',
        tenantId: input.tenantId,
        body: { challenge_id: challengeId, code },
        acceptedStatuses: [200, 202],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        (attempt < 7 &&
          message ===
            'phase0c_totp_public_request_failed:/api/auth/totp/signup/activate:400:AR000006') ||
        (attempt < 7 &&
          message ===
            'phase0c_totp_public_request_failed:/api/auth/totp/signup/activate:500:AR900001')
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
        continue;
      }
      throw error;
    }
    if (activated.response.status === 202) {
      await waitForProvisioning({
        baseUrl: input.baseUrl,
        tenantId: input.tenantId,
        accepted: strictProvisioningAccepted(activated.payload),
      });
      continue;
    }
    if (!activated.payload || typeof activated.payload !== 'object') {
      throw new Error('phase0c_totp_signup_activation_invalid');
    }
    const result = activated.payload as Partial<TotpSignupResult>;
    if (result.success !== true || typeof result.user?.id !== 'string') {
      throw new Error('phase0c_totp_signup_activation_invalid');
    }
    return { userId: result.user.id, secret, profile };
  }
  throw new Error('phase0c_totp_signup_activation_retry_exhausted');
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function duration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function parsePhase0cServerTiming(value: string | null): Record<string, number> {
  if (!value) return {};
  const result: Record<string, number> = {};
  for (const entry of value.split(',')) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*;\s*dur=(\d+(?:\.\d+)?)\s*$/u.exec(entry);
    if (!match) continue;
    if (!isPhase0cAuthTimingName(match[1]) && !isPhase0cTokenTimingName(match[1])) continue;
    const durationMs = Number(match[2]);
    if (Number.isFinite(durationMs)) result[match[1]] = durationMs;
  }
  return result;
}

export async function runPhase0cTotpFullLogin(input: {
  baseUrl: string;
  tenantId: string;
  email: string;
  secret: string;
  profile: TotpProfile;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  diagnosticSessionId?: string;
}): Promise<Phase0cTotpFullLoginEvidence> {
  const fullStartedAt = performance.now();
  const proof = pkce();
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const authorize = new URL('/authorize', input.baseUrl);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: 'openid',
    state,
    nonce,
    code_challenge: proof.challenge,
    code_challenge_method: 'S256',
  }).toString();

  let startedAt = performance.now();
  const authorizeInit = await fetch(authorize, {
    headers: input.diagnosticSessionId
      ? { 'X-Diagnostic-Session-Id': input.diagnosticSessionId }
      : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const authorizeInitMs = duration(startedAt);
  if (![200, 302].includes(authorizeInit.status)) {
    throw new Error(`phase0c_totp_authorize_init_failed:${authorizeInit.status}`);
  }

  const loginStart = await publicJson({
    baseUrl: input.baseUrl,
    path: '/api/auth/totp/login/start',
    tenantId: input.tenantId,
    body: { identifier: input.email },
    acceptedStatuses: [200],
    diagnosticSessionId: input.diagnosticSessionId,
  });
  if (!loginStart.payload || typeof loginStart.payload !== 'object') {
    throw new Error('phase0c_totp_login_start_invalid');
  }
  const challengeId = requiredString(
    (loginStart.payload as { challenge_id?: unknown }).challenge_id,
    'phase0c_totp_login_challenge_missing'
  );
  const code = await generateTotpCode(
    input.secret,
    input.profile,
    getTotpTimeStep(
      Date.now() + phase0cTotpServerClockOffsetMs(loginStart.response.headers.get('date')),
      input.profile.period
    )
  );
  const totpCompletionStartedAt = performance.now();
  const loginVerify = await publicJson({
    baseUrl: input.baseUrl,
    path: '/api/auth/totp/login/verify',
    tenantId: input.tenantId,
    body: { challenge_id: challengeId, code },
    acceptedStatuses: [200],
    diagnosticSessionId: input.diagnosticSessionId,
  });
  if (!loginVerify.payload || typeof loginVerify.payload !== 'object') {
    throw new Error('phase0c_totp_login_verify_invalid');
  }
  const sessionId = requiredString(
    (loginVerify.payload as { sessionId?: unknown }).sessionId,
    'phase0c_totp_session_missing'
  );

  const authorizeCodeUrl = new URL(authorize);
  authorizeCodeUrl.searchParams.set('prompt', 'none');
  startedAt = performance.now();
  const authorizeCodeResponse = await fetch(authorizeCodeUrl, {
    headers: {
      Cookie: `authrim_session=${sessionId}`,
      ...(input.diagnosticSessionId
        ? { 'X-Diagnostic-Session-Id': input.diagnosticSessionId }
        : {}),
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const authorizeCodeMs = duration(startedAt);
  if (authorizeCodeResponse.status !== 302) {
    throw new Error(`phase0c_totp_authorize_code_failed:${authorizeCodeResponse.status}`);
  }
  const location = authorizeCodeResponse.headers.get('location');
  if (!location) throw new Error('phase0c_totp_authorize_location_missing');
  const authorizationRedirect = new URL(location, input.redirectUri);
  const authCode = authorizationRedirect.searchParams.get('code');
  if (!authCode) {
    const oauthError = authorizationRedirect.searchParams.get('error');
    const safeOauthError =
      oauthError && /^[a-z][a-z0-9_]{0,63}$/u.test(oauthError) ? oauthError : 'unknown_error';
    const expectedClientRedirect = new URL(input.redirectUri);
    const redirectTarget =
      authorizationRedirect.origin === expectedClientRedirect.origin &&
      authorizationRedirect.pathname === expectedClientRedirect.pathname
        ? 'client'
        : authorizationRedirect.origin === new URL(input.baseUrl).origin
          ? 'authrim'
          : 'other';
    throw new Error(`phase0c_totp_authorization_code_missing:${safeOauthError}:${redirectTarget}`);
  }

  startedAt = performance.now();
  const tokenResponse = await fetch(new URL('/token', input.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(input.diagnosticSessionId
        ? { 'X-Diagnostic-Session-Id': input.diagnosticSessionId }
        : {}),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: input.redirectUri,
      code_verifier: proof.verifier,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const tokenMs = duration(startedAt);
  const tokenPayload = await readBoundedJson(tokenResponse).catch(() => ({}));
  if (
    tokenResponse.status !== 200 ||
    !tokenPayload ||
    typeof tokenPayload !== 'object' ||
    typeof (tokenPayload as { access_token?: unknown }).access_token !== 'string'
  ) {
    throw new Error(`phase0c_totp_token_failed:${tokenResponse.status}`);
  }

  const authorizeInitTiming = parsePhase0cServerTiming(authorizeInit.headers.get('server-timing'));
  const authorizeCodeTiming = parsePhase0cServerTiming(
    authorizeCodeResponse.headers.get('server-timing')
  );
  const totpStartTiming = parsePhase0cServerTiming(
    loginStart.response.headers.get('server-timing')
  );
  const totpVerifyTiming = parsePhase0cServerTiming(
    loginVerify.response.headers.get('server-timing')
  );
  const tokenTiming = parsePhase0cServerTiming(tokenResponse.headers.get('server-timing'));
  return {
    success: true,
    latencyMs: {
      authorizeInit: authorizeInitMs,
      totpStart: Math.round(loginStart.durationMs * 100) / 100,
      totpVerify: Math.round(loginVerify.durationMs * 100) / 100,
      authorizeCode: authorizeCodeMs,
      token: tokenMs,
      totpCompletion: duration(totpCompletionStartedAt),
      fullFlow: duration(fullStartedAt),
    },
    ...(Object.keys(authorizeInitTiming).length > 0 ||
    Object.keys(totpStartTiming).length > 0 ||
    Object.keys(totpVerifyTiming).length > 0 ||
    Object.keys(authorizeCodeTiming).length > 0 ||
    Object.keys(tokenTiming).length > 0
      ? {
          diagnosticTimingMs: {
            authorizeInit: authorizeInitTiming,
            totpStart: totpStartTiming,
            totpVerify: totpVerifyTiming,
            authorizeCode: authorizeCodeTiming,
            token: tokenTiming,
          },
        }
      : {}),
  };
}

export function validatePhase0cTotpSmokeEvidence(input: {
  evidence: unknown;
  runId: string;
  tenantId: string;
  forbiddenValues: readonly string[];
}): SmokeEvidence {
  const evidence = input.evidence as Partial<SmokeEvidence>;
  if (
    evidence.schemaVersion !== 1 ||
    evidence.runId !== input.runId ||
    evidence.tenantId !== input.tenantId ||
    evidence.scenario !== 'production_totp_full_login_smoke' ||
    evidence.iterations !== 1 ||
    evidence.authenticationBypass !== false ||
    evidence.testInbox !== false ||
    evidence.readReplication !== 'disabled' ||
    evidence.success !== true ||
    evidence.cleanup?.user !== 'absent' ||
    evidence.cleanup.client !== 'deleted' ||
    evidence.cleanup.settings !== 'restored' ||
    evidence.cleanup.machinePrincipal !== 'deleted' ||
    !evidence.latencyMs ||
    Object.values(evidence.latencyMs).some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0
    )
  ) {
    throw new Error('phase0c_totp_evidence_invalid');
  }
  const serialized = JSON.stringify(evidence);
  if (input.forbiddenValues.some((value) => value.length >= 4 && serialized.includes(value))) {
    throw new Error('phase0c_totp_evidence_contains_forbidden_value');
  }
  const sensitiveKeys = new Set([
    'authorization',
    'bearer',
    'client_secret',
    'access_token',
    'sessionId',
    'session_id',
    'challenge_id',
  ]);
  const containsSensitiveField = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsSensitiveField);
    return Object.entries(value).some(
      ([key, child]) => sensitiveKeys.has(key) || containsSensitiveField(child)
    );
  };
  if (containsSensitiveField(evidence) || /@test\.authrim\.internal/iu.test(serialized)) {
    throw new Error('phase0c_totp_evidence_contains_sensitive_field');
  }
  return evidence as SmokeEvidence;
}

async function main(): Promise<void> {
  const options = parsePhase0cTotpSmokeArgs(process.argv.slice(2));
  const config = strictPhase0cLiveConfig(await readPhase0cJson(TEST_CONFIG_PATH));
  const lock = await readPhase0cJson(TEST_LOCK_PATH);
  const adminDatabaseName = strictPhase0cAdminDatabaseName(lock);
  const tenantId = config.tenant.name;
  const baseUrl = resolvePhase0cTenantApiBaseUrl(config, options.environment);
  const runId = createPhase0cTotpRunId();
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('phase0c_totp_run_id_invalid');

  const tempDir = await mkdtemp('/private/tmp/authrim-phase0c-totp-smoke-');
  await chmod(tempDir, 0o700);
  const machineClientId = `authrim-${runId}`;
  const principalId = `amp_${runId.replace(/-/gu, '_')}`;
  const principalType = 'automation' as const;
  const clientName = `Phase 0c production TOTP smoke ${runId}`;
  const email = `${runId}@test.authrim.internal`;
  const redirectUri = 'https://localhost:3000/callback';

  let machinePrincipalCreated = false;
  let adminToken = '';
  let oauthClientId = '';
  let oauthClientSecret = '';
  let userId = '';
  let userCreationStarted = false;
  let totpSecret = '';
  let originalSettings: Phase0cTotpCategorySettings | null = null;
  let settingsMutated = false;
  let loginEvidence: Phase0cTotpFullLoginEvidence | null = null;
  let executionError: unknown = null;
  let executionStage: TotpExecutionStage = 'machine_bootstrap';
  const cleanupErrors: string[] = [];

  try {
    executionStage = 'machine_bootstrap';
    await ensureSetupMachineKeyFiles(tempDir, `${runId}-key`);
    const publicJwk = await loadSetupMachinePublicJwk(tempDir);
    const bootstrapSql = buildSetupMachineAccessBootstrapSql(config, publicJwk, {
      clientId: machineClientId,
      principalId,
      permissions: MACHINE_PERMISSIONS,
      displayName: clientName,
      description: 'Ephemeral production TOTP Phase 0c smoke principal.',
      principalType,
      tokenTtlSeconds: 15 * 60,
      createdByActorId: runId,
    });
    machinePrincipalCreated = true;
    await executeD1Command(adminDatabaseName, bootstrapSql);
    executionStage = 'machine_token';
    const token = await requestAdminMachineAccessToken({
      apiBaseUrl: baseUrl,
      keysDir: tempDir,
      tenantId,
      clientId: machineClientId,
      scopes: MACHINE_PERMISSIONS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (token.expiresIn < 600 || !hasExactPhase0cScope(token.scope, MACHINE_PERMISSIONS)) {
      throw new Error('phase0c_totp_machine_token_scope_invalid');
    }
    adminToken = token.accessToken;

    executionStage = 'settings_read';
    originalSettings = strictPhase0cTotpCategorySettings(
      await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
        token: adminToken,
        tenantId,
      })
    );
    settingsMutated = true;
    executionStage = 'settings_patch';
    await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
      method: 'PATCH',
      token: adminToken,
      tenantId,
      body: {
        ifMatch: originalSettings.version,
        set: {
          'authentication-methods.totp.login_enabled': true,
          'authentication-methods.totp.signup_enabled': true,
          'authentication-methods.totp.preset': 'compatible',
          'authentication-methods.human_verification.signup_enabled': false,
        },
      },
    });
    executionStage = 'settings_wait';
    await waitForPhase0cTotpSettings({ baseUrl, tenantId, token: adminToken });

    executionStage = 'client_create';
    const clientPayload = (await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/clients',
      method: 'POST',
      token: adminToken,
      tenantId,
      idempotencyKey: `phase0c-totp-smoke-client-${runId}`,
      body: {
        client_name: clientName,
        description: 'Disposable production TOTP Phase 0c smoke client.',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        require_pkce: true,
        default_resource: baseUrl,
      },
    })) as { client?: { client_id?: unknown; client_secret?: unknown } };
    oauthClientId = requiredString(
      clientPayload.client?.client_id,
      'phase0c_totp_client_id_missing'
    );
    oauthClientSecret = requiredString(
      clientPayload.client?.client_secret,
      'phase0c_totp_client_secret_missing'
    );
    executionStage = 'client_settings_read';
    const clientSettings = (await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
      token: adminToken,
      tenantId,
    })) as { version?: unknown };
    executionStage = 'client_settings_patch';
    await phase0cAdminJson({
      baseUrl,
      path: `/api/admin/clients/${encodeURIComponent(oauthClientId)}/settings`,
      method: 'PATCH',
      token: adminToken,
      tenantId,
      body: {
        ifMatch: requiredString(
          clientSettings.version,
          'phase0c_totp_client_settings_version_missing'
        ),
        set: { 'client.sso_enabled': true },
      },
    });
    executionStage = 'trust_policy_upsert';
    await phase0cAdminJson({
      baseUrl,
      path: '/api/admin/client-trust-policies',
      method: 'PUT',
      token: adminToken,
      tenantId,
      body: {
        target_type: 'oidc_client',
        target_id: oauthClientId,
        display_name: `${clientName} trust policy`,
        description: 'Disposable production TOTP Phase 0c no-consent policy.',
        first_party: true,
        trusted: true,
        skip_authorization_consent: true,
        is_active: true,
      },
    });

    userCreationStarted = true;
    executionStage = 'user_create';
    const user = await createPhase0cTotpUser({ baseUrl, tenantId, email });
    userId = user.userId;
    totpSecret = user.secret;
    executionStage = 'full_login';
    loginEvidence = await runPhase0cTotpFullLogin({
      baseUrl,
      tenantId,
      email,
      secret: user.secret,
      profile: user.profile,
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      redirectUri,
      diagnosticSessionId: runId,
    });
  } catch (error) {
    executionError =
      safePhase0cTotpExecutionError(error) === 'phase0c_totp_execution_failed'
        ? new Error(`phase0c_totp_stage_${executionStage}_failed`)
        : error;
  } finally {
    if (machinePrincipalCreated) {
      try {
        const refreshed = await requestAdminMachineAccessToken({
          apiBaseUrl: baseUrl,
          keysDir: tempDir,
          tenantId,
          clientId: machineClientId,
          scopes: MACHINE_PERMISSIONS,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!hasExactPhase0cScope(refreshed.scope, MACHINE_PERMISSIONS)) {
          throw new Error('phase0c_totp_machine_token_scope_invalid');
        }
        adminToken = refreshed.accessToken;
      } catch {
        cleanupErrors.push('machine_token_refresh_failed');
      }
    }
    if (adminToken && userId) {
      try {
        await phase0cAdminJson({
          baseUrl,
          path: `/api/admin/users/${encodeURIComponent(userId)}`,
          method: 'DELETE',
          token: adminToken,
          tenantId,
        });
      } catch {
        cleanupErrors.push('user_cleanup_failed');
      }
    }
    if (adminToken && userCreationStarted) {
      let reconciledUserId: string | null = null;
      try {
        reconciledUserId = await findPhase0cUserIdByExactEmail({
          baseUrl,
          token: adminToken,
          tenantId,
          email,
        });
      } catch {
        cleanupErrors.push('user_reconciliation_lookup_failed');
      }
      if (reconciledUserId && reconciledUserId !== userId) {
        try {
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/users/${encodeURIComponent(reconciledUserId)}`,
            method: 'DELETE',
            token: adminToken,
            tenantId,
          });
        } catch {
          cleanupErrors.push('user_reconciliation_delete_failed');
        }
      }
      try {
        await waitForPhase0cTotpUserAbsent({ baseUrl, token: adminToken, tenantId, email });
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error && error.message === 'phase0c_totp_user_cleanup_timeout'
            ? 'user_absence_check_timeout'
            : 'user_absence_check_request_failed'
        );
      }
    }
    if (adminToken) {
      let clientIds = oauthClientId ? [oauthClientId] : [];
      try {
        clientIds = [
          ...new Set([
            ...clientIds,
            ...(await findPhase0cClientIdsByExactName({
              baseUrl,
              token: adminToken,
              tenantId,
              clientName,
            })),
          ]),
        ];
      } catch {
        if (!oauthClientId) cleanupErrors.push('client_reconciliation_failed');
      }
      for (const clientId of clientIds) {
        try {
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/clients/${encodeURIComponent(clientId)}`,
            method: 'DELETE',
            token: adminToken,
            tenantId,
          });
        } catch {
          cleanupErrors.push('client_cleanup_failed');
        }
      }
    }
    if (adminToken && settingsMutated && originalSettings) {
      try {
        const current = strictPhase0cTotpCategorySettings(
          await phase0cAdminJson({
            baseUrl,
            path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
            token: adminToken,
            tenantId,
          })
        );
        await phase0cAdminJson({
          baseUrl,
          path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
          method: 'PATCH',
          token: adminToken,
          tenantId,
          body: buildTotpSettingsRestorePatch(originalSettings, current.version),
        });
        await waitForRestoredPhase0cTotpSettings({
          baseUrl,
          tenantId,
          token: adminToken,
          original: originalSettings,
        });
      } catch {
        cleanupErrors.push('settings_cleanup_failed');
      }
    }
    if (machinePrincipalCreated) {
      try {
        await cleanupPhase0cMachinePrincipal({
          adminDatabaseName,
          clientId: machineClientId,
          principalId,
          principalType,
        });
      } catch {
        cleanupErrors.push('machine_principal_cleanup_failed');
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }

  if (cleanupErrors.length > 0) {
    const execution = executionError ? `:${safePhase0cTotpExecutionError(executionError)}` : '';
    throw new Error(`phase0c_totp_cleanup_incomplete:${cleanupErrors.join(',')}${execution}`);
  }
  if (executionError) throw executionError;
  if (!loginEvidence) throw new Error('phase0c_totp_evidence_missing');

  const evidence: SmokeEvidence = {
    schemaVersion: 1,
    runId,
    tenantId,
    scenario: 'production_totp_full_login_smoke',
    iterations: 1,
    authenticationBypass: false,
    testInbox: false,
    readReplication: 'disabled',
    ...loginEvidence,
    cleanup: {
      user: 'absent',
      client: 'deleted',
      settings: 'restored',
      machinePrincipal: 'deleted',
    },
  };
  validatePhase0cTotpSmokeEvidence({
    evidence,
    runId,
    tenantId,
    forbiddenValues: [adminToken, oauthClientSecret, totpSecret, email],
  });
  await writeFile(options.resultPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(options.resultPath, 0o600);
  console.log(`Phase 0c production TOTP smoke evidence: ${options.resultPath}`);
}

const isEntrypoint = isPhase0cTotpEntrypoint(process.argv[1]);
if (isEntrypoint) {
  try {
    await main();
  } catch (error) {
    console.error(safePhase0cTotpExecutionError(error));
    process.exitCode = 1;
  }
}
