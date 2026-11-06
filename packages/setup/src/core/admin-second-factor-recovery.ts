/**
 * Last-resort recovery of an admin's step-up second factors, on Cloudflare authority.
 *
 * Under the environment lock, the setup tool writes its short-lived machine principal into
 * DB_ADMIN with only `admin:last_resort_recovery`, reaching every tenant, calls
 * `POST /api/admin/platform/last-resort-recovery/second-factors` with a token for that permission
 * alone, and removes the principal again. The API revokes every second factor of the admin (the
 * rows stay), ends their sessions, cancels an open recovery request and opens a re-enrolment
 * window; the admin then signs in with their passkey and registers a new second factor.
 *
 * Environments without a local lock file cannot use this; docs/operations describes the manual
 * D1 procedure for them.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { AuthrimConfigSchema, type AuthrimConfig } from './config.js';
import { listD1Databases } from './cloudflare.js';
import { requestAdminMachineAccessToken } from './admin-machine-access.js';
import { assertFixedD1ResourceIdentities } from './fixed-d1-identity.js';
import { fetchWithTimeout, readResponseJsonWithLimit } from './http-limits.js';
import { acquireEnvironmentOperationForEnvironment } from './lock.js';
import { getEnvironmentPaths } from './paths.js';
import { runEphemeralSetupMachineAccess } from './setup-machine-access-lifecycle.js';
import { resolveIssuerUrl } from './url-config.js';

export const LAST_RESORT_RECOVERY_PERMISSION = 'admin:last_resort_recovery';
export const LAST_RESORT_RECOVERY_PATH = '/api/admin/platform/last-resort-recovery/second-factors';
export const LAST_RESORT_RECOVERY_OPERATION = 'admin-second-factor-recovery';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;
const MAX_REASON_LENGTH = 200;

export interface AdminSecondFactorRecoveryRequest {
  email: string;
  tenantId?: string;
  reason?: string;
}

export interface AdminSecondFactorRecoveryResult {
  admin: { id: string; email: string; tenantId: string };
  revokedSecondFactors: number;
  endedSessions: number;
  cancelledRecoveryRequests: number;
  reenrollUntil: number;
  soleAdmin: boolean;
  auditLogged: boolean;
  notices: { emailed: boolean; emailRecipients: number; console: boolean };
}

/** A refusal the API gave, with its error code (e.g. `admin_ambiguous`). */
export class AdminSecondFactorRecoveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(`admin_second_factor_recovery_failed:${status}:${code}`);
    this.name = 'AdminSecondFactorRecoveryError';
  }
}

/** The request as the API takes it, or an error for input the API would refuse anyway. */
export function normalizeRecoveryRequest(
  request: AdminSecondFactorRecoveryRequest
): AdminSecondFactorRecoveryRequest {
  const email = request.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new Error('admin_second_factor_recovery_email_invalid');
  }
  const tenantId = request.tenantId?.trim();
  if (tenantId !== undefined && tenantId !== '' && !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('admin_second_factor_recovery_tenant_invalid');
  }
  const reason = request.reason?.trim();
  if (reason && reason.length > MAX_REASON_LENGTH) {
    throw new Error('admin_second_factor_recovery_reason_too_long');
  }
  return {
    email,
    ...(tenantId ? { tenantId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The API's answer, checked field by field. */
export function parseRecoveryResponse(value: unknown): AdminSecondFactorRecoveryResult {
  const fail = () => new Error('admin_second_factor_recovery_response_invalid');
  if (!isRecord(value) || !isRecord(value.admin) || !isRecord(value.notices)) throw fail();
  const { admin, notices } = value;
  const integer = (input: unknown) => {
    if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) throw fail();
    return input;
  };
  const flag = (input: unknown) => {
    if (typeof input !== 'boolean') throw fail();
    return input;
  };
  if (
    typeof admin.id !== 'string' ||
    typeof admin.email !== 'string' ||
    typeof admin.tenant_id !== 'string'
  ) {
    throw fail();
  }
  return {
    admin: { id: admin.id, email: admin.email, tenantId: admin.tenant_id },
    revokedSecondFactors: integer(value.revoked_second_factors),
    endedSessions: integer(value.ended_sessions),
    cancelledRecoveryRequests: integer(value.cancelled_recovery_requests),
    reenrollUntil: integer(value.reenroll_until),
    soleAdmin: flag(value.sole_admin),
    auditLogged: flag(value.audit_logged),
    notices: {
      emailed: flag(notices.emailed),
      emailRecipients: integer(notices.email_recipients),
      console: flag(notices.console),
    },
  };
}

export interface RecoverAdminSecondFactorInput extends AdminSecondFactorRecoveryRequest {
  baseDir: string;
  env: string;
  keysDir: string;
  onProgress?: (message: string) => void;
}

/** What the command needs from outside, replaceable in tests. */
export interface RecoverAdminSecondFactorDeps {
  acquireLock: typeof acquireEnvironmentOperationForEnvironment;
  listD1Databases: typeof listD1Databases;
  runEphemeral: typeof runEphemeralSetupMachineAccess;
  requestToken: typeof requestAdminMachineAccessToken;
  fetch: typeof fetchWithTimeout;
  readConfig: (path: string) => Promise<AuthrimConfig>;
}

const defaultDeps: RecoverAdminSecondFactorDeps = {
  acquireLock: acquireEnvironmentOperationForEnvironment,
  listD1Databases,
  runEphemeral: runEphemeralSetupMachineAccess,
  requestToken: requestAdminMachineAccessToken,
  fetch: fetchWithTimeout,
  readConfig: async (path) => AuthrimConfigSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
};

async function callRecoveryApi(
  deps: RecoverAdminSecondFactorDeps,
  input: { apiBaseUrl: string; keysDir: string; tenantId: string },
  request: AdminSecondFactorRecoveryRequest
): Promise<AdminSecondFactorRecoveryResult> {
  const token = await deps.requestToken({
    apiBaseUrl: input.apiBaseUrl,
    keysDir: input.keysDir,
    tenantId: input.tenantId,
    scopes: [LAST_RESORT_RECOVERY_PERMISSION],
  });
  const response = await deps.fetch(`${input.apiBaseUrl}${LAST_RESORT_RECOVERY_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Tenant-Id': input.tenantId,
    },
    body: JSON.stringify({
      email: request.email,
      ...(request.tenantId ? { tenant_id: request.tenantId } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
    }),
  });
  const body = await readResponseJsonWithLimit<unknown>(response).catch(() => ({}));
  if (!response.ok) {
    const record = isRecord(body) ? body : {};
    const code = typeof record.error === 'string' ? record.error : 'unknown';
    const detail = Array.isArray(record.tenant_ids) ? { tenant_ids: record.tenant_ids } : {};
    throw new AdminSecondFactorRecoveryError(response.status, code, detail);
  }
  return parseRecoveryResponse(body);
}

/**
 * Run the recovery for one admin of the environment. Throws when the environment has no lock
 * file (`environment_lock_not_found:<env>`): use the manual procedure there.
 */
export async function recoverAdminSecondFactor(
  input: RecoverAdminSecondFactorInput,
  deps: RecoverAdminSecondFactorDeps = defaultDeps
): Promise<AdminSecondFactorRecoveryResult> {
  const request = normalizeRecoveryRequest(input);
  const paths = getEnvironmentPaths({ baseDir: input.baseDir, env: input.env });
  if (!existsSync(paths.config)) throw new Error(`environment_config_not_found:${input.env}`);

  const operationLock = await deps.acquireLock({
    baseDir: input.baseDir,
    env: input.env,
    operation: LAST_RESORT_RECOVERY_OPERATION,
    requireExisting: true,
  });
  try {
    const lock = operationLock.lock;
    if (!lock) throw new Error(`environment_lock_not_found:${input.env}`);
    if (lock.env !== input.env) throw new Error('admin_recovery_lock_environment_mismatch');
    const config = await deps.readConfig(paths.config);
    if (config.environment.prefix !== input.env) {
      throw new Error('admin_recovery_config_environment_mismatch');
    }
    // The principal goes into this environment's own admin database, nowhere else.
    assertFixedD1ResourceIdentities({
      environment: input.env,
      lock,
      databases: await deps.listD1Databases(),
    });
    const adminDatabaseIdentifier = lock.d1.DB_ADMIN?.id;
    if (!adminDatabaseIdentifier) throw new Error('admin_database_required_for_admin_recovery');
    const apiBaseUrl = resolveIssuerUrl(config, { env: input.env });

    return await deps.runEphemeral({
      env: input.env,
      config,
      keysDir: input.keysDir,
      databaseIdentifier: adminDatabaseIdentifier,
      permissions: [LAST_RESORT_RECOVERY_PERMISSION],
      // The API checks the permission at the global scope: the admin may be in any tenant.
      allTenants: true,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      action: () =>
        callRecoveryApi(
          deps,
          { apiBaseUrl, keysDir: input.keysDir, tenantId: config.tenant.name },
          request
        ),
    });
  } finally {
    await operationLock.release();
  }
}
