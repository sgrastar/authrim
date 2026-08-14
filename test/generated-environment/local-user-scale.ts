#!/usr/bin/env node

import process from 'node:process';
import {
  runLocalUserScaleBenchmark,
  type LocalUserScaleBenchmarkResult,
  type LocalUserScaleScenario,
} from '../../packages/setup/src/core/local-user-scale-benchmark.js';

interface CliOptions {
  baseDir?: string;
  env?: string;
  configPath?: string;
  users?: number;
  tenantCount?: number;
  targetTenant?: string;
  dbPath?: string;
  fresh?: boolean;
  queryIterations?: number;
  scenario?: LocalUserScaleScenario;
  json: boolean;
}

function parseNumber(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

function parseScenario(value: string | undefined): LocalUserScaleScenario {
  switch (value) {
    case 'admin-list':
    case 'pii-search':
    case 'domain-lookup':
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
    if (arg === '--users') {
      options.users = parseNumber(argv[index + 1], 'users');
      index += 1;
      continue;
    }
    if (arg === '--tenant-count') {
      options.tenantCount = parseNumber(argv[index + 1], 'tenant_count');
      index += 1;
      continue;
    }
    if (arg === '--target-tenant') {
      options.targetTenant = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--db-path') {
      options.dbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--fresh') {
      options.fresh = true;
      continue;
    }
    if (arg === '--query-iterations') {
      options.queryIterations = parseNumber(argv[index + 1], 'query_iterations');
      index += 1;
      continue;
    }
    if (arg === '--scenario') {
      options.scenario = parseScenario(argv[index + 1]);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function printUsage(): void {
  process.stdout.write(`Authrim Mac-local synthetic user-scale benchmark

Usage:
  pnpm setup:local-user-scale -- --env single --users 1000000 --tenant-count 200 --scenario mixed
  pnpm setup:local-user-scale -- --config <path/to/.authrim/{env}/config.json> --users 1000000
  pnpm setup:local-user-scale -- --users 1000000 --tenant-count 200 --scenario mixed
  pnpm setup:local-user-scale -- --users 1000000 --tenant-count 1 --scenario pii-search --fresh

Options:
  --env <env>                 Read setup metadata from .authrim/{env}
  --config <path>             Read a generated config.json directly
  --base-dir <path>           Override repository base directory
  --users <n>                 Synthetic user count (default: 100000, max: 10000000)
  --tenant-count <n>          Number of tenants to distribute users across (default: 200)
  --target-tenant <id>        Tenant to benchmark, for example tenant-001 (default: tenant-001)
  --db-path <path>            SQLite DB path (default: /tmp/authrim-local-user-scale-{users}-{tenants}.sqlite)
  --fresh                     Recreate the DB before seeding
  --query-iterations <n>      Repeat each benchmark query this many times (default: 10)
  --scenario <name>           admin-list | pii-search | domain-lookup | mixed
  --json                      Emit JSON instead of text
`);
}

function printResult(result: LocalUserScaleBenchmarkResult): void {
  const { plan } = result;
  process.stdout.write(`\nAuthrim local synthetic user-scale benchmark\n`);
  process.stdout.write(`users: ${plan.users.toLocaleString()}\n`);
  process.stdout.write(`tenantCount: ${plan.tenantCount.toLocaleString()}\n`);
  process.stdout.write(`targetTenant: ${plan.targetTenant}\n`);
  process.stdout.write(`tenantUserEstimate: ${result.tenantUserEstimate.toLocaleString()}\n`);
  process.stdout.write(`scenario: ${plan.scenario}\n`);
  if (result.setupTarget) {
    process.stdout.write(`env: ${result.setupTarget.env}\n`);
    process.stdout.write(`config: ${result.setupTarget.configPath}\n`);
    process.stdout.write(`lock: ${result.setupTarget.lockPath}\n`);
    process.stdout.write(`placementPolicy: ${result.setupTarget.placementPolicy}\n`);
    process.stdout.write(
      `d1Bindings: ${Object.keys(result.setupTarget.d1).sort().join(', ') || '(none)'}\n`
    );
  }
  process.stdout.write(`dbPath: ${plan.dbPath}\n`);
  process.stdout.write(`dbSize: ${formatBytes(result.dbSizeBytes)}\n`);
  process.stdout.write(
    `seed: ${result.seeded ? `${(result.seedMs / 1000).toFixed(2)}s` : 'reused existing DB'}\n\n`
  );

  process.stdout.write(`queries:\n`);
  for (const query of result.queryResults) {
    process.stdout.write(
      `  - ${query.name}: avg=${query.avgMs.toFixed(2)}ms total=${query.totalMs.toFixed(
        2
      )}ms iterations=${query.iterations}\n`
    );
    for (const line of query.explain) {
      process.stdout.write(`      plan: ${line}\n`);
    }
  }

  process.stdout.write(`\nnotes:\n`);
  for (const note of result.notes) {
    process.stdout.write(`  - ${note}\n`);
  }

  process.stdout.write(`\nresult: ${result.ok ? 'OK' : 'FAILED'}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLocalUserScaleBenchmark({
    baseDir: options.baseDir,
    env: options.env,
    configPath: options.configPath,
    users: options.users,
    tenantCount: options.tenantCount,
    targetTenant: options.targetTenant,
    dbPath: options.dbPath,
    fresh: options.fresh,
    queryIterations: options.queryIterations,
    scenario: options.scenario,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printResult(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
