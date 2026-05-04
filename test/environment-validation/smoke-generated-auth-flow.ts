#!/usr/bin/env node

import process from 'node:process';
import {
  runGeneratedAuthFlowSmoke,
  type ClientCredentialsMode,
  type GeneratedAuthFlowSmokeResult,
} from '../../packages/setup/src/core/generated-auth-flow-smoke.js';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  timeoutMs?: number;
  redirectUri?: string;
  clientCredentialsMode?: ClientCredentialsMode;
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
    if (arg === '--redirect-uri') {
      options.redirectUri = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--client-credentials') {
      const mode = argv[index + 1] as ClientCredentialsMode | undefined;
      if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
        throw new Error(`invalid_client_credentials_mode:${String(mode)}`);
      }
      options.clientCredentialsMode = mode;
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
  process.stdout.write(`Authrim generated auth flow smoke checker

Usage:
  pnpm exec tsx test/environment-validation/smoke-generated-auth-flow.ts --env <env>
  pnpm exec tsx test/environment-validation/smoke-generated-auth-flow.ts --config <path/to/.authrim/{env}/config.json>

Options:
  --env <env>                   Resolve the generated environment from .authrim/{env}
  --config <path>               Read a generated config.json directly
  --base-dir <path>             Override repository base directory
  --timeout-ms <n>              Request timeout per endpoint (default: 10000)
  --redirect-uri <uri>          Override the temporary DCR redirect_uri
  --client-credentials <mode>   auto | on | off (default: auto)
  --json                        Emit JSON instead of checklist text
`);
}

function label(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'pass') return '[PASS]';
  if (status === 'warn') return '[WARN]';
  return '[FAIL]';
}

function printChecklist(result: GeneratedAuthFlowSmokeResult): void {
  process.stdout.write(`\nAuthrim generated auth flow smoke\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseUrl: ${result.baseUrl}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  if (result.clientId) {
    process.stdout.write(`clientId: ${result.clientId}\n`);
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
  const result = await runGeneratedAuthFlowSmoke({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    timeoutMs: options.timeoutMs,
    redirectUri: options.redirectUri,
    clientCredentialsMode: options.clientCredentialsMode,
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
  process.stderr.write(`generated auth flow smoke failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
