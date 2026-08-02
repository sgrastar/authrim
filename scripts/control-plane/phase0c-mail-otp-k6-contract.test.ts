import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE0C_GATE } from './phase0c-performance-gate.js';

const SCRIPT = resolve(
  import.meta.dirname,
  '../../load-testing/scripts/benchmarks/test-mail-otp-full-login-benchmark.js'
);

describe('Phase 0c Mail OTP k6 diagnostic contract', () => {
  it('does not expose the production TOTP release-gate preset', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).not.toContain("PRESET === 'phase0c'");
    expect(source).not.toContain("'iterations{scenario:mail_otp_full_login}': ['count==7500']");
    expect(source).not.toContain('phase0c_measurement');
    expect(source).toContain('Phase 0c requires at least');
    expect(source).toContain('PHASE0C_RESULT');
    expect(source).toContain('PHASE0C_RUN_ID');
    expect(source).toContain('a temporary absolute PHASE0C_RESULT path');
    expect(source).not.toContain('User not found: ${user.email}');
    expect(PHASE0C_GATE.warmupSeconds).toBe(30);
    expect(PHASE0C_GATE.measurementSeconds).toBe(300);
    expect(PHASE0C_GATE.scenarios.totpFullLogin.ratePerSecond).toBe(25);
    expect(PHASE0C_GATE.scenarios.totpFullLogin.maximumP95Ms).toBe(5_000);
    expect(PHASE0C_GATE.scenarios.totpFullLogin.totpCompletionMaximumP95Ms).toBe(3_000);
  });

  it('counts timeout, overloaded D1, and routing 5xx separately', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("new Counter('timeout_errors')");
    expect(source).toContain("new Counter('d1_overloaded_errors')");
    expect(source).toContain('recordInfrastructureFailure(step1Response)');
    expect(source).toContain('recordInfrastructureFailure(step5Response)');
    expect(source).toContain("'server_errors{scenario:mail_otp_full_login}': ['count==0']");
    expect(source).toContain("'timeout_errors{scenario:mail_otp_full_login}': ['count==0']");
    expect(source).toContain("'d1_overloaded_errors{scenario:mail_otp_full_login}': ['count==0']");
  });

  it('separates server waiting time from transport overhead without recording payloads', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("new Trend('authorize_init_waiting')");
    expect(source).toContain("new Trend('email_code_verify_waiting')");
    expect(source).toContain("new Trend('token_waiting')");
    expect(source).toContain("new Trend('authorize_init_transport')");
    expect(source).toContain(
      'recordStepTiming(step5Response, tokenLatency, tokenWaiting, tokenTransport)'
    );
    expect(source).toContain("timingBreakdown('authorize_init')");
    expect(source).toContain("timingBreakdown('token')");
    expect(source).not.toContain('timing_breakdown: step5Response');
  });

  it('provides a one-flow smoke preset before sustained load', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("'phase0c-smoke'");
    expect(source).toMatch(
      /isPhase0cSmoke[\s\S]*executor: 'shared-iterations'[\s\S]*iterations: 1[\s\S]*vus: 1[\s\S]*maxDuration: '90s'/u
    );
    expect(source).toContain("'flow_success{scenario:mail_otp_full_login}': ['rate==1']");
    expect(source).toContain("'iterations{scenario:mail_otp_full_login}': ['count==1']");
    expect(source).toContain('extractPublicErrorCode(step3Response.body)');
    expect(source).toContain('extractPublicErrorCode(step2Response.body)');
    expect(source).toContain('extractOAuthRedirectError(location)');
    expect(source).toContain('extractPublicErrorCode(step5Response.body)');
    expect(source).toContain('/^[A-Za-z0-9_.:-]{1,80}$/');
    expect(source).not.toContain('OTP verify response body');
  });

  it('provides a bounded diagnostic sample without changing the fixed release gate', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("'phase0c-sample'");
    expect(source).toMatch(
      /isPhase0cSample \|\| isPhase0cPreGate[\s\S]*exec: 'phase0cWarmup'[\s\S]*rate: 1[\s\S]*duration: '15s'[\s\S]*mail_otp_full_login:[\s\S]*rate: boundedSampleRate[\s\S]*duration: '60s'/u
    );
    expect(source).toContain('const boundedSampleRate = isPhase0cPreGate ? 2 : 1');
    expect(source).toContain('`count>=${boundedSampleRate * 60}`');
    expect(source).toContain('`count<=${boundedSampleMaximumIterations}`');
    expect(source).toContain("'full_flow_latency{scenario:mail_otp_full_login}': ['p(95)>=0']");
    expect(source).toContain("'rate_limit_errors{scenario:mail_otp_full_login}': ['count==0']");
    expect(source).toContain('phase0c_sample');
    expect(source).not.toContain(
      "'full_flow_latency{scenario:mail_otp_full_login}': ['p(95)<=1500'],\n          'flow_success{scenario:mail_otp_full_login}': ['rate==1']"
    );
  });

  it('provides a two-LPS diagnostic pre-gate without changing the release contract', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain("'phase0c-pre-gate'");
    expect(source).toContain('const boundedSampleRate = isPhase0cPreGate ? 2 : 1');
    expect(source).toContain('const boundedSampleMaximumIterations = isPhase0cPreGate ? 122 : 61');
    expect(source).toContain('rate: boundedSampleRate');
    expect(source).toContain('phase0c_pre_gate');
    expect(source).toContain('ratePerSecond: 2');
    expect(source).toContain("'full_flow_latency{scenario:mail_otp_full_login}': ['p(95)>=0']");
    expect(PHASE0C_GATE.scenarios.totpFullLogin.ratePerSecond).toBe(25);
  });

  it('collects bounded secret-free server timing only for the one-flow smoke', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    expect(source).toContain('const phase0cDiagnosticHeaders = isPhase0cSmoke');
    expect(source).toContain("'X-Diagnostic-Session-Id': PHASE0C_RUN_ID");
    expect(source).toContain("recordPhase0cServerTiming('authorize_init', step1Response)");
    expect(source).toContain("recordPhase0cServerTiming('email_code_generate', step2Response)");
    expect(source).toContain("recordPhase0cServerTiming('email_code_verify', step3Response)");
    expect(source).toContain("recordPhase0cServerTiming('authorize_code', step4Response)");
    expect(source).toContain("recordPhase0cServerTiming('token', step5Response)");
    expect(source).toContain('.slice(0, 32)');
    expect(source).toContain('(?:auth|mg|token)_[a-z0-9_]{1,63}');
    expect(source).not.toContain('console.log(raw)');
  });
});
