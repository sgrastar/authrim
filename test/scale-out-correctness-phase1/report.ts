#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  parsePhase1HarnessConfig,
  type Phase1HarnessConfig,
  type Phase1Baseline,
  type Phase1IntegrityResult,
  type Phase1ProvisioningEvidence,
  type Phase1ProvisioningEventEvidence,
  type Phase1Summary,
} from './schemas.js';
import type { Phase1RunnerResult } from './run.js';

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function controlTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  const milliseconds = value >= 100_000_000_000 ? value : value * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function observedTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function isoTimestamp(epoch: number): string {
  return new Date(epoch).toISOString();
}

function dataRole(value: Record<string, unknown>): string {
  if (typeof value.desired_spec_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(value.desired_spec_json);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).data_role === 'string'
      ) {
        return String((parsed as Record<string, unknown>).data_role);
      }
    } catch {
      // The verifier reports malformed desired-resource state separately.
    }
  }
  const deterministicName = value.deterministic_name;
  if (typeof deterministicName === 'string') {
    if (deterministicName.includes('-tenant-core-users-')) return 'tenant_core/users';
    if (deterministicName.includes('-tenant-pii-')) return 'tenant_pii';
    if (deterministicName.includes('-tenant-lookup-')) return 'lookup';
  }
  return typeof value.resource_kind === 'string' ? value.resource_kind : 'unknown';
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function buildPhase1ProvisioningEvidence(input: {
  baseline?: Phase1Baseline;
  controlEvents?: Array<Record<string, unknown>>;
}): Phase1ProvisioningEvidence {
  const baselineResources = new Set(
    input.baseline?.control.desiredResources.map((row) => String(row.desired_resource_id)) ?? []
  );
  const forecastsByOperation = new Map<string, Phase1ProvisioningEventEvidence['lookupForecast']>();
  const resources = new Map<
    string,
    {
      operationId: string | null;
      dataRole: string;
      deterministicName: string;
      decisionAt: number;
      readyAt: number | null;
      timingSource: 'control_state' | 'observer';
    }
  >();
  const events = [...(input.controlEvents ?? [])].sort((left, right) =>
    String(left.observedAt).localeCompare(String(right.observedAt))
  );
  for (const event of events) {
    const current =
      event.current && typeof event.current === 'object' && !Array.isArray(event.current)
        ? (event.current as Record<string, unknown>)
        : null;
    const observedAt = observedTimestamp(event.observedAt);
    if (!current || observedAt === null) continue;
    if (event.entity === 'lookupForecasts') {
      const operationId = current.requested_operation_id;
      if (typeof operationId !== 'string' || forecastsByOperation.has(operationId)) continue;
      forecastsByOperation.set(operationId, {
        observedAt: isoTimestamp(observedAt),
        decisionGeneration: numeric(current.decision_generation),
        observedActiveRouteCount: numeric(current.observed_active_route_count),
        observedSuccessfulPublicationCount: numeric(current.observed_successful_publication_count),
        sampleRateMicrorowsPerSecond: numeric(current.sample_rate_microrows_per_second),
        ewmaRateMicrorowsPerSecond: numeric(current.ewma_rate_microrows_per_second),
        forecastHorizonSeconds: numeric(current.forecast_horizon_seconds),
        forecastNewRouteCount: numeric(current.forecast_new_route_count),
        projectedActiveRouteCount: numeric(current.projected_active_route_count),
        usableCapacityRouteCount: numeric(current.usable_capacity_route_count),
      });
      continue;
    }
    if (event.entity !== 'desiredResources') continue;
    const desiredResourceId = current.desired_resource_id;
    if (typeof desiredResourceId !== 'string' || baselineResources.has(desiredResourceId)) continue;
    const existing = resources.get(desiredResourceId);
    const internalCreatedAt = controlTimestamp(current.created_at);
    const decisionAt = existing?.decisionAt ?? internalCreatedAt ?? observedAt;
    const timingSource =
      existing?.timingSource ?? (internalCreatedAt === null ? 'observer' : 'control_state');
    const internalReadyAt =
      current.provisioning_state === 'ready' ? controlTimestamp(current.updated_at) : null;
    resources.set(desiredResourceId, {
      operationId:
        existing?.operationId ??
        (typeof current.origin_operation_id === 'string' ? current.origin_operation_id : null),
      dataRole: existing?.dataRole ?? dataRole(current),
      deterministicName:
        existing?.deterministicName ??
        (typeof current.deterministic_name === 'string' ? current.deterministic_name : 'unknown'),
      decisionAt,
      readyAt:
        existing?.readyAt ??
        (current.provisioning_state === 'ready' ? (internalReadyAt ?? observedAt) : null),
      timingSource,
    });
  }
  const provisioningEvents = [...resources.entries()]
    .map(
      ([desiredResourceId, resource]): Phase1ProvisioningEventEvidence => ({
        desiredResourceId,
        operationId: resource.operationId,
        dataRole: resource.dataRole,
        deterministicName: resource.deterministicName,
        decisionAt: isoTimestamp(resource.decisionAt),
        readyAt: resource.readyAt === null ? null : isoTimestamp(resource.readyAt),
        decisionToReadyMs:
          resource.readyAt === null ? null : Math.max(0, resource.readyAt - resource.decisionAt),
        timingSource: resource.timingSource,
        lookupForecast:
          resource.operationId === null
            ? null
            : (forecastsByOperation.get(resource.operationId) ?? null),
      })
    )
    .sort(
      (left, right) =>
        left.decisionAt.localeCompare(right.decisionAt) ||
        left.desiredResourceId.localeCompare(right.desiredResourceId)
    );
  const durations = provisioningEvents
    .flatMap((event) => (event.decisionToReadyMs === null ? [] : [event.decisionToReadyMs]))
    .sort((left, right) => left - right);
  const evidence: Phase1ProvisioningEvidence = {
    events: provisioningEvents,
    readyLatencyMs: {
      count: durations.length,
      minimum: durations[0] ?? null,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      maximum: durations.at(-1) ?? null,
      mean:
        durations.length === 0
          ? null
          : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    },
  };
  assertPhase1EvidenceIsSecretFree(evidence);
  return evidence;
}

export function buildPhase1TimelineSvg(input: {
  baseline: Phase1Baseline;
  controlEvents: Array<Record<string, unknown>>;
  requestEvents: Array<Record<string, unknown>>;
  totalAccounts: number;
}): string {
  const width = 1_000;
  const height = 440;
  const left = 72;
  const right = 28;
  const top = 48;
  const chartHeight = 250;
  const chartWidth = width - left - right;
  const shards = new Map(
    input.baseline.control.shardCapacities.map((row) => [String(row.shard_id), row] as const)
  );
  const lookup = new Map(
    input.baseline.control.lookupShards.map((row) => [String(row.lookup_shard_id), row] as const)
  );
  const completions = input.requestEvents
    .filter((event) => event.kind === 'accepted_201' || event.kind === 'succeeded')
    .flatMap((event) => {
      const epoch = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN;
      return Number.isFinite(epoch) ? [epoch] : [];
    })
    .sort((leftEpoch, rightEpoch) => leftEpoch - rightEpoch);
  const countAt = (epoch: number): number => {
    let low = 0;
    let high = completions.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (completions[middle] <= epoch) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const counts = () => ({
    core: [...shards.values()].filter(
      (row) => row.data_role === 'tenant_core/users' && row.status === 'active'
    ).length,
    pii: [...shards.values()].filter(
      (row) => row.data_role === 'tenant_pii' && row.status === 'active'
    ).length,
    lookup: [...lookup.values()].filter((row) => row.status === 'active').length,
  });
  const startEpoch = Date.parse(input.baseline.capturedAt);
  const points = [{ accounts: 0, epoch: startEpoch, ...counts() }];
  const forecastPoints: Array<{ accounts: number; projected: number; usable: number }> = [];
  for (const event of [...input.controlEvents].sort((leftEvent, rightEvent) =>
    String(leftEvent.observedAt).localeCompare(String(rightEvent.observedAt))
  )) {
    const current =
      event.current && typeof event.current === 'object' && !Array.isArray(event.current)
        ? (event.current as Record<string, unknown>)
        : null;
    const key =
      typeof event.key === 'string' || typeof event.key === 'number' ? String(event.key) : '';
    if (event.entity === 'shardCapacities') {
      if (current) shards.set(key, current);
      else shards.delete(key);
    } else if (event.entity === 'lookupShards') {
      if (current) lookup.set(key, current);
      else lookup.delete(key);
    }
    const epoch = typeof event.observedAt === 'string' ? Date.parse(event.observedAt) : Number.NaN;
    if (!Number.isFinite(epoch)) continue;
    const accounts = countAt(epoch);
    points.push({ accounts, epoch, ...counts() });
    if (event.entity === 'lookupForecasts' && current) {
      const projected = numeric(current.projected_active_route_count);
      const usable = numeric(current.usable_capacity_route_count);
      if (projected !== null && usable !== null)
        forecastPoints.push({ accounts, projected, usable });
    }
  }
  points.push({
    accounts: Math.min(input.totalAccounts, completions.length),
    epoch: completions.at(-1) ?? startEpoch,
    ...counts(),
  });
  const maximumShardCount = Math.max(
    1,
    ...points.flatMap((point) => [point.core, point.pii, point.lookup])
  );
  const x = (accounts: number) => left + (chartWidth * accounts) / Math.max(1, input.totalAccounts);
  const y = (count: number) => top + chartHeight - (chartHeight * count) / maximumShardCount;
  const polyline = (field: 'core' | 'pii' | 'lookup', color: string) =>
    `<polyline fill="none" stroke="${color}" stroke-width="3" points="${points
      .map((point) => `${x(point.accounts).toFixed(1)},${y(point[field]).toFixed(1)}`)
      .join(' ')}"/>`;
  const forecastMax = Math.max(
    1,
    ...forecastPoints.flatMap((point) => [point.projected, point.usable])
  );
  const forecastTop = 334;
  const forecastHeight = 54;
  const forecastLine = (field: 'projected' | 'usable', color: string) =>
    forecastPoints.length === 0
      ? ''
      : `<polyline fill="none" stroke="${color}" stroke-width="2" points="${forecastPoints
          .map(
            (point) =>
              `${x(point.accounts).toFixed(1)},${(
                forecastTop +
                forecastHeight -
                (forecastHeight * point[field]) / forecastMax
              ).toFixed(1)}`
          )
          .join(' ')}"/>`;
  const ticks = Array.from({ length: 6 }, (_, index) =>
    Math.round((input.totalAccounts * index) / 5)
  );
  const tickSvg = ticks
    .map(
      (tick) =>
        `<line x1="${x(tick)}" y1="${top + chartHeight}" x2="${x(tick)}" y2="${top + chartHeight + 6}" stroke="#64748b"/><text x="${x(tick)}" y="${top + chartHeight + 22}" text-anchor="middle" font-size="12" fill="#475569">${tick}</text>`
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="${left}" y="26" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="#0f172a">Phase 1 scale-out timeline</text>
<line x1="${left}" y1="${top + chartHeight}" x2="${width - right}" y2="${top + chartHeight}" stroke="#94a3b8"/>
<line x1="${left}" y1="${top}" x2="${left}" y2="${top + chartHeight}" stroke="#94a3b8"/>
${tickSvg}
${polyline('core', '#2563eb')}
${polyline('pii', '#7c3aed')}
${polyline('lookup', '#059669')}
<text x="${left}" y="326" font-family="system-ui,sans-serif" font-size="12" fill="#475569">completed accounts →</text>
${forecastLine('projected', '#dc2626')}
${forecastLine('usable', '#0f766e')}
<text x="${left}" y="414" font-family="system-ui,sans-serif" font-size="12" fill="#2563eb">Core active D1</text>
<text x="${left + 132}" y="414" font-family="system-ui,sans-serif" font-size="12" fill="#7c3aed">PII active D1</text>
<text x="${left + 252}" y="414" font-family="system-ui,sans-serif" font-size="12" fill="#059669">Lookup active D1</text>
<text x="${left + 390}" y="414" font-family="system-ui,sans-serif" font-size="12" fill="#dc2626">projected routes</text>
<text x="${left + 510}" y="414" font-family="system-ui,sans-serif" font-size="12" fill="#0f766e">usable capacity</text>
</svg>\n`;
  assertPhase1EvidenceIsSecretFree(svg);
  return svg;
}

export function buildPhase1Report(input: {
  config: Phase1HarnessConfig;
  runner: Phase1RunnerResult;
  integrity: Phase1IntegrityResult;
  runId: string;
  baseline?: Phase1Baseline;
  controlEvents?: Array<Record<string, unknown>>;
}): { summary: Phase1Summary; markdown: string } {
  const eventualSuccessRate =
    input.runner.metrics.scheduled === 0
      ? 0
      : input.integrity.succeededAccounts / input.runner.metrics.scheduled;
  const immediate201 = input.runner.accounts.filter(
    (account) => account.firstResponseStatus === 201
  ).length;
  const immediate201Rate =
    input.runner.metrics.scheduled === 0 ? 0 : immediate201 / input.runner.metrics.scheduled;
  const provisioning = buildPhase1ProvisioningEvidence({
    baseline: input.baseline,
    controlEvents: input.controlEvents,
  });
  const summary: Phase1Summary = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    runId: input.runId,
    profile: input.config.profile,
    startedAt: input.runner.startedAt,
    finishedAt: input.runner.finishedAt,
    passed: input.integrity.passed && eventualSuccessRate === 1,
    metrics: {
      ...input.runner.metrics,
      eventualSuccessRate,
      immediate201Rate,
    },
    provisioning,
    integrity: input.integrity,
  };
  assertPhase1EvidenceIsSecretFree(summary);
  const failedChecks = input.integrity.checks.filter((check) => !check.passed);
  const markdown = `# Phase 1 scale-out correctness result

Run ID: \`${input.runId}\`<br>
Profile: \`${input.config.profile}\`<br>
Result: **${summary.passed ? 'PASS' : 'FAIL'}**<br>
Started: ${input.runner.startedAt}<br>
Finished: ${input.runner.finishedAt}

## Headline results

![Scale-out timeline](./timeline.svg)

| Metric | Result |
| --- | ---: |
| Account creation eventual success | ${percent(eventualSuccessRate)} |
| Immediate 201 success | ${percent(immediate201Rate)} |
| Lost accounts | ${input.integrity.lostAccounts} |
| Duplicate core accounts | ${input.integrity.duplicateCoreAccounts} |
| Missing or duplicate PII representations | ${input.integrity.duplicatePiiAccounts} |
| Lookup route mismatches | ${input.integrity.lookupRouteMismatches} |
| Orphan D1 resources | ${input.integrity.orphanD1Resources} |
| Resource mapping mismatches | ${input.integrity.resourceMappingMismatches} |
| Lookup forecast mismatches | ${input.integrity.lookupForecastMismatches} |
| Publication counter decreases | ${input.integrity.publicationCounterDecreases} |
| Publication counter delta mismatches | ${input.integrity.publicationCounterDeltaMismatches} |
| Allocation mismatches | ${input.integrity.allocationMismatches} |
| Field-level mismatches | ${input.integrity.fieldLevelMismatches} |
| Manual intervention | ${input.integrity.manualIntervention} |
| Core shard boundary crossings | ${input.integrity.coreBoundaryCrossings} |
| PII shard boundary crossings | ${input.integrity.piiBoundaryCrossings} |
| Lookup physical D1 additions | ${input.integrity.lookupPhysicalAdditions} |
| Lookup used assignment transitions | ${input.integrity.lookupUsedAssignmentTransitions} |
| Provisioned D1 resources | ${input.integrity.provisionedD1Resources} |
| Core physical additions | ${input.integrity.corePhysicalAdditions} |
| PII physical additions | ${input.integrity.piiPhysicalAdditions} |
| Excess Core provisioning | ${input.integrity.excessCoreProvisioning} |
| Excess PII provisioning | ${input.integrity.excessPiiProvisioning} |
| Capacity 503 responses retried | ${input.runner.metrics.capacity503} |
| Registry propagation 503 responses retried | ${input.runner.metrics.registryPropagation503} |
| Runtime binding propagation 503 responses retried | ${input.runner.metrics.bindingPropagation503} |
| Unexpected server 5xx responses retried | ${input.runner.metrics.server5xx} |
| Total retries | ${input.runner.metrics.retries} |

## Provisioning timing evidence

Ready latency count: ${provisioning.readyLatencyMs.count}<br>
Ready latency min / p50 / p95 / max: ${[
    provisioning.readyLatencyMs.minimum,
    provisioning.readyLatencyMs.p50,
    provisioning.readyLatencyMs.p95,
    provisioning.readyLatencyMs.maximum,
  ]
    .map((value) => (value === null ? '-' : `${(value / 1_000).toFixed(3)}s`))
    .join(' / ')}

| Data role | Decision | Ready | Decision → ready | Predicted new routes | Projected / usable routes | Operation |
| --- | --- | --- | ---: | ---: | ---: | --- |
${
  provisioning.events.length === 0
    ? '| _No new D1 resources observed_ | - | - | - | - | - | - |'
    : provisioning.events
        .map(
          (event) =>
            `| ${event.dataRole} | ${event.decisionAt} | ${event.readyAt ?? '-'} | ${
              event.decisionToReadyMs === null
                ? '-'
                : `${(event.decisionToReadyMs / 1_000).toFixed(3)}s`
            } | ${event.lookupForecast?.forecastNewRouteCount ?? '-'} | ${
              event.lookupForecast
                ? `${event.lookupForecast.projectedActiveRouteCount ?? '-'} / ${
                    event.lookupForecast.usableCapacityRouteCount ?? '-'
                  }`
                : '-'
            } | ${event.operationId ?? '-'} |`
        )
        .join('\n')
}

## Integrity checks

| Check | Result | Detail |
| --- | --- | --- |
${input.integrity.checks
  .map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.detail} |`)
  .join('\n')}

## Conclusion

${
  summary.passed
    ? 'The Phase 1 correctness criteria passed without manual intervention.'
    : `The run failed ${failedChecks.length} integrity check(s): ${
        failedChecks.map((check) => check.name).join(', ') || 'headline acceptance threshold'
      }.`
}
`;
  return { summary, markdown };
}

async function main(): Promise<void> {
  const value = (name: string): string => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1])
      throw new Error(`phase1_report_argument_missing:${name}`);
    return process.argv[index + 1];
  };
  const config = parsePhase1HarnessConfig(JSON.parse(await readFile(value('--config'), 'utf8')));
  const runner = JSON.parse(await readFile(value('--runner'), 'utf8')) as Phase1RunnerResult;
  const integrity = JSON.parse(
    await readFile(value('--integrity'), 'utf8')
  ) as Phase1IntegrityResult;
  const output = value('--output');
  const report = buildPhase1Report({ config, runner, integrity, runId: integrity.runId });
  await writeFile(output, report.markdown, { mode: 0o600, flag: 'wx' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_report_failed'}\n`);
    process.exitCode = 1;
  });
}
