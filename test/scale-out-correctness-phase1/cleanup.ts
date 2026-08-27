#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  type Phase1Baseline,
  type Phase1Summary,
} from './schemas.js';

export const PHASE1_CLEANUP_CONFIRMATION = 'AUTHRIM_PHASE1_DELETE_DISPOSABLE_ENVIRONMENT';

export interface Phase1CleanupPlan {
  schemaVersion: 1;
  runId: string;
  environmentId: string;
  providerDatabaseIdsAddedDuringRun: string[];
  evidenceComplete: boolean;
}

function recordsFromJsonl(source: string): Array<Record<string, unknown>> {
  return source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('phase1_cleanup_provider_event_invalid');
      }
      return value as Record<string, unknown>;
    });
}

export function buildPhase1CleanupPlan(input: {
  baseline: Phase1Baseline;
  summary: Phase1Summary;
  providerEvents: Array<Record<string, unknown>>;
}): Phase1CleanupPlan {
  const environmentId = input.baseline.control.environment?.environment_id;
  if (
    input.baseline.schemaVersion !== PHASE1_SCHEMA_VERSION ||
    input.summary.schemaVersion !== PHASE1_SCHEMA_VERSION ||
    input.baseline.runId !== input.summary.runId ||
    typeof environmentId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,127}$/u.test(environmentId) ||
    /(?:^|-)(?:prod|production)(?:-|$)/u.test(environmentId)
  ) {
    throw new Error('phase1_cleanup_evidence_mismatch');
  }
  const providerDatabaseIdsAddedDuringRun = [
    ...new Set(
      input.providerEvents.flatMap((event) => {
        if (event.kind !== 'provider_database_change' || event.previous !== null) return [];
        return typeof event.databaseUuid === 'string' ? [event.databaseUuid] : [];
      })
    ),
  ].sort();
  const plan: Phase1CleanupPlan = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    runId: input.baseline.runId,
    environmentId,
    providerDatabaseIdsAddedDuringRun,
    evidenceComplete: true,
  };
  assertPhase1EvidenceIsSecretFree(plan);
  return plan;
}

async function runSetupDelete(environmentId: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      'pnpm',
      ['run', 'setup', 'delete', '--env', environmentId, '--all', '--yes'],
      { stdio: 'inherit' }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`phase1_cleanup_setup_delete_failed:${code ?? signal ?? 'unknown'}`));
    });
  });
}

async function main(): Promise<void> {
  const value = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const runDirectoryValue = value('--run-directory');
  if (!runDirectoryValue) throw new Error('phase1_cleanup_run_directory_required');
  const runDirectory = resolve(runDirectoryValue);
  const [baseline, summary, providerEventSource] = await Promise.all([
    readFile(resolve(runDirectory, 'baseline.json'), 'utf8').then(
      (source) => JSON.parse(source) as Phase1Baseline
    ),
    readFile(resolve(runDirectory, 'summary.json'), 'utf8').then(
      (source) => JSON.parse(source) as Phase1Summary
    ),
    readFile(resolve(runDirectory, 'provider-events.jsonl'), 'utf8'),
  ]);
  const plan = buildPhase1CleanupPlan({
    baseline,
    summary,
    providerEvents: recordsFromJsonl(providerEventSource),
  });
  const execute = process.argv.includes('--execute');
  if (!execute) {
    process.stdout.write(`${JSON.stringify({ ...plan, status: 'dry_run' }, null, 2)}\n`);
    return;
  }
  if (value('--confirmation') !== PHASE1_CLEANUP_CONFIRMATION) {
    throw new Error('phase1_cleanup_confirmation_required');
  }
  await runSetupDelete(plan.environmentId);
  await writeFile(
    resolve(runDirectory, 'cleanup.json'),
    `${JSON.stringify(
      {
        ...plan,
        status: 'completed',
        completedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_cleanup_failed'}\n`);
    process.exitCode = 1;
  });
}
