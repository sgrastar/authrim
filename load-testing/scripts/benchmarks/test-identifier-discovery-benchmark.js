import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const FIXTURE_PATH = __ENV.PHASE0C_FIXTURE;
if (!FIXTURE_PATH) throw new Error('PHASE0C_FIXTURE is required');
const WARMUP_RESERVED_ENTRIES = 2_000;
const MEASUREMENT_ENTRIES = 15_000;

const fixture = new SharedArray('phase0c-identifier-fixture', () => {
  const document = JSON.parse(open(FIXTURE_PATH));
  if (
    document.schemaVersion !== 1 ||
    document.environment !== 'test' ||
    typeof document.baseUrl !== 'string' ||
    typeof document.tenantId !== 'string' ||
    !Array.isArray(document.entries) ||
    document.entries.length !== WARMUP_RESERVED_ENTRIES + MEASUREMENT_ENTRIES
  ) {
    throw new Error('phase0c identifier fixture is invalid');
  }
  return [
    {
      metadata: true,
      baseUrl: document.baseUrl,
      tenantId: document.tenantId,
      runId: document.runId,
    },
    ...document.entries,
  ];
});

const metadata = fixture[0];
const endpoint = `${metadata.baseUrl}/api/auth/discovery/email/verify`;

const success = new Rate('identifier_discovery_success');
const latency = new Trend('identifier_discovery_latency', true);
const routing5xx = new Counter('identifier_discovery_routing_5xx');
const timeouts = new Counter('identifier_discovery_timeouts');
const d1Overloaded = new Counter('identifier_discovery_d1_overloaded');
const serverTimingMissing = new Counter('identifier_discovery_server_timing_missing');
const serverTimingMetrics = Object.freeze({
  discovery_settings: createServerTimingMetric('identifier_discovery_server_settings'),
  otp_registry: createServerTimingMetric('identifier_discovery_server_otp_registry'),
  otp_assignment: createServerTimingMetric('identifier_discovery_server_otp_assignment'),
  otp_verifier: createServerTimingMetric('identifier_discovery_server_otp_verifier'),
  otp_membership_batch: createServerTimingMetric(
    'identifier_discovery_server_otp_membership_batch'
  ),
  otp_challenge: createServerTimingMetric('identifier_discovery_server_otp_challenge'),
  lookup_membership: createServerTimingMetric('identifier_discovery_server_lookup_membership'),
  tenant_registry: createServerTimingMetric('identifier_discovery_server_tenant_registry'),
  tenant_primary_recheck: createServerTimingMetric(
    'identifier_discovery_server_tenant_primary_recheck'
  ),
  candidate_build: createServerTimingMetric('identifier_discovery_server_candidate_build'),
  handler_total: createServerTimingMetric('identifier_discovery_server_handler_total'),
});

function createServerTimingMetric(name) {
  return { name, trend: new Trend(name, true) };
}

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    identifier_discovery_warmup: {
      executor: 'constant-arrival-rate',
      exec: 'runWarmup',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 250,
      maxVUs: 250,
      gracefulStop: '30s',
    },
    identifier_discovery: {
      executor: 'constant-arrival-rate',
      exec: 'runMeasurement',
      startTime: '65s',
      rate: 50,
      timeUnit: '1s',
      // k6 schedules at both time boundaries; subtract 10ms to produce exactly 15,000 arrivals.
      duration: '299.99s',
      preAllocatedVUs: 300,
      maxVUs: 300,
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'identifier_discovery_success{scenario:identifier_discovery}': ['rate>=0.999'],
    'identifier_discovery_latency{scenario:identifier_discovery}': ['p(95)<=400', 'p(99)<=750'],
    'identifier_discovery_routing_5xx{scenario:identifier_discovery}': ['count==0'],
    'identifier_discovery_timeouts{scenario:identifier_discovery}': ['count==0'],
    'identifier_discovery_d1_overloaded{scenario:identifier_discovery}': ['count==0'],
    'identifier_discovery_server_timing_missing{scenario:identifier_discovery}': ['count==0'],
    'dropped_iterations{scenario:identifier_discovery}': ['count==0'],
    'iterations{scenario:identifier_discovery}': ['count==15000'],
  },
};

function responseBody(response) {
  return typeof response.body === 'string' ? response.body.toLowerCase() : '';
}

function recordServerTiming(response) {
  const parsed = new Map();
  const header = response.headers['Server-Timing'];
  if (typeof header === 'string') {
    for (const item of header.split(',')) {
      const match = /^\s*([a-z0-9_]+);dur=([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(item);
      if (match) parsed.set(match[1], Number(match[2]));
    }
  }
  let missing = false;
  for (const [name, metric] of Object.entries(serverTimingMetrics)) {
    const duration = parsed.get(name);
    if (Number.isFinite(duration)) metric.trend.add(duration);
  }
  const common = [
    'discovery_settings',
    'otp_registry',
    'otp_assignment',
    'otp_verifier',
    'tenant_registry',
    'tenant_primary_recheck',
    'candidate_build',
    'handler_total',
  ];
  if (common.some((name) => !Number.isFinite(parsed.get(name)))) missing = true;
  const hasBatch = Number.isFinite(parsed.get('otp_membership_batch'));
  const hasFallback =
    Number.isFinite(parsed.get('otp_challenge')) &&
    Number.isFinite(parsed.get('lookup_membership'));
  if (!hasBatch && !hasFallback) missing = true;
  if (missing) serverTimingMissing.add(1);
}

function run(entry, recordDiagnostics) {
  const response = http.post(
    endpoint,
    JSON.stringify({ challenge_id: entry.challengeId, code: entry.code }),
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Diagnostic-Session-Id': metadata.runId,
      },
      redirects: 0,
      timeout: '10s',
      tags: { phase0c_route: 'identifier_discovery' },
    }
  );
  const body = responseBody(response);
  const isTimeout = response.error_code === 1050 || body.includes('timeout');
  const isOverloaded = body.includes('d1_overloaded') || body.includes('d1 overloaded');
  if (response.status >= 500) routing5xx.add(1);
  if (isTimeout) timeouts.add(1);
  if (isOverloaded) d1Overloaded.add(1);
  if (recordDiagnostics) recordServerTiming(response);

  let payload = null;
  try {
    payload = response.json();
  } catch {
    payload = null;
  }
  const passed = check(response, {
    'identifier discovery resolved': () =>
      response.status === 200 &&
      payload !== null &&
      payload.result === 'resolved' &&
      payload.candidate?.tenant_id === metadata.tenantId,
  });
  latency.add(response.timings.duration);
  success.add(passed);
}

export function runWarmup() {
  const entry = fixture[1 + exec.scenario.iterationInTest];
  if (!entry) throw new Error('phase0c warmup fixture exhausted');
  run(entry, false);
}

export function runMeasurement() {
  const entry = fixture[1 + WARMUP_RESERVED_ENTRIES + exec.scenario.iterationInTest];
  if (!entry) throw new Error('phase0c measurement fixture exhausted');
  run(entry, true);
}

// CLI execution shortcuts can use one prepared measurement entry to validate diagnostics.
export default function diagnosticSmoke() {
  runMeasurement();
}

function values(metrics, name) {
  return metrics[`${name}{scenario:identifier_discovery}`]?.values || metrics[name]?.values || {};
}

function serverTimingSummary(metrics) {
  return Object.fromEntries(
    Object.entries(serverTimingMetrics).map(([name, metric]) => {
      const timing = values(metrics, metric.name);
      return [
        name,
        {
          p50Ms: timing['p(50)'] || 0,
          p95Ms: timing['p(95)'] || 0,
          p99Ms: timing['p(99)'] || 0,
        },
      ];
    })
  );
}

export function handleSummary(data) {
  const rate = values(data.metrics, 'identifier_discovery_success');
  const timing = values(data.metrics, 'identifier_discovery_latency');
  const dropped = values(data.metrics, 'dropped_iterations');
  const fragment = {
    runId: metadata.runId,
    tenantId: metadata.tenantId,
    phase0c_measurement: {
      warmup: { durationSeconds: 30, excludedFromMeasurement: true },
      measurement: {
        durationSeconds: 300,
        ratePerSecond: 50,
        successCount: rate.passes || 0,
        failureCount: rate.fails || 0,
        droppedIterations: dropped.count || 0,
        p50Ms: timing['p(50)'] || 0,
        p95Ms: timing['p(95)'] || 0,
        p99Ms: timing['p(99)'] || 0,
      },
      errors: {
        routing5xx: values(data.metrics, 'identifier_discovery_routing_5xx').count || 0,
        timeouts: values(data.metrics, 'identifier_discovery_timeouts').count || 0,
        d1Overloaded: values(data.metrics, 'identifier_discovery_d1_overloaded').count || 0,
      },
      diagnostics: {
        serverTimingMissing:
          values(data.metrics, 'identifier_discovery_server_timing_missing').count || 0,
        serverTimingMs: serverTimingSummary(data.metrics),
      },
    },
  };
  const output = __ENV.PHASE0C_RESULT || '/private/tmp/phase0c-identifier-result.json';
  const summary = `Phase 0c identifier discovery: ${fragment.phase0c_measurement.measurement.successCount}/15000 succeeded, p95=${fragment.phase0c_measurement.measurement.p95Ms.toFixed(2)}ms, p99=${fragment.phase0c_measurement.measurement.p99Ms.toFixed(2)}ms\n`;
  return { stdout: summary, [output]: JSON.stringify(fragment, null, 2) };
}
