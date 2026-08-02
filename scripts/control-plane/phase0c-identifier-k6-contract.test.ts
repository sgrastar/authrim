import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(
  import.meta.dirname,
  '../../load-testing/scripts/benchmarks/test-identifier-discovery-benchmark.js'
);

describe('Phase 0c identifier discovery k6 contract', () => {
  it('pins the 50 RPS warm-up and 15,000-iteration measurement gate', async () => {
    const source = await readFile(sourcePath, 'utf8');
    expect(source).toContain("duration: '30s'");
    expect(source).toContain("duration: '299.99s'");
    expect(source).toContain("startTime: '65s'");
    expect(source.match(/gracefulStop: '30s'/gu)).toHaveLength(2);
    expect(source).toContain('preAllocatedVUs: 250');
    expect(source).toContain('preAllocatedVUs: 300');
    expect(source).toContain("'p(99)'");
    expect(source).toContain('rate: 50');
    expect(source).toContain('WARMUP_RESERVED_ENTRIES + exec.scenario.iterationInTest');
    expect(source).toContain('const WARMUP_RESERVED_ENTRIES = 2_000');
    expect(source).toContain('const MEASUREMENT_ENTRIES = 15_000');
    expect(source).toContain('run(entry, false)');
    expect(source).toContain('run(entry, true)');
    expect(source).toContain('if (recordDiagnostics) recordServerTiming(response)');
    expect(source).toContain('identifier_discovery_server_otp_membership_batch');
    expect(source).toContain('if (!hasBatch && !hasFallback) missing = true');
    expect(source).toContain("'p(95)<=400'");
    expect(source).toContain("'p(99)<=750'");
    expect(source).toContain("'dropped_iterations{scenario:identifier_discovery}': ['count==0']");
    expect(source).toContain("'iterations{scenario:identifier_discovery}': ['count==15000']");
    expect(source).toContain(
      "'identifier_discovery_server_timing_missing{scenario:identifier_discovery}': ['count==0']"
    );
  });

  it('uses one-use prepared challenges and emits only a normalized result fragment', async () => {
    const source = await readFile(sourcePath, 'utf8');
    expect(source).toContain('/api/auth/discovery/email/verify');
    expect(source).toContain('challenge_id: entry.challengeId');
    expect(source).toContain('code: entry.code');
    expect(source).toContain('phase0c_measurement');
    expect(source).toContain("'X-Diagnostic-Session-Id': metadata.runId");
    expect(source).toContain('serverTimingMs: serverTimingSummary(data.metrics)');
    expect(source).toContain('metrics[name]?.values || {}');
    expect(source).toContain('export default function diagnosticSmoke()');
    expect(source).not.toContain('/api/auth/discovery/email/start');
    expect(source).not.toContain('Authorization');
  });
});
