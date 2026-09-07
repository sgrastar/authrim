import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PHASE0C_TOTP_LOAD_PROFILES,
  isPhase0cTotpLoadEntrypoint,
  mapConcurrent,
  parsePhase0cTotpLoadArgs,
  phase0cTotpReuseIntervalSeconds,
  runPhase0cTotpArrivalWindow,
  safePhase0cTotpLoadExecutionError,
  validatePhase0cTotpLoadEvidence,
} from './phase0c-totp-load-live.js';

function evidence() {
  return {
    schemaVersion: 2,
    runId: 'phase0c-totp-20260801123456-abcdef',
    tenantId: 'default',
    scenario: 'production_totp_full_login_load',
    profile: 'sample',
    authenticationBypass: false,
    testInbox: false,
    readReplication: 'disabled',
    userPool: { count: 16, sameTimeStepReuse: false },
    scenarioResult: {
      warmup: { durationSeconds: 3, excludedFromMeasurement: true },
      measurement: {
        durationSeconds: 10,
        ratePerSecond: 1,
        successCount: 10,
        failureCount: 0,
        droppedIterations: 0,
        p50Ms: 1_000,
        p95Ms: 1_400,
        p99Ms: 1_500,
      },
      latencyMs: {
        authorizeInit: { p50Ms: 100, p95Ms: 200, p99Ms: 300 },
        totpStart: { p50Ms: 200, p95Ms: 300, p99Ms: 400 },
        totpVerify: { p50Ms: 300, p95Ms: 400, p99Ms: 500 },
        authorizeCode: { p50Ms: 100, p95Ms: 200, p99Ms: 300 },
        token: { p50Ms: 200, p95Ms: 300, p99Ms: 400 },
        totpCompletion: { p50Ms: 600, p95Ms: 900, p99Ms: 1_100 },
        fullFlow: { p50Ms: 1_000, p95Ms: 1_400, p99Ms: 1_500 },
      },
      diagnosticTimingMs: {
        authorizeInit: {
          auth_total: { p50Ms: 90, p95Ms: 180, p99Ms: 270 },
        },
        totpStart: {
          auth_totp_account_route: { p50Ms: 40, p95Ms: 80, p99Ms: 120 },
        },
        totpVerify: {
          auth_totp_session_create: { p50Ms: 30, p95Ms: 60, p99Ms: 90 },
        },
        authorizeCode: {
          auth_authorize_code_store: { p50Ms: 80, p95Ms: 160, p99Ms: 240 },
        },
        token: {
          token_code_consume: { p50Ms: 50, p95Ms: 100, p99Ms: 150 },
        },
      },
      errors: { routing5xx: 0, timeouts: 0, d1Overloaded: 0 },
      coldSamples: [1_700, 1_600, 1_550].map((latencyMs) => ({
        latencyMs,
        servedByRegion: 'unknown',
        servedByPrimary: true,
      })),
    },
    cleanup: {
      users: 'absent',
      client: 'deleted',
      settings: 'restored',
      machinePrincipal: 'deleted',
    },
  } as const;
}

describe('Phase 0c production TOTP load runner', () => {
  it('stops scheduling after the first fixture error and waits for in-flight work', async () => {
    const started: number[] = [];
    const completed: number[] = [];
    await expect(
      mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (value) => {
        started.push(value);
        await new Promise((resolve) => setTimeout(resolve, value === 0 ? 1 : 5));
        if (value === 0) throw new Error('fixture_failed');
        completed.push(value);
        return value;
      })
    ).rejects.toThrow('fixture_failed');
    expect(started).toEqual([0, 1]);
    expect(completed).toEqual([1]);
  });

  it('pins a bounded sample and the fixed 25 LPS/five-minute gate', () => {
    expect(PHASE0C_TOTP_LOAD_PROFILES.sample).toMatchObject({
      ratePerSecond: 1,
      warmupSeconds: 3,
      measurementSeconds: 10,
      userCount: 16,
      provisioningConcurrency: 1,
    });
    expect(PHASE0C_TOTP_LOAD_PROFILES.gate).toMatchObject({
      ratePerSecond: 25,
      warmupSeconds: 30,
      measurementSeconds: 300,
      userCount: 1_003,
    });
    expect(phase0cTotpReuseIntervalSeconds('gate')).toBeGreaterThan(30);
  });

  it('keeps only allowlisted stage and cleanup diagnostics', () => {
    expect(
      safePhase0cTotpLoadExecutionError(
        new Error(
          'phase0c_totp_load_cleanup_incomplete:settings_cleanup_failed,user_reconciliation_failed:phase0c_totp_load_stage_fixture_setup_failed'
        )
      )
    ).toBe(
      'phase0c_totp_load_cleanup_incomplete:settings_cleanup_failed,user_reconciliation_failed:phase0c_totp_load_stage_fixture_setup_failed'
    );
    expect(safePhase0cTotpLoadExecutionError(new Error('secret@example.com'))).toBe(
      'phase0c_totp_execution_failed'
    );
  });

  it('requires explicit test-data authorization, a fixed profile, and a temporary result', () => {
    expect(
      parsePhase0cTotpLoadArgs([
        '--',
        '--env',
        'test',
        '--profile',
        'sample',
        '--confirm-test-data',
        '--result',
        '/private/tmp/totp-load.json',
      ])
    ).toEqual({
      environment: 'test',
      profile: 'sample',
      confirmTestData: true,
      resultPath: '/private/tmp/totp-load.json',
    });
    expect(() =>
      parsePhase0cTotpLoadArgs([
        '--env',
        'test',
        '--profile',
        'custom',
        '--confirm-test-data',
        '--result',
        '/private/tmp/result.json',
      ])
    ).toThrow('phase0c_totp_load_profile_required');
    expect(() =>
      parsePhase0cTotpLoadArgs([
        '--env',
        'test',
        '--profile',
        'gate',
        '--confirm-test-data',
        '--result',
        './result.json',
      ])
    ).toThrow('phase0c_totp_load_result_must_use_temporary_json_path');
  });

  it('accepts only cleaned, secret-free production-path evidence', () => {
    const value = evidence();
    expect(
      validatePhase0cTotpLoadEvidence({
        evidence: value,
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: ['admin-secret', 'totp-secret'],
      })
    ).toEqual(value);
    expect(() =>
      validatePhase0cTotpLoadEvidence({
        evidence: { ...value, diagnostic: 'totp-secret' },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: ['totp-secret'],
      })
    ).toThrow('phase0c_totp_load_evidence_contains_forbidden_value');
    expect(() =>
      validatePhase0cTotpLoadEvidence({
        evidence: { ...value, userPool: { count: 32, sameTimeStepReuse: false } },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [],
      })
    ).toThrow('phase0c_totp_load_evidence_invalid');
    expect(() =>
      validatePhase0cTotpLoadEvidence({
        evidence: {
          ...value,
          scenarioResult: {
            ...value.scenarioResult,
            diagnosticTimingMs: {
              ...value.scenarioResult.diagnosticTimingMs,
              authorizeCode: {
                unknown_metric: { p50Ms: 1, p95Ms: 2, p99Ms: 3 },
              },
            },
          },
        },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [],
      })
    ).toThrow('phase0c_totp_load_evidence_invalid');
  });

  it('schedules the exact arrival count and records operation failures', async () => {
    const users = [
      { email: 'one', userId: 'one', secret: 'one', profile: {} },
      { email: 'two', userId: 'two', secret: 'two', profile: {} },
    ] as never;
    let calls = 0;
    const result = await runPhase0cTotpArrivalWindow({
      ratePerSecond: 2,
      durationSeconds: 1,
      maximumConcurrency: 2,
      users,
      startingUserIndex: 0,
      operation: async () => {
        calls += 1;
        if (calls === 2) throw new Error('phase0c_totp_token_failed:503');
        return {
          success: true,
          latencyMs: {
            authorizeInit: 1,
            totpStart: 2,
            totpVerify: 3,
            authorizeCode: 1,
            token: 2,
            totpCompletion: 6,
            fullFlow: 10,
          },
          diagnosticTimingMs: {
            authorizeInit: { auth_total: 1 },
            totpStart: { auth_totp_account_route: 2 },
            totpVerify: { auth_totp_session_create: 3 },
            authorizeCode: { auth_authorize_code_store: 2 },
            token: { token_code_consume: 4 },
          },
        };
      },
    });
    expect(result).toMatchObject({
      scheduledIterations: 2,
      successCount: 1,
      failureCount: 1,
      droppedIterations: 0,
      errors: { routing5xx: 1, timeouts: 0, d1Overloaded: 0 },
      diagnosticTimingMs: {
        authorizeInit: { auth_total: [1] },
        totpStart: { auth_totp_account_route: [2] },
        totpVerify: { auth_totp_session_create: [3] },
        authorizeCode: { auth_authorize_code_store: [2] },
        token: { token_code_consume: [4] },
      },
    });
  });

  it('uses production auth endpoints and no test inbox endpoint', async () => {
    const source = await readFile(new URL('./phase0c-totp-load-live.ts', import.meta.url), 'utf8');
    expect(source).toContain('createPhase0cTotpUser');
    expect(source).toContain('runPhase0cTotpFullLogin');
    expect(source).toContain('findPhase0cUserIdByExactEmail');
    expect(source).toContain('waitForPhase0cTotpUserAbsent');
    expect(source).toContain('startedEmails.push(email)');
    expect(source).toContain('mapConcurrent(\n      plannedEmails');
    expect(source).toContain('mapConcurrent(unresolvedEmails');
    expect(source).toContain('const cleanupConcurrency = Math.min(16');
    expect(source).toContain('startedEmails.filter((email) => !deletedEmails.has(email))');
    expect(source).toContain('firstError ??= error');
    expect(source).toContain('if (firstError !== undefined) throw firstError');
    expect(source).toContain('createdUsers.push(created)');
    expect(source).toContain('mapConcurrent(createdUsers');
    expect(source).toContain(
      'The exact-email reconciliation below is the authoritative response-loss cleanup pass.'
    );
    expect(source).toContain('The bounded absence check below retries transient Admin reads.');
    expect(source).toContain(
      'A lost delete response is resolved by the authoritative absence check below.'
    );
    expect(source).toContain('cleanupPhase0cMachinePrincipal');
    expect(source).not.toContain('/api/admin/test/email-codes');
    expect(source).toContain('sameTimeStepReuse: false');
    expect(source).toContain("sensitiveValues.fill('')");
    expect(source).toContain("user.secret = ''");
    expect(source).toContain('JSON.stringify(validatedEvidence');
    expect(source).toContain('mode: 0o600');
  });

  it('recognizes only the repository load-runner path as its entrypoint', () => {
    expect(
      isPhase0cTotpLoadEntrypoint(
        '/private/tmp/repository/scripts/control-plane/phase0c-totp-load-live.ts',
        '/private/tmp/repository'
      )
    ).toBe(true);
    expect(isPhase0cTotpLoadEntrypoint('/private/tmp/vitest.mjs')).toBe(false);
  });
});
