#!/usr/bin/env node

import process from 'node:process';
import {
  runGeneratedLoadAbuse,
  type GeneratedLoadAbuseResult,
} from '../../packages/setup/src/core/generated-load-abuse.js';

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
  profile?: 'safe' | 'medium';
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, profile: 'safe' };

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
    if (arg === '--profile') {
      const profile = argv[index + 1];
      if (profile !== 'safe' && profile !== 'medium') {
        throw new Error(`invalid_profile:${profile}`);
      }
      options.profile = profile;
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
  process.stdout.write(`Authrim generated live-safe load / abuse / concurrency runner

Usage:
  pnpm exec tsx test/environment-validation/load-generated-live-safe.ts --env <env>
  pnpm exec tsx test/environment-validation/load-generated-live-safe.ts --config <path/to/.authrim/{env}/config.json>

Options:
  --env <env>                      Resolve the generated environment from .authrim/{env}
  --config <path>                  Read a generated config.json directly
  --base-dir <path>                Override repository base directory
  --timeout-ms <n>                 Request timeout per endpoint (default: 10000)
  --admin-secret <token>           Use a short-lived scoped Admin Machine Access token inline
  --admin-secret-file <p>          Read a scoped Admin Machine Access token from a file
  --client-id <id>                 Existing service client_id to reuse (optional)
  --client-secret <secret>         client_secret for an existing client_id (optional)
  --subject-token-expires-in <n>   TTL for issued subject tokens (default: 900)
  --profile <safe|medium>          Stage profile (default: safe)
  --json                           Emit JSON instead of checklist text
`);
}

function printResult(result: GeneratedLoadAbuseResult): void {
  process.stdout.write(`\nAuthrim generated live-safe load / abuse / concurrency\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseUrl: ${result.baseUrl}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  process.stdout.write(`profile: ${result.profile}\n\n`);

  if (result.bootstrapChecks.length > 0) {
    process.stdout.write(`bootstrap:\n`);
    for (const note of result.bootstrapChecks) {
      process.stdout.write(`  - ${note}\n`);
    }
    process.stdout.write(`\n`);
  }

  for (const stage of result.stages) {
    process.stdout.write(`- ${stage.title}\n`);
    process.stdout.write(
      `  requests=${stage.totalRequests} success=${stage.successCount} fail=${stage.failureCount} successRate=${(
        stage.successRate * 100
      ).toFixed(2)}%\n`
    );
    process.stdout.write(
      `  latency(avg/p50/p95/p99/max ms)=` +
        `${stage.latencyMs.avg.toFixed(1)}/${stage.latencyMs.p50.toFixed(1)}/` +
        `${stage.latencyMs.p95.toFixed(1)}/${stage.latencyMs.p99.toFixed(1)}/${stage.latencyMs.max.toFixed(1)}\n`
    );
    process.stdout.write(`  statuses=${JSON.stringify(stage.statusCounts)}\n`);
    if (stage.failureSamples.length > 0) {
      process.stdout.write(`  failureSamples=${JSON.stringify(stage.failureSamples)}\n`);
    }
  }

  if (result.cleanupNotes.length > 0) {
    process.stdout.write(`\ncleanup:\n`);
    for (const note of result.cleanupNotes) {
      process.stdout.write(`  - ${note}\n`);
    }
  }

  process.stdout.write(`\nresult: ${result.ok ? 'OK' : 'FAILED'}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runGeneratedLoadAbuse({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    timeoutMs: options.timeoutMs,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    subjectTokenExpiresIn: options.subjectTokenExpiresIn,
    profile: options.profile,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printResult(result);
  }

  process.exitCode = result.ok ? 0 : 1;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`generated live-safe load runner failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
