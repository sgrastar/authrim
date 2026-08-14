#!/usr/bin/env node

import process from 'node:process';
import {
  runGeneratedApprovalsSmoke,
  type GeneratedApprovalsSmokeResult,
} from '../../packages/setup/src/core/generated-approvals-smoke.js';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  timeoutMs?: number;
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
  clientSecret?: string;
  subjectTokenExpiresIn?: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    if (arg === '--client-id') {
      options.clientId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--client-secret') {
      options.clientSecret = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--subject-token-expires-in') {
      options.subjectTokenExpiresIn = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
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
  process.stdout.write(`Authrim generated approvals smoke checker

Usage:
  pnpm exec tsx test/generated-environment/smoke-generated-approvals.ts --env <env>
  pnpm exec tsx test/generated-environment/smoke-generated-approvals.ts --config <path/to/.authrim/{env}/config.json>

Options:
  --env <env>                      Resolve the generated environment from .authrim/{env}
  --config <path>                  Read a generated config.json directly
  --base-dir <path>                Override repository base directory
  --timeout-ms <n>                 Request timeout per endpoint (default: 10000)
  --admin-secret <token>           Use a short-lived scoped Admin Machine Access token inline
  --admin-secret-file <p>          Read a scoped Admin Machine Access token from a file
  --client-id <id>                 Existing client_id to reuse (optional)
  --client-secret <secret>         client_secret for an existing client_id (optional)
  --subject-token-expires-in <n>   TTL for issued subject tokens (default: 180)
  --json                           Emit JSON instead of checklist text
`);
}

function label(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'pass') return '[PASS]';
  if (status === 'warn') return '[WARN]';
  return '[FAIL]';
}

function printChecklist(result: GeneratedApprovalsSmokeResult): void {
  process.stdout.write(`\nAuthrim generated approvals smoke\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseUrl: ${result.baseUrl}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  process.stdout.write(`adminSecret: ${result.adminSecretPath}\n`);
  if (result.requestId) {
    process.stdout.write(`requestId: ${result.requestId}\n`);
  }
  if (result.grantId) {
    process.stdout.write(`grantId: ${result.grantId}\n`);
  }
  if (result.userId) {
    process.stdout.write(`userId: ${result.userId}\n`);
  }
  process.stdout.write('\n');

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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runGeneratedApprovalsSmoke({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    timeoutMs: options.timeoutMs,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    subjectTokenExpiresIn: options.subjectTokenExpiresIn,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printChecklist(result);
  }

  process.exitCode = result.ok ? 0 : 1;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`generated approvals smoke failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
