#!/usr/bin/env node

import process from 'node:process';
import {
  runGeneratedLocalCapacity,
  type GeneratedLocalCapacityResult,
  type GeneratedLocalCapacityScenario,
} from '../../packages/setup/src/core/generated-local-capacity.js';

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
  scenario?: GeneratedLocalCapacityScenario;
  lps?: number;
  durationSeconds?: number;
  maxInFlight?: number;
  json: boolean;
}

function parseNumber(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

function parseScenario(value: string | undefined): GeneratedLocalCapacityScenario {
  switch (value) {
    case 'registration-fields':
    case 'protected-resource':
    case 'token-exchange':
    case 'introspection':
    case 'mixed':
      return value;
    default:
      throw new Error(`invalid_scenario:${value}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };

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
      options.timeoutMs = parseNumber(argv[index + 1], 'timeout_ms');
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
      options.subjectTokenExpiresIn = parseNumber(argv[index + 1], 'subject_token_expires_in');
      index += 1;
      continue;
    }
    if (arg === '--scenario') {
      options.scenario = parseScenario(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--lps') {
      options.lps = parseNumber(argv[index + 1], 'lps');
      index += 1;
      continue;
    }
    if (arg === '--duration-seconds') {
      options.durationSeconds = parseNumber(argv[index + 1], 'duration_seconds');
      index += 1;
      continue;
    }
    if (arg === '--max-in-flight') {
      options.maxInFlight = parseNumber(argv[index + 1], 'max_in_flight');
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
  process.stdout.write(`Authrim local fixed-LPS capacity runner

Usage:
  pnpm exec tsx test/generated-environment/local-capacity.ts --env <env> --lps 100 --duration-seconds 30
  pnpm exec tsx test/generated-environment/local-capacity.ts --config <path/to/.authrim/{env}/config.json> --scenario protected-resource --lps 150

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
  --scenario <name>                registration-fields | protected-resource | token-exchange | introspection | mixed
  --lps <n>                        Target local requests per second (default: 25, max: 500)
  --duration-seconds <n>           Test duration (default: 30, max: 300)
  --max-in-flight <n>              Max concurrent in-flight requests (default: max(50, lps*4))
  --json                           Emit JSON instead of text
`);
}

function printResult(result: GeneratedLocalCapacityResult): void {
  process.stdout.write(`\nAuthrim local fixed-LPS capacity\n`);
  process.stdout.write(`env: ${result.env}\n`);
  process.stdout.write(`baseUrl: ${result.baseUrl}\n`);
  process.stdout.write(`config: ${result.configPath}\n`);
  process.stdout.write(`scenario: ${result.scenario}\n`);
  process.stdout.write(
    `targetLps=${result.requestedLps} achievedLps=${result.achievedLps.toFixed(2)} duration=${result.durationSeconds}s\n\n`
  );

  process.stdout.write(
    `requests=${result.totalRequests} success=${result.successCount} fail=${result.failureCount} successRate=${(
      result.successRate * 100
    ).toFixed(2)}%\n`
  );
  process.stdout.write(
    `latency(avg/p50/p95/p99/max ms)=` +
      `${result.latencyMs.avg.toFixed(1)}/${result.latencyMs.p50.toFixed(1)}/` +
      `${result.latencyMs.p95.toFixed(1)}/${result.latencyMs.p99.toFixed(1)}/${result.latencyMs.max.toFixed(1)}\n`
  );
  process.stdout.write(`statuses=${JSON.stringify(result.statusCounts)}\n`);

  if (result.failureSamples.length > 0) {
    process.stdout.write(`failureSamples=${JSON.stringify(result.failureSamples)}\n`);
  }

  process.stdout.write(`\nnotes:\n`);
  for (const note of result.localCapacityNotes) {
    process.stdout.write(`  - ${note}\n`);
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
  const result = await runGeneratedLocalCapacity({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    timeoutMs: options.timeoutMs,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    subjectTokenExpiresIn: options.subjectTokenExpiresIn,
    scenario: options.scenario,
    lps: options.lps,
    durationSeconds: options.durationSeconds,
    maxInFlight: options.maxInFlight,
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
  process.stderr.write(`local capacity runner failed: ${message}\n`);
  printUsage();
  process.exitCode = 1;
});
