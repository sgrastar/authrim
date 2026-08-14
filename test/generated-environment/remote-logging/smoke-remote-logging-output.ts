#!/usr/bin/env node

import process from 'node:process';
import { execa } from 'execa';
import { getD1DatabaseName } from '../../../packages/setup/src/core/naming.js';
import { loadLockFileAuto } from '../../../packages/setup/src/core/lock.js';
import {
  getR2ObjectBytes,
  listR2Objects,
  type R2ObjectMetadata,
} from '../../../packages/setup/src/core/cloudflare.js';
import {
  addFail,
  addPass,
  addWarn,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  isSmokeSuccessful,
  makeSmokeCheck,
  readGeneratedAdminApiSecret,
  resolveGeneratedSmokeTarget,
  withTenantHeader,
  type SmokeCheck,
} from '../../../packages/setup/src/core/generated-smoke-common.js';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  timeoutMs?: number;
  adminSecret?: string;
  adminSecretPath?: string;
  json: boolean;
  skipR2: boolean;
}

interface RemoteLoggingSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  tenantId: string;
  configPath: string;
  lockPath: string;
  adminSecretPath: string;
  runId: string;
  checks: SmokeCheck[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, skipR2: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--env') {
      options.env = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--base-dir') {
      options.baseDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--config') {
      options.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
      continue;
    }
    if (arg === '--admin-secret') {
      options.adminSecret = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--admin-secret-file') {
      options.adminSecretPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--skip-r2') {
      options.skipR2 = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown_argument:${arg}`);
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(`Authrim remote logging output smoke

Usage:
  pnpm exec tsx test/generated-environment/remote-logging/smoke-remote-logging-output.ts --env test
  pnpm exec tsx test/generated-environment/remote-logging/smoke-remote-logging-output.ts --config .authrim/test/config.json

Options:
  --env <env>               Resolve .authrim/{env}/config.json and lock.json
  --config <path>           Read a generated config.json directly
  --base-dir <path>         Override repository base directory
  --timeout-ms <n>          Request timeout per HTTP endpoint (default: 10000)
  --admin-secret <secret>   Override admin access token inline
  --admin-secret-file <p>   Read admin access token from a file
  --skip-r2                 Skip Cloudflare R2 REST-list and object-read checks
  --json                    Emit JSON instead of checklist text
`);
}

function label(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'pass') return '[PASS]';
  if (status === 'warn') return '[WARN]';
  return '[FAIL]';
}

function printChecklist(result: RemoteLoggingSmokeResult): void {
  process.stdout.write(`\nAuthrim remote logging output smoke\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseUrl: ${result.baseUrl}\n`);
  process.stdout.write(`tenantId: ${result.tenantId}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  process.stdout.write(`lock: ${result.lockPath}\n`);
  process.stdout.write(`adminAccess: ${result.adminSecretPath}\n`);
  process.stdout.write(`runId: ${result.runId}\n\n`);

  for (const check of result.checks) {
    process.stdout.write(`${label(check.status)} ${check.title}\n`);
    if (check.url) {
      process.stdout.write(`  - ${check.url}\n`);
    }
    if (typeof check.httpStatus === 'number') {
      process.stdout.write(`  - HTTP ${check.httpStatus}\n`);
    }
    for (const detail of check.details) {
      process.stdout.write(`  - ${detail}\n`);
    }
  }

  process.stdout.write(`\nresult: ${result.ok ? 'OK' : 'FAILED'}\n`);
}

function adminHeaders(secret: string, tenantId: string): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    tenantId
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCanonicalAdminAuditArchiveKey(key: string): boolean {
  return /^logs\/v1\/[^/]+\/archive\/admin_audit\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/shard-\d{2}\/chk_[^/]+\.jsonl\.gz$/u.test(
    key
  );
}

function isCanonicalAdminAuditSensitiveDetailKey(key: string): boolean {
  return /^sensitive-details\/v1\/[^/]+\/sensitive_detail\/admin_audit\/admin_audit\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/shard-\d{2}\/[^/]+\.jsonl(?:\.gz)?$/u.test(
    key
  );
}

async function pollR2Object(input: {
  bucketName: string;
  prefix: string;
  matches: (item: R2ObjectMetadata) => boolean;
  notBeforeMs: number;
  timeoutMs: number;
}): Promise<R2ObjectMetadata | null> {
  const deadline = Date.now() + Math.max(input.timeoutMs, 45_000);
  while (Date.now() < deadline) {
    const objects = await listR2Objects({
      bucketName: input.bucketName,
      prefix: input.prefix,
    });
    const match = objects.find((item) => {
      if (!input.matches(item) || item.lastModified === null) return false;
      const lastModifiedMs = Date.parse(item.lastModified);
      return Number.isFinite(lastModifiedMs) && lastModifiedMs >= input.notBeforeMs;
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function assertR2ObjectReadable(bucketName: string, object: R2ObjectMetadata): Promise<void> {
  const bytes = await getR2ObjectBytes({
    bucketName,
    objectKey: object.key,
    maxBytes: 16 * 1024 * 1024,
  });
  if (!bytes || bytes.byteLength === 0) throw new Error('r2_object_empty_or_unreadable');
  if (object.size !== null && object.size !== bytes.byteLength) {
    throw new Error(`r2_object_size_mismatch:${object.size}:${bytes.byteLength}`);
  }
}

async function createLoggingExport(input: {
  baseUrl: string;
  tenantId: string;
  timeoutMs: number;
  adminSecret: string;
}): Promise<{ id: string; status: string; responseStatus: number; queued: boolean }> {
  const response = await remoteJson({
    url: `${input.baseUrl}/api/admin/logging-policies/exports`,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    headers: adminHeaders(input.adminSecret, input.tenantId),
    body: {
      format: 'zip',
      source: 'record_index',
      include_payload: true,
      log_type: 'admin_audit',
      plane: 'archive',
      limit: 20,
    },
  });
  const result =
    isRecord(response.payload) && isRecord(response.payload.result)
      ? response.payload.result
      : null;
  const id = result ? stringValue(result.id) : null;
  const status = result ? stringValue(result.status) : null;
  if (!response.ok || !id || !status) {
    throw new Error(
      `logging_export_create_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }
  return {
    id,
    status,
    responseStatus: response.status,
    queued: result?.queued === true,
  };
}

async function pollLoggingExport(input: {
  baseUrl: string;
  tenantId: string;
  timeoutMs: number;
  adminSecret: string;
  exportId: string;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + Math.max(input.timeoutMs, 45_000);
  while (Date.now() < deadline) {
    const response = await remoteJson({
      url: `${input.baseUrl}/api/admin/logging-policies/exports/${encodeURIComponent(input.exportId)}`,
      timeoutMs: input.timeoutMs,
      headers: adminHeaders(input.adminSecret, input.tenantId),
    });
    const item =
      isRecord(response.payload) && isRecord(response.payload.item) ? response.payload.item : null;
    if (response.ok && item) {
      const status = stringValue(item.status);
      if (status === 'completed' || status === 'failed' || status === 'expired') {
        return item;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function pollDiagnosticExport(input: {
  baseUrl: string;
  tenantId: string;
  clientId: string;
  adminSecret: string;
  diagnosticSessionId: string;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(input.timeoutMs, 30_000);
  while (Date.now() < deadline) {
    const exportUrl = new URL('/api/admin/diagnostic-logging/export', input.baseUrl);
    exportUrl.searchParams.set('tenantId', input.tenantId);
    exportUrl.searchParams.set('clientId', input.clientId);
    exportUrl.searchParams.set('categories', 'auth-decision');
    exportUrl.searchParams.set('format', 'json');
    exportUrl.searchParams.set('exportMode', 'full');
    exportUrl.searchParams.set('startDate', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    exportUrl.searchParams.set('endDate', new Date(Date.now() + 10 * 60 * 1000).toISOString());

    const response = await remoteJson({
      url: exportUrl.toString(),
      timeoutMs: input.timeoutMs,
      headers: adminHeaders(input.adminSecret, input.tenantId),
    });

    if (response.ok && isRecord(response.payload)) {
      const logs = arrayValue(response.payload.logs);
      if (
        logs.some(
          (entry) =>
            isRecord(entry) &&
            stringValue(entry.sessionId) === input.diagnosticSessionId &&
            stringValue(entry.event) === 'auth_decision_allow'
        )
      ) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function remoteJson(input: {
  url: string;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return fetchJsonWithTimeout(input.url, input.timeoutMs, {
    method: input.method ?? 'GET',
    headers: input.headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
}

async function createSmokeClient(input: {
  baseUrl: string;
  tenantId: string;
  timeoutMs: number;
  adminSecret: string;
  runId: string;
}): Promise<{ clientId: string; clientSecret: string; responseStatus: number }> {
  const url = `${input.baseUrl}/api/admin/clients`;
  const response = await remoteJson({
    url,
    timeoutMs: input.timeoutMs,
    method: 'POST',
    headers: {
      ...adminHeaders(input.adminSecret, input.tenantId),
      'Idempotency-Key': `remote-logging-smoke-client-${input.runId}`,
    },
    body: {
      client_name: `Remote Logging Smoke ${input.runId}`,
      description: `Temporary client for remote logging output smoke ${input.runId}`,
      redirect_uris: [`${input.baseUrl}/callback/remote-logging-smoke-${input.runId}`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'client_secret_post',
      require_pkce: true,
    },
  });

  if (!response.ok || !isRecord(response.payload) || !isRecord(response.payload.client)) {
    throw new Error(
      `client_create_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
    );
  }

  const clientId = stringValue(response.payload.client.client_id);
  const clientSecret = stringValue(response.payload.client.client_secret);
  if (!clientId || !clientSecret) {
    throw new Error('client_create_response_missing_client_secret');
  }

  return { clientId, clientSecret, responseStatus: response.status };
}

async function deleteSmokeClient(input: {
  baseUrl: string;
  tenantId: string;
  timeoutMs: number;
  adminSecret: string;
  clientId: string;
}): Promise<void> {
  await remoteJson({
    url: `${input.baseUrl}/api/admin/clients/${encodeURIComponent(input.clientId)}`,
    timeoutMs: input.timeoutMs,
    method: 'DELETE',
    headers: adminHeaders(input.adminSecret, input.tenantId),
  });
}

async function runRemoteLoggingSmoke(options: CliOptions): Promise<RemoteLoggingSmokeResult> {
  const runStartedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const target = await resolveGeneratedSmokeTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    timeoutMs,
  });
  const lockLoad = await loadLockFileAuto(target.baseDir, target.env);
  if (!lockLoad.lock) {
    throw new Error(`lock_file_missing:${lockLoad.path}`);
  }
  const apiBaseUrl = target.baseUrl;

  const checks: SmokeCheck[] = [];
  const runId = `rlog-${Date.now().toString(36)}`;
  const adminAccess = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    baseUrl: target.baseUrl,
    tenantId: target.tenantId,
    config: target.config,
  });

  let smokeClient: { clientId: string; clientSecret: string; responseStatus: number } | null = null;

  try {
    const resourceCheck = makeSmokeCheck(
      'remote-logging-resources',
      'Generated remote logging resources are present'
    );
    const diagnosticBucket = lockLoad.lock.r2?.DIAGNOSTIC_LOGS?.name;
    const auditArchiveBucket = lockLoad.lock.r2?.AUDIT_ARCHIVE?.name;
    const sensitiveBucket = lockLoad.lock.r2?.SENSITIVE_DETAILS?.name;
    const exportBucket = lockLoad.lock.r2?.EXPORT_ARTIFACTS?.name;
    if (diagnosticBucket) addPass(resourceCheck, `DIAGNOSTIC_LOGS: ${diagnosticBucket}`);
    else addFail(resourceCheck, 'DIAGNOSTIC_LOGS is missing from lock.json');
    if (auditArchiveBucket) addPass(resourceCheck, `AUDIT_ARCHIVE: ${auditArchiveBucket}`);
    else addFail(resourceCheck, 'AUDIT_ARCHIVE is missing from lock.json');
    if (sensitiveBucket) addPass(resourceCheck, `SENSITIVE_DETAILS: ${sensitiveBucket}`);
    else addFail(resourceCheck, 'SENSITIVE_DETAILS is missing from lock.json');
    if (exportBucket) addPass(resourceCheck, `EXPORT_ARTIFACTS: ${exportBucket}`);
    else addFail(resourceCheck, 'EXPORT_ARTIFACTS is missing from lock.json');
    if (lockLoad.lock.queues?.LOGGING_DELIVERY_CRITICAL_QUEUE?.name) {
      addPass(
        resourceCheck,
        `LOGGING_DELIVERY_CRITICAL_QUEUE: ${lockLoad.lock.queues.LOGGING_DELIVERY_CRITICAL_QUEUE.name}`
      );
    } else {
      addWarn(
        resourceCheck,
        'LOGGING_DELIVERY_CRITICAL_QUEUE is not recorded; queued sensitive-detail writes cannot be verified remotely'
      );
    }
    checks.push(finalizeCheck(resourceCheck, 'Required remote logging resources are present'));

    const clientCheck = makeSmokeCheck(
      'remote-logging-admin-client',
      'Admin API creates a temporary client and emits admin audit',
      `${apiBaseUrl}/api/admin/clients`
    );
    try {
      smokeClient = await createSmokeClient({
        baseUrl: apiBaseUrl,
        tenantId: target.tenantId,
        timeoutMs,
        adminSecret: adminAccess.secret,
        runId,
      });
      clientCheck.httpStatus = smokeClient.responseStatus;
      addPass(clientCheck, `temporary client created: ${smokeClient.clientId}`);
    } catch (error) {
      addFail(clientCheck, error instanceof Error ? error.message : String(error));
    }
    checks.push(finalizeCheck(clientCheck, 'Temporary client was created'));

    if (smokeClient) {
      const auditCheck = makeSmokeCheck(
        'remote-logging-admin-audit-api',
        'Admin audit list returns the temporary client audit event',
        `${apiBaseUrl}/api/admin/admin-audit-log`
      );
      const auditUrl = new URL('/api/admin/admin-audit-log', apiBaseUrl);
      auditUrl.searchParams.set('limit', '20');
      auditUrl.searchParams.set('resource_type', 'client');
      auditUrl.searchParams.set('resource_id', smokeClient.clientId);
      const response = await remoteJson({
        url: auditUrl.toString(),
        timeoutMs,
        headers: adminHeaders(adminAccess.secret, target.tenantId),
      });
      auditCheck.httpStatus = response.status;
      if (response.ok && isRecord(response.payload)) {
        const entries = arrayValue(response.payload.items);
        const matched = entries.some(
          (entry) =>
            isRecord(entry) &&
            stringValue(entry.resource_id) === smokeClient?.clientId &&
            stringValue(entry.action) === 'client.created'
        );
        if (matched) {
          addPass(auditCheck, 'client.created audit entry is visible through Admin API');
        } else {
          addFail(
            auditCheck,
            `client.created audit entry was not found; entries=${entries.length}`
          );
        }
      } else {
        addFail(
          auditCheck,
          `audit_log_fetch_failed:${response.status}:${response.error ?? response.bodyText ?? 'unknown_error'}`
        );
      }
      checks.push(finalizeCheck(auditCheck, 'Admin audit log can be queried'));

      const archiveCheck = makeSmokeCheck(
        'remote-logging-admin-audit-archive',
        'Admin audit writes a canonical D-format archive chunk to AUDIT_ARCHIVE'
      );
      if (!auditArchiveBucket) {
        addFail(archiveCheck, 'AUDIT_ARCHIVE bucket is missing');
      } else if (options.skipR2) {
        addWarn(archiveCheck, '--skip-r2 was set; admin audit archive R2 verification skipped');
      } else {
        try {
          const object = await pollR2Object({
            bucketName: auditArchiveBucket,
            prefix: 'logs/v1/',
            notBeforeMs: runStartedAt - 5_000,
            timeoutMs,
            matches: (item) => isCanonicalAdminAuditArchiveKey(item.key),
          });
          if (object) {
            await assertR2ObjectReadable(auditArchiveBucket, object);
            addPass(archiveCheck, `admin audit archive object listed and read: ${object.key}`);
          } else addFail(archiveCheck, 'no admin_audit archive object observed');
        } catch (error) {
          addFail(archiveCheck, error instanceof Error ? error.message : String(error));
        }
      }
      checks.push(finalizeCheck(archiveCheck, 'Admin audit archive path checked'));

      const detailCheck = makeSmokeCheck(
        'remote-logging-admin-audit-sensitive-detail',
        'Admin audit sensitive-detail externalization is configured'
      );
      if (!sensitiveBucket) {
        addFail(detailCheck, 'SENSITIVE_DETAILS bucket is missing');
      } else if (!lockLoad.lock.queues?.LOGGING_DELIVERY_CRITICAL_QUEUE?.name) {
        addWarn(
          detailCheck,
          'SENSITIVE_DETAILS exists, but queue bindings are not present in lock.json; remote sensitive-detail chunk delivery is not expected in this environment'
        );
      } else if (options.skipR2) {
        addWarn(detailCheck, '--skip-r2 was set; sensitive-detail R2 verification skipped');
      } else {
        try {
          const object = await pollR2Object({
            bucketName: sensitiveBucket,
            prefix: 'sensitive-details/v1/',
            notBeforeMs: runStartedAt - 5_000,
            timeoutMs,
            matches: (item) => isCanonicalAdminAuditSensitiveDetailKey(item.key),
          });
          if (object) {
            await assertR2ObjectReadable(sensitiveBucket, object);
            addPass(detailCheck, `sensitive-detail object listed and read: ${object.key}`);
          } else addWarn(detailCheck, 'no new admin_audit sensitive-detail object observed');
        } catch (error) {
          addFail(detailCheck, error instanceof Error ? error.message : String(error));
        }
      }
      checks.push(finalizeCheck(detailCheck, 'Admin audit sensitive detail path checked'));

      const exportCheck = makeSmokeCheck(
        'remote-logging-b-format-export',
        'B-format ZIP export can be created from canonical D-format archive'
      );
      if (!exportBucket) {
        addFail(exportCheck, 'EXPORT_ARTIFACTS bucket is missing');
      } else {
        try {
          const exportJob = await createLoggingExport({
            baseUrl: apiBaseUrl,
            tenantId: target.tenantId,
            timeoutMs,
            adminSecret: adminAccess.secret,
          });
          exportCheck.httpStatus = exportJob.responseStatus;
          addPass(
            exportCheck,
            `ZIP export job queued: ${exportJob.id} queued=${String(exportJob.queued)}`
          );
          const completed = await pollLoggingExport({
            baseUrl: apiBaseUrl,
            tenantId: target.tenantId,
            timeoutMs,
            adminSecret: adminAccess.secret,
            exportId: exportJob.id,
          });
          const status = completed ? stringValue(completed.status) : null;
          if (status === 'completed') {
            addPass(exportCheck, 'ZIP export job completed');
          } else if (status === 'failed') {
            addFail(exportCheck, `ZIP export job failed: ${stringValue(completed?.error_class)}`);
          } else {
            addWarn(
              exportCheck,
              'ZIP export job is queued; maintenance worker did not complete it within timeout'
            );
          }
        } catch (error) {
          addFail(exportCheck, error instanceof Error ? error.message : String(error));
        }
      }
      checks.push(finalizeCheck(exportCheck, 'B-format export path checked'));

      const diagnosticCheck = makeSmokeCheck(
        'remote-logging-diagnostic-ingest',
        'Diagnostic ingest writes a JSONL chunk to DIAGNOSTIC_LOGS',
        `${apiBaseUrl}/api/v1/diagnostic-logs/ingest`
      );
      const diagnosticLogId = `${runId}-diagnostic-1`;
      const diagnosticResponse = await remoteJson({
        url: `${apiBaseUrl}/api/v1/diagnostic-logs/ingest`,
        timeoutMs,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: apiBaseUrl,
        },
        body: {
          tenant_id: target.tenantId,
          client_id: smokeClient.clientId,
          client_secret: smokeClient.clientSecret,
          logs: [
            {
              id: diagnosticLogId,
              timestamp: Date.now(),
              category: 'auth-decision',
              level: 'info',
              diagnosticSessionId: runId,
              message: 'remote logging output smoke',
              decision: 'allow',
              reason: 'remote logging output smoke',
            },
          ],
        },
      });
      diagnosticCheck.httpStatus = diagnosticResponse.status;
      const written =
        isRecord(diagnosticResponse.payload) &&
        numberValue(diagnosticResponse.payload.entriesWritten);
      if (diagnosticResponse.ok && written === 1) {
        addPass(diagnosticCheck, 'diagnostic ingest accepted one entry');
      } else {
        addFail(
          diagnosticCheck,
          `diagnostic_ingest_failed:${diagnosticResponse.status}:${diagnosticResponse.error ?? diagnosticResponse.bodyText ?? 'unknown_error'}`
        );
      }

      if (!diagnosticBucket) {
        addFail(diagnosticCheck, 'DIAGNOSTIC_LOGS bucket is missing');
      } else if (options.skipR2) {
        addWarn(diagnosticCheck, '--skip-r2 was set; diagnostic R2 verification skipped');
      } else if (diagnosticResponse.ok) {
        try {
          const exported = await pollDiagnosticExport({
            baseUrl: apiBaseUrl,
            tenantId: target.tenantId,
            clientId: smokeClient.clientId,
            adminSecret: adminAccess.secret,
            diagnosticSessionId: runId,
            timeoutMs,
          });
          if (exported) {
            addPass(diagnosticCheck, 'diagnostic entry exported from DIAGNOSTIC_LOGS');
          } else {
            addFail(diagnosticCheck, 'diagnostic JSONL entry was not exported from R2');
          }
        } catch (error) {
          addFail(diagnosticCheck, error instanceof Error ? error.message : String(error));
        }
      }
      checks.push(finalizeCheck(diagnosticCheck, 'Diagnostic ingest path checked'));

      const dbCheck = makeSmokeCheck(
        'remote-logging-admin-db',
        'Admin DB contains the temporary client audit row'
      );
      try {
        const dbName = lockLoad.lock.d1.DB_ADMIN?.name ?? getD1DatabaseName(target.env, 'admin-db');
        const sql = `SELECT id, action, resource_type, resource_id, detail_object_catalog_id FROM admin_audit_log WHERE tenant_id = '${target.tenantId.replace(/'/g, "''")}' AND resource_id = '${smokeClient.clientId.replace(/'/g, "''")}' ORDER BY created_at DESC LIMIT 5`;
        const result = await execa(
          'wrangler',
          ['d1', 'execute', dbName, '--remote', '--yes', '--json', '--command', sql],
          {
            all: true,
            reject: false,
            timeout: 30_000,
            env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
          }
        );
        if (result.exitCode !== 0) {
          addFail(
            dbCheck,
            result.all || result.stderr || result.stdout || 'wrangler_d1_query_failed'
          );
        } else {
          const rows = parseD1Rows(result.stdout);
          const hasCreated = rows.some(
            (row) =>
              row.action === 'client.created' &&
              row.resource_type === 'client' &&
              row.resource_id === smokeClient?.clientId
          );
          if (hasCreated) {
            addPass(dbCheck, `admin_audit_log row found in ${dbName}`);
          } else {
            addFail(dbCheck, `admin_audit_log row was not found in ${dbName}`);
          }
          const hasExternalDetail = rows.some(
            (row) =>
              typeof row.detail_object_catalog_id === 'string' && row.detail_object_catalog_id
          );
          if (hasExternalDetail) {
            addPass(dbCheck, 'admin_audit_log.detail_object_catalog_id is populated');
          } else {
            addWarn(dbCheck, 'admin_audit_log.detail_object_catalog_id is not populated');
          }
        }
      } catch (error) {
        addFail(dbCheck, error instanceof Error ? error.message : String(error));
      }
      checks.push(finalizeCheck(dbCheck, 'Admin DB audit row checked'));
    }
  } finally {
    if (smokeClient) {
      await deleteSmokeClient({
        baseUrl: apiBaseUrl,
        tenantId: target.tenantId,
        timeoutMs,
        adminSecret: adminAccess.secret,
        clientId: smokeClient.clientId,
      });
    }
    await adminAccess.cleanup?.();
  }

  return {
    ok: isSmokeSuccessful(checks),
    env: target.env,
    baseUrl: apiBaseUrl,
    tenantId: target.tenantId,
    configPath: target.configPath,
    lockPath: lockLoad.path,
    adminSecretPath: adminAccess.path,
    runId,
    checks,
  };
}

function parseD1Rows(stdout: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) =>
      isRecord(entry) && Array.isArray(entry.results)
        ? entry.results.filter(isRecord)
        : isRecord(entry)
          ? [entry]
          : []
    );
  }
  if (isRecord(parsed) && Array.isArray(parsed.results)) {
    return parsed.results.filter(isRecord);
  }
  return [];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runRemoteLoggingSmoke(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printChecklist(result);
  }

  process.exitCode = result.ok ? 0 : 1;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`remote logging output smoke failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
