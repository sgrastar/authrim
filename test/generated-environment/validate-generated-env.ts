#!/usr/bin/env node

import process from 'node:process';
import {
  resolveGeneratedEnvValidationTarget,
  validateGeneratedEnvironment,
  type GeneratedEnvValidationResult,
} from '../../packages/setup/src/core/generated-env-validator.js';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  keysBaseDir?: string;
  json: boolean;
  liveCloudflare: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, liveCloudflare: false };

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
    if (arg === '--keys-base-dir') {
      options.keysBaseDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--live-cloudflare') {
      options.liveCloudflare = true;
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
  process.stdout.write(`Authrim generated environment validator

Usage:
  pnpm exec tsx test/generated-environment/validate-generated-env.ts --env <env>
  pnpm exec tsx test/generated-environment/validate-generated-env.ts --config <path/to/.authrim/{env}/config.json>

Options:
  --env <env>         Validate .authrim/{env}/config.json and related files
  --config <path>     Validate a generated config.json directly
  --base-dir <path>   Override repository base directory
  --keys-base-dir <path>
                       Base directory for external .authrim-keys/{env}/ secrets
  --live-cloudflare   Also verify lock.json D1/R2 resources against Cloudflare with read-only wrangler calls
  --json              Emit JSON instead of checklist text
`);
}

function statusLabel(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'pass') {
    return '[PASS]';
  }
  if (status === 'warn') {
    return '[WARN]';
  }
  return '[FAIL]';
}

function printChecklist(result: GeneratedEnvValidationResult): void {
  process.stdout.write(`\nAuthrim generated environment check\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseDir: ${result.baseDir}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  process.stdout.write(`lock: ${result.lockPath} (${result.lockType})\n`);
  process.stdout.write(`enabled components: ${result.enabledComponents.join(', ')}\n\n`);

  for (const check of result.checks) {
    process.stdout.write(`${statusLabel(check.status)} ${check.title}\n`);
    for (const detail of check.details) {
      process.stdout.write(`  - ${detail}\n`);
    }
  }

  process.stdout.write(`\nresult: ${result.ok ? 'OK' : 'FAILED'}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveGeneratedEnvValidationTarget({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
  });
  const result = await validateGeneratedEnvironment({
    baseDir: target.baseDir,
    env: target.env,
    configPath: target.configPath,
    keysBaseDir: options.keysBaseDir,
    liveCloudflare: options.liveCloudflare,
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
  process.stderr.write(`generated env validation failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
