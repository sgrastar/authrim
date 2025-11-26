#!/usr/bin/env npx tsx
/**
 * Get Test Details Script
 *
 * Fetches detailed error information from the OpenID Conformance Suite
 *
 * Usage:
 *   npx tsx scripts/conformance/get-test-details.ts --plan <planId>
 *   npx tsx scripts/conformance/get-test-details.ts --module <moduleId>
 *   npx tsx scripts/conformance/get-test-details.ts --plan <planId> --failed-only
 */

import { ConformanceClient } from './lib/conformance-client.js';

const CONFORMANCE_SERVER = 'https://www.certification.openid.net';

interface LogEntry {
  _id?: string;
  src?: string;
  testId?: string;
  testOwner?: string;
  time?: number;
  msg?: string;
  result?: string;
  requirements?: string[];
  upload?: Record<string, unknown>;
  http?: string;
  [key: string]: unknown;
}

interface TestResult {
  name: string;
  id: string;
  status: string;
  result?: string;
  logs: LogEntry[];
  errors: LogEntry[];
  warnings: LogEntry[];
}

async function getTestDetails(
  client: ConformanceClient,
  moduleId: string
): Promise<TestResult> {
  const info = await client.getModuleInfo(moduleId);
  const logs = (await client.getTestLog(moduleId)) as LogEntry[];

  const errors = logs.filter(
    (log) =>
      log.result === 'FAILURE' ||
      log.result === 'CRITICAL' ||
      (log.msg && log.msg.toLowerCase().includes('error'))
  );

  const warnings = logs.filter((log) => log.result === 'WARNING');

  return {
    name: info.testName || 'Unknown',
    id: moduleId,
    status: info.status,
    result: info.result,
    logs,
    errors,
    warnings,
  };
}

function formatLogEntry(entry: LogEntry, verbose: boolean): string {
  const lines: string[] = [];

  if (entry.msg) {
    lines.push(`  Message: ${entry.msg}`);
  }

  if (entry.result) {
    lines.push(`  Result: ${entry.result}`);
  }

  if (entry.src) {
    lines.push(`  Source: ${entry.src}`);
  }

  if (entry.requirements && entry.requirements.length > 0) {
    lines.push(`  Requirements: ${entry.requirements.join(', ')}`);
  }

  if (verbose) {
    if (entry.http) {
      lines.push(`  HTTP: ${entry.http}`);
    }

    // Show additional fields
    const skipFields = [
      '_id',
      'src',
      'testId',
      'testOwner',
      'time',
      'msg',
      'result',
      'requirements',
      'upload',
      'http',
    ];
    for (const [key, value] of Object.entries(entry)) {
      if (!skipFields.includes(key) && value !== undefined) {
        const valueStr =
          typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        if (valueStr.length < 500) {
          lines.push(`  ${key}: ${valueStr}`);
        } else {
          lines.push(`  ${key}: [truncated, ${valueStr.length} chars]`);
        }
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let planId: string | undefined;
  let moduleId: string | undefined;
  let failedOnly = false;
  let verbose = false;
  let showLogs = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--plan':
        planId = args[++i];
        break;
      case '--module':
        moduleId = args[++i];
        break;
      case '--failed-only':
        failedOnly = true;
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      case '--logs':
        showLogs = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage:
  npx tsx scripts/conformance/get-test-details.ts [options]

Options:
  --plan <planId>     Get details for all tests in a plan
  --module <moduleId> Get details for a specific test module
  --failed-only       Only show failed/errored tests (with --plan)
  --verbose, -v       Show detailed log entries
  --logs              Show all log entries (not just errors)
  --help, -h          Show this help

Examples:
  npx tsx scripts/conformance/get-test-details.ts --plan aa4Qs25G69eya --failed-only
  npx tsx scripts/conformance/get-test-details.ts --module dgCRndFKYUThVZf --verbose
`);
        process.exit(0);
    }
  }

  const token = process.env.CONFORMANCE_TOKEN;
  if (!token) {
    console.error('Error: CONFORMANCE_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!planId && !moduleId) {
    console.error('Error: Either --plan or --module is required');
    process.exit(1);
  }

  const client = new ConformanceClient(CONFORMANCE_SERVER, token);

  try {
    if (moduleId) {
      // Single module
      console.log(`\nFetching details for module: ${moduleId}\n`);
      const result = await getTestDetails(client, moduleId);
      printTestResult(result, verbose, showLogs);
    } else if (planId) {
      // All modules in plan
      console.log(`\nFetching details for plan: ${planId}\n`);
      console.log(`Plan URL: ${client.getPlanUrl(planId)}\n`);

      const plan = await client.getTestPlan(planId);
      console.log(`Plan: ${plan.name}`);
      console.log(`Description: ${plan.description || 'N/A'}`);

      // Get all module instances from the plan
      const moduleInstances: Array<{ id: string; testModule: string; status?: string; result?: string | null }> = [];

      if (plan.modules) {
        for (const mod of plan.modules) {
          if (mod.instances && Array.isArray(mod.instances)) {
            for (const instance of mod.instances) {
              // Instance can be a string (module ID) or an object
              const id = typeof instance === 'string' ? instance : instance.id;
              moduleInstances.push({
                id,
                testModule: mod.testModule,
              });
            }
          }
        }
      }

      console.log(`Total test instances: ${moduleInstances.length}`);
      console.log(`Fetching status for each module...\n`);

      if (moduleInstances.length === 0) {
        console.log('No test instances found in this plan.');
        return;
      }

      // Fetch status/result for each module
      for (const mod of moduleInstances) {
        try {
          const info = await client.getModuleInfo(mod.id);
          mod.status = info.status;
          mod.result = info.result;
        } catch {
          mod.status = 'UNKNOWN';
          mod.result = 'UNKNOWN';
        }
      }

      // Print summary table
      console.log('Test Summary:');
      console.log('-'.repeat(70));
      const statusCounts: Record<string, number> = {};
      for (const mod of moduleInstances) {
        const key = mod.result || mod.status || 'UNKNOWN';
        statusCounts[key] = (statusCounts[key] || 0) + 1;
        const icon =
          mod.result === 'PASSED'
            ? '✅'
            : mod.result === 'SKIPPED'
              ? '⚠️'
              : mod.result === 'WARNING'
                ? '⚠️'
                : mod.status === 'INTERRUPTED' || mod.result === null
                  ? '❌'
                  : mod.result === 'FAILED'
                    ? '❌'
                    : '❓';
        console.log(`${icon} ${mod.testModule.padEnd(55)} ${mod.result || mod.status}`);
      }
      console.log('-'.repeat(70));
      console.log('Summary:', Object.entries(statusCounts).map(([k, v]) => `${k}: ${v}`).join(', '));
      console.log('');

      // Filter if needed
      let filtered = moduleInstances;
      if (failedOnly) {
        filtered = moduleInstances.filter(
          (m) =>
            m.result === 'FAILED' ||
            m.result === 'WARNING' ||
            m.result === null ||
            m.status === 'INTERRUPTED'
        );
        console.log(`\nShowing ${filtered.length} failed/warning/interrupted tests:\n`);
      }

      for (const mod of filtered) {
        try {
          const result = await getTestDetails(client, mod.id);
          printTestResult(result, verbose, showLogs);
        } catch (error) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`Test: ${mod.testModule}`);
          console.log(`Module ID: ${mod.id}`);
          console.log(`Error fetching details: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

function printTestResult(result: TestResult, verbose: boolean, showLogs: boolean) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test: ${result.name}`);
  console.log(`Module ID: ${result.id}`);
  console.log(`Status: ${result.status}`);
  console.log(`Result: ${result.result || 'N/A'}`);

  if (result.errors.length > 0) {
    console.log(`\n--- Errors (${result.errors.length}) ---`);
    for (const error of result.errors) {
      console.log('\n' + formatLogEntry(error, verbose));
    }
  }

  if (result.warnings.length > 0) {
    console.log(`\n--- Warnings (${result.warnings.length}) ---`);
    for (const warning of result.warnings) {
      console.log('\n' + formatLogEntry(warning, verbose));
    }
  }

  if (showLogs && result.logs.length > 0) {
    console.log(`\n--- All Logs (${result.logs.length}) ---`);
    for (const log of result.logs) {
      console.log('\n' + formatLogEntry(log, verbose));
    }
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('\nNo errors or warnings found.');
  }
}

main();
