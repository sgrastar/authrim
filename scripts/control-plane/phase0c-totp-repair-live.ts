#!/usr/bin/env node

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSetupMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  ensureSetupMachineKeyFiles,
  loadSetupMachinePublicJwk,
  requestAdminMachineAccessToken,
} from '../../packages/setup/src/core/admin-machine-access.js';
import { executeD1Command, queryD1Rows } from '../../packages/setup/src/core/cloudflare.js';
import {
  hasExactPhase0cScope,
  phase0cAdminJson,
  readPhase0cJson,
  strictPhase0cAdminDatabaseName,
  strictPhase0cLiveConfig,
  strictTenantPiiDatabaseNames,
} from './phase0c-mail-otp-live.js';
import { strictPhase0cTotpCategorySettings } from './phase0c-totp-smoke-live.js';
import { resolvePhase0cTenantApiBaseUrl } from './phase0c-live-url.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_CONFIG_PATH = resolve(REPO_ROOT, '.authrim/test/config.json');
const TEST_LOCK_PATH = resolve(REPO_ROOT, '.authrim/test/lock.json');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REPAIR_USERS = 1_200;
const REPAIR_DELETE_CONCURRENCY = 8;
const TOTP_SETTING_KEYS = [
  'authentication-methods.totp.login_enabled',
  'authentication-methods.totp.signup_enabled',
  'authentication-methods.totp.preset',
  'authentication-methods.human_verification.signup_enabled',
] as const;
const MACHINE_PERMISSIONS = [
  'admin:users:*',
  'admin:settings:read',
  'admin:settings:write',
] as const;

type RepairStage = 'machine_access' | 'settings' | 'user_scan' | 'user_cleanup';

export function parsePhase0cTotpRepairArgs(argv: string[]): {
  environment: 'test';
  confirmTestData: true;
} {
  let environment: string | undefined;
  let confirmTestData = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--env') environment = argv[++index];
    else if (argument === '--confirm-test-data') confirmTestData = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (environment !== 'test') throw new Error('phase0c_totp_repair_test_environment_required');
  if (!confirmTestData) throw new Error('phase0c_totp_repair_confirmation_required');
  return { environment: 'test', confirmTestData: true };
}

async function abandonedUserIds(input: {
  databaseNames: readonly string[];
  tenantId: string;
}): Promise<string[]> {
  const rows = (
    await Promise.all(
      input.databaseNames.map((databaseName) =>
        queryD1Rows<{ owner_id?: unknown }>(
          databaseName,
          `SELECT DISTINCT owner_id FROM identity_sensitive_values
             WHERE tenant_id = '${input.tenantId}'
               AND owner_type = 'runtime_user'
               AND value_key = 'email'
               AND lifecycle_state = 'active'
               AND value_json LIKE '"phase0c-totp-%@test.authrim.internal"'
             ORDER BY owner_id
             LIMIT ${MAX_REPAIR_USERS + 1}`
        )
      )
    )
  ).flat();
  const ids = [
    ...new Set(
      rows.map((row) => {
        if (typeof row.owner_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.owner_id)) {
          throw new Error('phase0c_totp_repair_user_id_invalid');
        }
        return row.owner_id;
      })
    ),
  ];
  if (ids.length > MAX_REPAIR_USERS) throw new Error('phase0c_totp_repair_user_limit_exceeded');
  return ids;
}

async function deleteRepairUsers(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  userIds: readonly string[];
}): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(REPAIR_DELETE_CONCURRENCY, input.userIds.length) },
      async () => {
        while (nextIndex < input.userIds.length) {
          const userId = input.userIds[nextIndex++];
          let deleted = false;
          let failureStatus = 'unknown';
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              await phase0cAdminJson({
                baseUrl: input.baseUrl,
                path: `/api/admin/users/${encodeURIComponent(userId)}`,
                method: 'DELETE',
                token: input.token,
                tenantId: input.tenantId,
              });
              deleted = true;
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : '';
              failureStatus =
                /^phase0c_mail_admin_request_failed:DELETE:[^:]+:(\d{3})(?::|$)/u.exec(
                  message
                )?.[1] ?? 'unknown';
              if (attempt < 4) {
                await new Promise((resolveDelay) =>
                  setTimeout(resolveDelay, 250 * (attempt + 1))
                );
              }
            }
          }
          if (!deleted) {
            throw new Error(`phase0c_totp_repair_user_delete_failed_${failureStatus}`);
          }
        }
      }
    )
  );
}

function isTemporaryTotpSettings(input: ReturnType<typeof strictPhase0cTotpCategorySettings>) {
  return (
    input.values['authentication-methods.totp.login_enabled'] === true &&
    input.values['authentication-methods.totp.signup_enabled'] === true &&
    input.values['authentication-methods.totp.preset'] === 'compatible' &&
    input.values['authentication-methods.human_verification.signup_enabled'] === false &&
    TOTP_SETTING_KEYS.every((key) => input.sources[key] === 'kv')
  );
}

async function main(): Promise<void> {
  parsePhase0cTotpRepairArgs(process.argv.slice(2));
  const config = strictPhase0cLiveConfig(await readPhase0cJson(TEST_CONFIG_PATH));
  const lock = await readPhase0cJson(TEST_LOCK_PATH);
  const adminDatabaseName = strictPhase0cAdminDatabaseName(lock);
  const piiDatabaseNames = strictTenantPiiDatabaseNames(lock);
  const tenantId = config.tenant.name;
  const baseUrl = resolvePhase0cTenantApiBaseUrl(config, 'test');
  const tempDir = await mkdtemp('/private/tmp/authrim-phase0c-totp-repair-');
  await chmod(tempDir, 0o700);
  const clientId = `authrim-phase0c-totp-repair-${Date.now()}`;
  const principalId = `amp_phase0c_totp_repair_${Date.now()}`;
  let principalCreated = false;
  let repairError: unknown = null;
  let repairStage: RepairStage = 'machine_access';
  const cleanupErrors: string[] = [];

  try {
    await ensureSetupMachineKeyFiles(tempDir, 'repair-key');
    const publicJwk = await loadSetupMachinePublicJwk(tempDir);
    principalCreated = true;
    await executeD1Command(
      adminDatabaseName,
      buildSetupMachineAccessBootstrapSql(config, publicJwk, {
        clientId,
        principalId,
        permissions: MACHINE_PERMISSIONS,
        displayName: 'Phase 0c interrupted TOTP repair',
        description: 'Ephemeral repair principal for interrupted test-only TOTP load runs.',
        principalType: 'automation',
        tokenTtlSeconds: 600,
        createdByActorId: 'phase0c-totp-repair',
      })
    );
    const token = await requestAdminMachineAccessToken({
      apiBaseUrl: baseUrl,
      keysDir: tempDir,
      tenantId,
      clientId,
      scopes: MACHINE_PERMISSIONS,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!hasExactPhase0cScope(token.scope, MACHINE_PERMISSIONS)) {
      throw new Error('phase0c_totp_repair_machine_scope_invalid');
    }

    repairStage = 'settings';
    const settings = strictPhase0cTotpCategorySettings(
      await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
        token: token.accessToken,
        tenantId,
      })
    );
    if (isTemporaryTotpSettings(settings)) {
      await phase0cAdminJson({
        baseUrl,
        path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/authentication-methods`,
        method: 'PATCH',
        token: token.accessToken,
        tenantId,
        body: { ifMatch: settings.version, clear: [...TOTP_SETTING_KEYS] },
      });
    } else if (TOTP_SETTING_KEYS.some((key) => settings.sources[key] === 'kv')) {
      throw new Error('phase0c_totp_repair_settings_not_exact_temporary_state');
    }

    repairStage = 'user_scan';
    const userIds = await abandonedUserIds({ databaseNames: piiDatabaseNames, tenantId });
    repairStage = 'user_cleanup';
    await deleteRepairUsers({
      baseUrl,
      token: token.accessToken,
      tenantId,
      userIds,
    });
    let repaired = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const remaining = await abandonedUserIds({ databaseNames: piiDatabaseNames, tenantId });
      if (remaining.length === 0) {
        process.stdout.write(`Phase 0c TOTP repair completed; removed users: ${userIds.length}\n`);
        repaired = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    if (!repaired) throw new Error('phase0c_totp_repair_users_remain');
  } catch (error) {
    repairError = error;
  } finally {
    if (principalCreated) {
      try {
        await executeD1Command(
          adminDatabaseName,
          buildSetupMachineAccessCleanupSql({
            clientId,
            principalId,
            principalType: 'automation',
          })
        );
      } catch {
        cleanupErrors.push('principal_cleanup_failed');
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }
  if (cleanupErrors.length > 0) throw new Error('phase0c_totp_repair_cleanup_incomplete');
  if (repairError) {
    const message = repairError instanceof Error ? repairError.message : '';
    if (/^phase0c_totp_repair_[a-z0-9_]+$/u.test(message)) throw repairError;
    throw new Error(`phase0c_totp_repair_stage_${repairStage}_failed`);
  }
}

export function isPhase0cTotpRepairEntrypoint(
  argv1: string | undefined,
  repositoryRoot = REPO_ROOT
): boolean {
  return (
    argv1 !== undefined &&
    resolve(argv1) === resolve(repositoryRoot, 'scripts/control-plane/phase0c-totp-repair-live.ts')
  );
}

if (isPhase0cTotpRepairEntrypoint(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'phase0c_totp_repair_failed';
    process.stderr.write(
      `${/^phase0c_totp_repair_[a-z0-9_]+$/u.test(message) ? message : 'phase0c_totp_repair_failed'}\n`
    );
    process.exitCode = 1;
  }
}
