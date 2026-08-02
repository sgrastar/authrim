#!/usr/bin/env node

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertControlPlaneRecordIsSecretFree } from '../../packages/ar-lib-core/src/services/control-plane/control-plane-contracts.js';
import { derivePluginInstallationId } from '../../packages/ar-lib-core/src/services/plugin-installation-id.js';
import { requestAdminMachineAccessToken } from '../../packages/setup/src/core/admin-machine-access.js';
import { queryD1Rows } from '../../packages/setup/src/core/cloudflare.js';
import { AuthrimConfigSchema } from '../../packages/setup/src/core/config.js';
import {
  fetchWithTimeout,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from '../../packages/setup/src/core/http-limits.js';
import { withEphemeralSetupMachineAccess } from '../../packages/setup/src/core/setup-machine-access-lifecycle.js';
import { resolveIssuerUrl } from '../../packages/setup/src/core/url-config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ID = 'phase2-resource-live';
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_RESULT_PATH = /^\/(?:private\/)?tmp\/[^\0]+\.json$/u;

interface CleanupResponse {
  success?: unknown;
  pluginId?: unknown;
  tenantId?: unknown;
  enabled?: unknown;
  cleanup?: { operationId?: unknown; state?: unknown };
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error('phase2_plugin_cleanup_arguments_invalid');
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 6 || option(argv, '--env') !== 'test') {
    throw new Error('phase2_plugin_cleanup_arguments_invalid');
  }
  const tenantId = option(argv, '--tenant');
  const resultPath = resolve(option(argv, '--result'));
  if (!SAFE_TENANT.test(tenantId) || !SAFE_RESULT_PATH.test(resultPath)) {
    throw new Error('phase2_plugin_cleanup_arguments_invalid');
  }

  const config = AuthrimConfigSchema.parse(
    JSON.parse(await readFile(resolve(REPO_ROOT, '.authrim/test/config.json'), 'utf8'))
  );
  if (config.tenantD1.automaticProvisioning !== true) {
    throw new Error('phase2_plugin_cleanup_automatic_provisioning_required');
  }
  const lock = JSON.parse(
    await readFile(resolve(REPO_ROOT, '.authrim/test/lock.json'), 'utf8')
  ) as { d1?: Record<string, { name?: unknown }> };
  const controlDatabaseName = lock.d1?.CONTROL_DB?.name;
  const pluginRunnerDatabaseName = lock.d1?.PLUGIN_RUNNER_DB?.name;
  if (typeof controlDatabaseName !== 'string' || typeof pluginRunnerDatabaseName !== 'string') {
    throw new Error('phase2_plugin_cleanup_database_missing');
  }
  const baseUrl = resolveIssuerUrl(config, { env: 'test' })?.replace(/\/+$/u, '');
  if (!baseUrl?.startsWith('https://')) throw new Error('phase2_plugin_cleanup_api_invalid');

  const pluginInstallationId = await derivePluginInstallationId({
    environmentId: 'test',
    tenantId,
    pluginId: PLUGIN_ID,
    purpose: 'dynamic-plugin',
  });
  const idempotencyKey = `phase2-on-cleanup-${pluginInstallationId.slice(-16)}`;
  const keysDir = resolve(config.keys.secretsPath);
  const cleanup = await withEphemeralSetupMachineAccess({
    baseDir: REPO_ROOT,
    env: 'test',
    config,
    keysDir,
    action: async () => {
      const token = await requestAdminMachineAccessToken({
        apiBaseUrl: baseUrl,
        keysDir,
        scopes: ['admin:settings:read', 'admin:settings:write'],
        tenantId,
      });
      const response = await fetchWithTimeout(
        `${baseUrl}/api/admin/plugins/${PLUGIN_ID}/uninstall`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token.accessToken}`,
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
          },
          body: JSON.stringify({
            tenant_id: tenantId,
            idempotency_key: idempotencyKey,
            confirmation: 'UNINSTALL',
          }),
          redirect: 'manual',
        },
        30_000
      );
      if (![200, 202].includes(response.status)) {
        const detail = await readResponseTextWithLimit(response, 16 * 1024);
        throw new Error(`phase2_plugin_cleanup_http_${response.status}:${detail.slice(0, 512)}`);
      }
      const body = await readResponseJsonWithLimit<CleanupResponse>(response, 64 * 1024);
      if (
        body.success !== true ||
        body.pluginId !== PLUGIN_ID ||
        body.tenantId !== tenantId ||
        body.enabled !== false ||
        typeof body.cleanup?.operationId !== 'string'
      ) {
        throw new Error('phase2_plugin_cleanup_response_invalid');
      }
      return {
        status: response.status,
        operationId: body.cleanup.operationId,
        state: body.cleanup.state,
      };
    },
  });

  const projected = await queryD1Rows<{ state: string; control_operation_id: string }>(
    pluginRunnerDatabaseName,
    `SELECT state, control_operation_id
      FROM plugin_runner_dynamic_worker_resources
      WHERE tenant_id = '${tenantId}'
        AND installation_id = '${pluginInstallationId}'
      ORDER BY logical_binding_name`
  );
  if (projected.length !== 3 || projected.some((row) => row.state !== 'disabled')) {
    throw new Error('phase2_plugin_cleanup_projection_not_disabled');
  }

  let operation: Array<{ state: string; drain_not_before: number | null; created_at: number }> = [];
  const pollDeadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < pollDeadline) {
    operation = await queryD1Rows<{
      state: string;
      drain_not_before: number | null;
      created_at: number;
    }>(
      controlDatabaseName,
      `SELECT state, drain_not_before, created_at
         FROM control_plugin_resource_cleanup_operations
        WHERE environment_id = 'test' AND operation_id = '${cleanup.operationId}'`
    );
    if (operation[0]?.state === 'quarantined') break;
    if (operation[0]?.state === 'blocked') {
      throw new Error('phase2_plugin_cleanup_blocked');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  if (
    operation.length !== 1 ||
    operation[0]!.state !== 'quarantined' ||
    operation[0]!.drain_not_before === null ||
    operation[0]!.drain_not_before! - operation[0]!.created_at < 30 * 60
  ) {
    throw new Error('phase2_plugin_cleanup_quarantine_invalid');
  }

  const evidence = {
    schemaVersion: 1,
    environment: 'test',
    tenantId,
    pluginId: PLUGIN_ID,
    pluginInstallationId,
    cleanupOperationId: cleanup.operationId,
    cleanupState: cleanup.state,
    responseStatus: cleanup.status,
    projectedResourceStates: projected.map((row) => row.state),
    quarantineNotBefore: operation[0]!.drain_not_before,
    temporaryMachineAccess: 'deleted',
    tokenEvidence: 'not_persisted',
  };
  assertControlPlaneRecordIsSecretFree(evidence);
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(resultPath, 0o600);
  process.stdout.write(`Phase 2 plugin cleanup evidence written to ${resultPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown_error'}\n`);
    process.exitCode = 1;
  });
}
