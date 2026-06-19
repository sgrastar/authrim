#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { execa } from 'execa';
import { resolveGeneratedSmokeTarget } from '../../packages/setup/src/core/generated-smoke-common.js';
import { getD1DatabaseName } from '../../packages/setup/src/core/naming.js';

type D1Mode = 'remote' | 'local';
type ScopeType = 'global' | 'tenant';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  uiOrigin?: string;
  ttlMinutes: number;
  roleName: string;
  scopeType: ScopeType;
  email?: string;
  name: string;
  mode: D1Mode;
  persistTo?: string;
  cleanupRunId?: string;
  cleanupExpired: boolean;
  json: boolean;
  dryRun: boolean;
}

interface D1ExecutionResult {
  all: string;
  json?: unknown;
}

interface VerificationCounts {
  adminUserCount: number;
  roleAssignmentCount: number;
  sessionCount: number;
}

const TOOL_ID = 'admin-ui-session-tool';
const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 8 * 60;

function printUsage(): void {
  process.stdout.write(`Authrim Admin UI session issuer

Usage:
  pnpm run admin-ui:issue-session -- --env <env> [--ui-origin http://127.0.0.1:5177]
  pnpm run admin-ui:issue-session -- --config <path/to/.authrim/{env}/config.json>
  pnpm run admin-ui:issue-session -- --env <env> --cleanup <run-id>
  pnpm run admin-ui:issue-session -- --env <env> --cleanup-expired

Options:
  --env <env>              Resolve the generated environment from .authrim/{env}
  --config <path>          Read a generated config.json directly
  --base-dir <path>        Override repository base directory
  --ui-origin <origin>     UI origin to print in browser instructions
  --ttl-minutes <n>        Session lifetime, 1-${MAX_TTL_MINUTES} minutes (default: ${DEFAULT_TTL_MINUTES})
  --role <name>            Existing admin role to assign (default: super_admin)
  --scope <global|tenant>  Assignment scope (default: global)
  --email <email>          Override temporary admin email
  --name <name>            Temporary admin display name
  --remote                 Execute against remote D1 (default)
  --local                  Execute against local Wrangler D1
  --persist-to <path>      Local D1 persistence path when using --local
  --cleanup <run-id>       Delete rows created for a specific run ID
  --cleanup-expired        Delete expired rows created by this tool
  --dry-run                Print SQL instead of executing it
  --json                   Emit JSON output
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    ttlMinutes: DEFAULT_TTL_MINUTES,
    roleName: 'super_admin',
    scopeType: 'global',
    name: 'Authrim UI Validation Admin',
    mode: 'remote',
    cleanupExpired: false,
    json: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--env') {
      options.env = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--config') {
      options.configPath = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--base-dir') {
      options.baseDir = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--ui-origin') {
      options.uiOrigin = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--ttl-minutes') {
      options.ttlMinutes = Number.parseInt(readValue(argv, index, arg), 10);
      index += 1;
      continue;
    }
    if (arg === '--role') {
      options.roleName = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--scope') {
      const scope = readValue(argv, index, arg);
      if (scope !== 'global' && scope !== 'tenant') {
        throw new Error(`invalid_scope:${scope}`);
      }
      options.scopeType = scope;
      index += 1;
      continue;
    }
    if (arg === '--email') {
      options.email = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--name') {
      options.name = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--remote') {
      options.mode = 'remote';
      continue;
    }
    if (arg === '--local') {
      options.mode = 'local';
      continue;
    }
    if (arg === '--persist-to') {
      options.persistTo = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--cleanup') {
      options.cleanupRunId = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--cleanup-expired') {
      options.cleanupExpired = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
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

  validateOptions(options);
  return options;
}

function readValue(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`missing_value:${arg}`);
  }
  return value;
}

function validateOptions(options: CliOptions): void {
  if (!Number.isInteger(options.ttlMinutes)) {
    throw new Error('ttl_minutes_must_be_integer');
  }
  if (options.ttlMinutes < 1 || options.ttlMinutes > MAX_TTL_MINUTES) {
    throw new Error(`ttl_minutes_out_of_range:1-${MAX_TTL_MINUTES}`);
  }
  if (options.cleanupRunId && options.cleanupExpired) {
    throw new Error('cleanup_and_cleanup_expired_are_mutually_exclusive');
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(options.roleName)) {
    throw new Error('role_name_contains_unsupported_characters');
  }
  if (options.email && !options.email.includes('@')) {
    throw new Error('email_must_contain_at_sign');
  }
}

function makeRunId(): string {
  return `${Date.now()}_${randomBytes(6).toString('hex')}`;
}

function sanitizeRunId(runId: string): string {
  const sanitized = runId.replace(/[^A-Za-z0-9_:-]/g, '_');
  if (!sanitized || sanitized.length > 96) {
    throw new Error('invalid_run_id');
  }
  return sanitized;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableString(value: string | null): string {
  return value === null ? 'NULL' : sqlString(value);
}

function buildIds(runId: string): {
  adminUserId: string;
  assignmentId: string;
  sessionId: string;
  email: string;
} {
  const safeRunId = sanitizeRunId(runId);
  return {
    adminUserId: `au_authrim_ui_validation_${safeRunId}`,
    assignmentId: `ara_authrim_ui_validation_${safeRunId}`,
    sessionId: `authrim_ui_validation_${safeRunId}`,
    email: `authrim-ui-validation+${safeRunId}@example.invalid`,
  };
}

function buildIssueSql(input: {
  runId: string;
  tenantId: string;
  email: string;
  name: string;
  roleName: string;
  scopeType: ScopeType;
  nowMs: number;
  expiresAtMs: number;
}): string {
  const ids = buildIds(input.runId);
  const scopeId = input.scopeType === 'tenant' ? input.tenantId : null;

  return `
INSERT INTO admin_users (
  id, tenant_id, email, email_verified, name, password_hash,
  is_active, status, mfa_enabled, mfa_method, totp_secret_encrypted,
  last_login_at, last_login_ip, failed_login_count, locked_until,
  created_by, created_at, updated_at
) VALUES (
  ${sqlString(ids.adminUserId)},
  ${sqlString(input.tenantId)},
  ${sqlString(input.email)},
  1,
  ${sqlString(input.name)},
  NULL,
  1,
  'active',
  1,
  'passkey',
  NULL,
  ${input.nowMs},
  '127.0.0.1',
  0,
  NULL,
  ${sqlString(TOOL_ID)},
  ${input.nowMs},
  ${input.nowMs}
);

INSERT INTO admin_role_assignments (
  id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id,
  expires_at, assigned_by, created_at
)
SELECT
  ${sqlString(ids.assignmentId)},
  ${sqlString(input.tenantId)},
  ${sqlString(ids.adminUserId)},
  role.id,
  ${sqlString(input.scopeType)},
  ${sqlNullableString(scopeId)},
  ${input.expiresAtMs},
  ${sqlString(TOOL_ID)},
  ${input.nowMs}
FROM (
  SELECT id
    FROM admin_roles
   WHERE name = ${sqlString(input.roleName)}
     AND (
       tenant_id = ${sqlString(input.tenantId)}
       OR (tenant_id = 'default' AND is_system = 1)
     )
   ORDER BY CASE WHEN tenant_id = ${sqlString(input.tenantId)} THEN 0 ELSE 1 END
   LIMIT 1
) role;

INSERT INTO admin_sessions (
  id, tenant_id, admin_user_id, ip_address, user_agent,
  created_at, expires_at, last_activity_at, mfa_verified, mfa_verified_at
) VALUES (
  ${sqlString(ids.sessionId)},
  ${sqlString(input.tenantId)},
  ${sqlString(ids.adminUserId)},
  '127.0.0.1',
  'Authrim Admin UI session tool',
  ${input.nowMs},
  ${input.expiresAtMs},
  ${input.nowMs},
  1,
  ${input.nowMs}
);
`.trim();
}

function buildVerifySql(input: { runId: string; nowMs: number; tenantId: string }): string {
  const ids = buildIds(input.runId);
  return `
SELECT
  (SELECT COUNT(*) FROM admin_users WHERE id = ${sqlString(ids.adminUserId)} AND tenant_id = ${sqlString(input.tenantId)}) AS admin_user_count,
  (SELECT COUNT(*) FROM admin_role_assignments WHERE id = ${sqlString(ids.assignmentId)} AND tenant_id = ${sqlString(input.tenantId)}) AS role_assignment_count,
  (SELECT COUNT(*) FROM admin_sessions WHERE id = ${sqlString(ids.sessionId)} AND tenant_id = ${sqlString(input.tenantId)} AND expires_at > ${input.nowMs}) AS session_count;
`.trim();
}

function buildCleanupSql(runId: string): string {
  const ids = buildIds(runId);
  return `
DELETE FROM admin_sessions
 WHERE id = ${sqlString(ids.sessionId)};

DELETE FROM admin_role_assignments
 WHERE id = ${sqlString(ids.assignmentId)};

DELETE FROM admin_users
 WHERE id = ${sqlString(ids.adminUserId)}
   AND created_by = ${sqlString(TOOL_ID)};
`.trim();
}

function buildCleanupExpiredSql(nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  return `
DELETE FROM admin_sessions
 WHERE id LIKE 'authrim_ui_validation_%'
   AND expires_at <= ${nowMs};

DELETE FROM admin_role_assignments
 WHERE id LIKE 'ara_authrim_ui_validation_%'
   AND assigned_by = ${sqlString(TOOL_ID)}
   AND expires_at IS NOT NULL
   AND expires_at <= ${nowSeconds};

DELETE FROM admin_users
 WHERE id LIKE 'au_authrim_ui_validation_%'
   AND created_by = ${sqlString(TOOL_ID)}
   AND NOT EXISTS (
     SELECT 1
       FROM admin_sessions
      WHERE admin_sessions.admin_user_id = admin_users.id
        AND admin_sessions.expires_at > ${nowMs}
   );
`.trim();
}

async function executeD1(options: {
  databaseName: string;
  mode: D1Mode;
  persistTo?: string;
  sql: string;
  json?: boolean;
}): Promise<D1ExecutionResult> {
  const args = ['d1', 'execute', options.databaseName, '--yes', `--${options.mode}`];
  if (options.persistTo) {
    args.push('--persist-to', options.persistTo);
  }
  if (options.json) {
    args.push('--json');
  }
  args.push('--command', options.sql);

  const result = await execa('wrangler', args, {
    all: true,
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`wrangler_d1_execute_failed:${result.all || result.stderr || result.stdout}`);
  }

  const all = result.all || result.stdout || '';
  if (!options.json) {
    return { all };
  }
  try {
    return { all, json: JSON.parse(result.stdout || all) as unknown };
  } catch (error) {
    throw new Error(
      `wrangler_d1_json_parse_failed:${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const rows = extractRows(item);
      if (rows.length > 0) {
        return rows;
      }
    }
  }
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      return record.results.filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    }
    if (Array.isArray(record.result)) {
      return extractRows(record.result);
    }
  }
  return [];
}

function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    return Number.parseInt(value, 10);
  }
  return 0;
}

function parseVerificationCounts(payload: unknown): VerificationCounts {
  const [row] = extractRows(payload);
  return {
    adminUserCount: toCount(row?.admin_user_count),
    roleAssignmentCount: toCount(row?.role_assignment_count),
    sessionCount: toCount(row?.session_count),
  };
}

function assertVerificationCounts(counts: VerificationCounts): void {
  const failures: string[] = [];
  if (counts.adminUserCount !== 1) {
    failures.push(`admin_user_count=${counts.adminUserCount}`);
  }
  if (counts.roleAssignmentCount !== 1) {
    failures.push(`role_assignment_count=${counts.roleAssignmentCount}`);
  }
  if (counts.sessionCount !== 1) {
    failures.push(`session_count=${counts.sessionCount}`);
  }
  if (failures.length > 0) {
    throw new Error(`session_issue_verification_failed:${failures.join(',')}`);
  }
}

function printIssueResult(input: {
  env: string;
  databaseName: string;
  mode: D1Mode;
  baseUrl: string;
  uiOrigin?: string;
  runId: string;
  sessionId: string;
  email: string;
  expiresAtMs: number;
  cleanupCommand: string;
  json: boolean;
}): void {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          env: input.env,
          databaseName: input.databaseName,
          mode: input.mode,
          baseUrl: input.baseUrl,
          uiOrigin: input.uiOrigin,
          runId: input.runId,
          email: input.email,
          cookieName: 'authrim_admin_session',
          cookieValue: input.sessionId,
          cookieHeader: `authrim_admin_session=${input.sessionId}`,
          expiresAt: new Date(input.expiresAtMs).toISOString(),
          cleanupCommand: input.cleanupCommand,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`\nAuthrim Admin UI session issued\n`);
  process.stdout.write(`env: ${input.env}\n`);
  process.stdout.write(`database: ${input.databaseName} (${input.mode})\n`);
  process.stdout.write(`baseUrl: ${input.baseUrl}\n`);
  if (input.uiOrigin) {
    process.stdout.write(`uiOrigin: ${input.uiOrigin}\n`);
  }
  process.stdout.write(`runId: ${input.runId}\n`);
  process.stdout.write(`email: ${input.email}\n`);
  process.stdout.write(`expiresAt: ${new Date(input.expiresAtMs).toISOString()}\n\n`);
  process.stdout.write(`cookie:\n`);
  process.stdout.write(`  authrim_admin_session=${input.sessionId}\n\n`);
  process.stdout.write(`cleanup:\n`);
  process.stdout.write(`  ${input.cleanupCommand}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = await resolveGeneratedSmokeTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
  });
  const databaseName = getD1DatabaseName(target.env, 'admin-db');

  if (options.cleanupRunId) {
    const cleanupSql = buildCleanupSql(options.cleanupRunId);
    if (options.dryRun) {
      process.stdout.write(`${cleanupSql}\n`);
      return;
    }
    await executeD1({
      databaseName,
      mode: options.mode,
      persistTo: options.persistTo,
      sql: cleanupSql,
    });
    process.stdout.write(`Cleaned up Admin UI session run: ${options.cleanupRunId}\n`);
    return;
  }

  if (options.cleanupExpired) {
    const cleanupSql = buildCleanupExpiredSql(Date.now());
    if (options.dryRun) {
      process.stdout.write(`${cleanupSql}\n`);
      return;
    }
    await executeD1({
      databaseName,
      mode: options.mode,
      persistTo: options.persistTo,
      sql: cleanupSql,
    });
    process.stdout.write(`Cleaned up expired Admin UI session tool rows for env: ${target.env}\n`);
    return;
  }

  const runId = makeRunId();
  const ids = buildIds(runId);
  const nowMs = Date.now();
  const expiresAtMs = nowMs + options.ttlMinutes * 60 * 1000;
  const email = options.email ?? ids.email;
  const issueSql = buildIssueSql({
    runId,
    tenantId: target.tenantId,
    email,
    name: options.name,
    roleName: options.roleName,
    scopeType: options.scopeType,
    nowMs,
    expiresAtMs,
  });
  const verifySql = buildVerifySql({ runId, nowMs, tenantId: target.tenantId });
  const cleanupCommand = `pnpm run admin-ui:issue-session -- --env ${target.env} --cleanup ${runId}${options.mode === 'local' ? ' --local' : ''}`;

  if (options.dryRun) {
    process.stdout.write(`${issueSql}\n\n${verifySql}\n`);
    return;
  }

  try {
    await executeD1({
      databaseName,
      mode: options.mode,
      persistTo: options.persistTo,
      sql: issueSql,
    });
    const verification = await executeD1({
      databaseName,
      mode: options.mode,
      persistTo: options.persistTo,
      sql: verifySql,
      json: true,
    });
    const counts = parseVerificationCounts(verification.json);
    assertVerificationCounts(counts);
  } catch (error) {
    await executeD1({
      databaseName,
      mode: options.mode,
      persistTo: options.persistTo,
      sql: buildCleanupSql(runId),
    }).catch(() => {
      // Cleanup is best-effort after issue failure.
    });
    throw error;
  }

  printIssueResult({
    env: target.env,
    databaseName,
    mode: options.mode,
    baseUrl: target.baseUrl,
    uiOrigin: options.uiOrigin,
    runId,
    sessionId: ids.sessionId,
    email,
    expiresAtMs,
    cleanupCommand,
    json: options.json,
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`admin-ui session tool failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
