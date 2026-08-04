import { describe, expect, it, vi } from 'vitest';
import {
  buildPhase0cK6Environment,
  createPhase0cMailRunId,
  formatPhase0cCleanupProgress,
  formatPhase0cSeedProgress,
  isRunScopedPhase0cCleanup,
  mapPhase0cBounded,
  parsePhase0cMailOtpLiveArgs,
  parsePhase0cStepFailure,
  PHASE0C_MACHINE_PRINCIPAL_TYPE,
  resolvePhase0cMailRunId,
  safeAdminErrorDetails,
  safePhase0cCleanupError,
  safePhase0cExecutionError,
  strictPhase0cLiveConfig,
  strictTenantPiiDatabaseNames,
  strictTenantUsersDatabaseNames,
  validatePhase0cMailLoadEvidence,
  validatePhase0cMailPreGateEvidence,
  validatePhase0cMailSampleEvidence,
  validatePhase0cMailSmokeEvidence,
  validatePhase0cRuntimeTopology,
} from './phase0c-mail-otp-live.js';

describe('Phase 0c Mail OTP live runner', () => {
  const runtimeTopology = {
    placementPolicy: 'tenant_exclusive' as const,
    placementPolicyGeneration: 3,
  };

  it('formats bounded seed progress without exposing user identifiers', () => {
    expect(
      formatPhase0cSeedProgress({
        completed: 250,
        total: 1000,
        retries: 3,
        recovered: 2,
        elapsedMs: 50_000,
        status: 'running',
      })
    ).toBe(
      '[seed] 250/1000 (25.0%) | status=running | retries=3 | recovered=2 | rate=5.0 users/s | elapsed=50s | ETA=2m30s'
    );
  });

  it('formats bounded cleanup progress without exposing user identifiers', () => {
    expect(
      formatPhase0cCleanupProgress({
        completed: 500,
        total: 1000,
        errors: 2,
        elapsedMs: 250_000,
        status: 'running',
      })
    ).toBe(
      '[cleanup] 500/1000 (50.0%) | status=running | errors=2 | rate=2.0 users/s | elapsed=4m10s | ETA=4m10s'
    );
  });

  it('waits for admitted seed operations before surfacing a worker failure', async () => {
    let releaseFailure!: () => void;
    let releaseInFlight!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const inFlightGate = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    const started: number[] = [];
    let inFlightCompleted = false;
    const mapped = mapPhase0cBounded([0, 1, 2], 2, async (_value, index) => {
      started.push(index);
      if (index === 0) {
        await failureGate;
        throw new Error('seed_failed');
      }
      await inFlightGate;
      inFlightCompleted = true;
      return index;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releaseFailure();
    let settled = false;
    void mapped.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseInFlight();
    await expect(mapped).rejects.toThrow('seed_failed');
    expect(inFlightCompleted).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('parses only bounded secret-free k6 step failure signatures', () => {
    expect(
      parsePhase0cStepFailure(
        'time="x" level=error msg="PHASE0C_STEP_FAILURE ts=1785715200123 step=email_code_verify status=500 code=server_error marker_end=1"'
      )
    ).toEqual({
      step: 'email_code_verify',
      status: 500,
      code: 'server_error',
      firstTimestampMs: 1785715200123,
      lastTimestampMs: 1785715200123,
    });
    expect(
      parsePhase0cStepFailure(
        'PHASE0C_STEP_FAILURE ts=1785715200123 step=email_code_verify status=500 code=bad value marker_end=1'
      )
    ).toBeNull();
  });

  it('derives benchmark labels from the server-verified runtime topology', () => {
    expect(
      validatePhase0cRuntimeTopology({
        runtime_profile: {
          placement_policy: 'tenant_exclusive',
          placement_policy_generation: 3,
        },
      })
    ).toEqual(runtimeTopology);
    expect(() =>
      validatePhase0cRuntimeTopology({
        runtime_profile: {
          placement_policy: 'shared_pool',
          placement_policy_generation: 3,
        },
      })
    ).toThrow('phase0c_mail_placement_policy_mismatch');
    expect(() =>
      validatePhase0cRuntimeTopology({
        runtime_profile: {
          placement_policy: 'tenant_exclusive',
          placement_policy_generation: 0,
        },
      })
    ).toThrow('phase0c_mail_placement_policy_generation_invalid');
  });
  it('uses a principal type accepted by the Admin D1 schema', () => {
    expect(PHASE0C_MACHINE_PRINCIPAL_TYPE).toBe('automation');
  });

  it('reuses the interrupted run id for cleanup credentials and reconciliation', () => {
    const cleanupRunId = 'phase0c-mail-20260803113902-222f43';
    expect(
      resolvePhase0cMailRunId(
        {
          environment: 'test',
          confirmTestData: true,
          mode: 'cleanup_interrupted',
          cleanupRunId,
        },
        'phase0c-mail-20260803120000-abcdef'
      )
    ).toBe(cleanupRunId);
    expect(
      isRunScopedPhase0cCleanup({
        environment: 'test',
        confirmTestData: true,
        mode: 'cleanup_interrupted',
        cleanupRunId,
      })
    ).toBe(true);
  });

  it('keeps admin failure diagnostics bounded and redacts email addresses', () => {
    expect(
      safeAdminErrorDetails({
        error: 'server_error',
        error_description: 'Failed',
        message: 'Public diagnostic',
        details: 'User phase0c@example.invalid was rejected\nby storage',
      })
    ).toBe('server_error:Failed:Public diagnostic:User [redacted-email] was rejected by storage');
    expect(safePhase0cExecutionError(new Error('phase0c_mail_seed_user_operation_blocked'))).toBe(
      'phase0c_mail_seed_user_operation_blocked'
    );
    expect(safePhase0cExecutionError(new Error('failed:user@example.test'))).toBe(
      'phase0c_mail_execution_failed'
    );
    expect(
      safePhase0cCleanupError(
        new Error(
          'phase0c_mail_admin_request_failed:DELETE:/api/admin/users/user-a:404:not_found:ignored details'
        )
      )
    ).toBe('admin_delete_failed:404:not_found');
  });

  it('requires explicit disposable test authorization and a temporary JSON result', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--result',
        '/private/tmp/phase0c-mail.json',
        '--confirm-test-data',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'pre_gate',
      resultPath: '/private/tmp/phase0c-mail.json',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'production',
        '--result',
        '/private/tmp/result.json',
        '--confirm-test-data',
      ])
    ).toThrow('phase0c_mail_test_environment_required');
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--result',
        './result.json',
        '--confirm-test-data',
      ])
    ).toThrow('phase0c_mail_result_must_use_temporary_json_path');
    expect(() =>
      parsePhase0cMailOtpLiveArgs(['--env', 'test', '--result', '/private/tmp/result.json'])
    ).toThrow('phase0c_mail_test_data_confirmation_required');
  });

  it('allows a named disposable test environment while rejecting prefix and config mismatch', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test-ucp',
        '--confirm-test-data',
        '--smoke',
        '--result',
        '/private/tmp/test-ucp-mail-smoke.json',
      ])
    ).toMatchObject({ environment: 'test-ucp', mode: 'smoke' });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'testing',
        '--confirm-test-data',
        '--result',
        '/private/tmp/result.json',
      ])
    ).toThrow('phase0c_mail_test_environment_required');

    const config = {
      environment: { prefix: 'test-ucp' },
      tenant: { name: 'default' },
      urls: { api: { custom: null, auto: 'https://test-ucp.example.workers.dev' } },
    };
    expect(strictPhase0cLiveConfig(config, 'test-ucp')).toBe(config);
    expect(() => strictPhase0cLiveConfig(config, 'test-other')).toThrow(
      'phase0c_mail_config_invalid'
    );
  });

  it('allows only an explicitly confirmed test-only interrupted cleanup mode', () => {
    expect(
      parsePhase0cMailOtpLiveArgs(['--env', 'test', '--confirm-test-data', '--cleanup-interrupted'])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'cleanup_interrupted',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--cleanup-interrupted',
        '--result',
        '/private/tmp/result.json',
      ])
    ).toThrow('phase0c_mail_cleanup_result_not_allowed');
    const cleanupRunId = 'phase0c-mail-20260731102030-abcdef';
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--cleanup-interrupted',
        '--cleanup-run-id',
        cleanupRunId,
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'cleanup_interrupted',
      cleanupRunId,
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--cleanup-interrupted',
        '--cleanup-run-id',
        'invalid',
      ])
    ).toThrow('phase0c_mail_cleanup_run_id_invalid');
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--cleanup-interrupted',
        '--cleanup-run-id',
      ])
    ).toThrow('phase0c_mail_cleanup_run_id_missing');
  });

  it('supports an explicit one-flow smoke mode without weakening cleanup guards', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--smoke',
        '--result',
        '/private/tmp/smoke.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'smoke',
      resultPath: '/private/tmp/smoke.json',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--smoke',
        '--cleanup-interrupted',
      ])
    ).toThrow('phase0c_mail_mode_conflict');
  });

  it('supports a bounded sample mode that is distinct from smoke and the release gate', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--sample',
        '--result',
        '/private/tmp/sample.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'sample',
      resultPath: '/private/tmp/sample.json',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--sample',
        '--smoke',
        '--result',
        '/private/tmp/sample.json',
      ])
    ).toThrow('phase0c_mail_mode_conflict');
  });

  it('supports a bounded two-LPS pre-gate without weakening the fixed release gate', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--pre-gate',
        '--result',
        '/private/tmp/pre-gate.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'pre_gate',
      resultPath: '/private/tmp/pre-gate.json',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--pre-gate',
        '--sample',
        '--result',
        '/private/tmp/pre-gate.json',
      ])
    ).toThrow('phase0c_mail_mode_conflict');
  });

  it('supports separate 25-LPS contention and unique-user load diagnostics', () => {
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--contention',
        '--result',
        '/private/tmp/contention.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'contention',
      resultPath: '/private/tmp/contention.json',
    });
    expect(
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--load',
        '--result',
        '/private/tmp/load.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      mode: 'load',
      resultPath: '/private/tmp/load.json',
    });
    expect(() =>
      parsePhase0cMailOtpLiveArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--load',
        '--contention',
        '--result',
        '/private/tmp/load.json',
      ])
    ).toThrow('phase0c_mail_mode_conflict');
  });

  it('configures prompt=none and a token target only on the disposable benchmark client', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('./phase0c-mail-otp-live.ts', import.meta.url), 'utf8')
    );
    expect(source).toContain("'client.sso_enabled': true");
    expect(source).toContain("path: '/api/admin/client-trust-policies'");
    expect(source).toContain("target_type: 'oidc_client'");
    expect(source).toContain('target_id: oauthClientId');
    expect(source).toContain('skip_authorization_consent: true');
    expect(source).not.toContain("'client.first_party': true");
    expect(source).not.toContain("'client.consent_required': false");
    expect(source).toContain('default_resource: baseUrl');
    expect(source).toContain('phase0c_mail_client_settings_version_missing');
    expect(source).toContain('email_verified: true');
    expect(source).not.toContain('email_verified: false');
  });

  it('selects only valid tenant users D1 resources for interrupted cleanup', () => {
    expect(
      strictTenantUsersDatabaseNames({
        d1: {
          DB_ADMIN: { name: 'test-admin' },
          TDB_USERS_B_CORE: { name: 'test-users-b' },
          TDB_USERS_A_CORE: { name: 'test-users-a' },
          TDB_PII_A_PII: { name: 'test-pii-a' },
        },
      })
    ).toEqual(['test-users-a', 'test-users-b']);
    expect(() =>
      strictTenantUsersDatabaseNames({
        d1: { TDB_USERS_A_CORE: { name: '../invalid' } },
      })
    ).toThrow('phase0c_mail_users_databases_invalid');
  });

  it('selects only valid tenant PII D1 resources for abandoned benchmark cleanup', () => {
    expect(
      strictTenantPiiDatabaseNames({
        d1: {
          DB_PII: { name: 'test-legacy-pii' },
          TDB_PII_B_PII: { name: 'test-pii-b' },
          TDB_PII_A_PII: { name: 'test-pii-a' },
          TDB_USERS_A_CORE: { name: 'test-users-a' },
        },
      })
    ).toEqual(['test-pii-a', 'test-pii-b']);
    expect(() =>
      strictTenantPiiDatabaseNames({
        d1: { TDB_PII_A_PII: { name: '../invalid' } },
      })
    ).toThrow('phase0c_mail_pii_databases_invalid');
  });

  it('avoids wildcard matching when reconciling an exact Phase 0c run', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('./phase0c-mail-otp-live.ts', import.meta.url), 'utf8')
    );
    expect(source).toContain("instr(value_json, '\"${input.runId}-') = 1");
    expect(source).toContain("substr(value_json, -length('@test.authrim.internal\"'))");
    expect(source).not.toContain('value_json LIKE \'"${input.runId}');
  });

  it('builds a deterministic run id and an allowlisted child environment', () => {
    const runId = createPhase0cMailRunId(
      new Date('2026-07-31T10:20:30.000Z'),
      'abcdef00-0000-0000-0000-000000000000'
    );
    expect(runId).toBe('phase0c-mail-20260731102030-abcdef');
    const environment = buildPhase0cK6Environment({
      baseUrl: 'https://test.authrim.com',
      tenantId: 'default',
      clientId: 'client',
      clientSecret: 'client-secret',
      accessToken: 'access-token',
      userListPath: '/private/tmp/users.txt',
      resultPath: '/private/tmp/result.json',
      runId,
      runtimeTopology,
      parentEnv: {
        PATH: '/usr/bin',
        CLOUDFLARE_API_TOKEN: 'must-not-propagate',
      },
    });
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(environment.ADMIN_MACHINE_ACCESS_TOKEN).toBe('access-token');
    expect(environment.CLIENT_SECRET).toBe('client-secret');
    expect(environment.TENANT_PLACEMENT_POLICY).toBe('tenant_exclusive');
    expect(
      buildPhase0cK6Environment({
        baseUrl: 'https://test.authrim.com',
        tenantId: 'default',
        clientId: 'client',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
        userListPath: '/private/tmp/users.txt',
        resultPath: '/private/tmp/result.json',
        runId,
        runtimeTopology,
        preset: 'phase0c-smoke',
        parentEnv: { PATH: '/usr/bin' },
      }).PRESET
    ).toBe('phase0c-smoke');
    expect(
      buildPhase0cK6Environment({
        baseUrl: 'https://test.authrim.com',
        tenantId: 'default',
        clientId: 'client',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
        userListPath: '/private/tmp/users.txt',
        resultPath: '/private/tmp/result.json',
        runId,
        runtimeTopology,
        preset: 'phase0c-sample',
        parentEnv: { PATH: '/usr/bin' },
      }).PRESET
    ).toBe('phase0c-sample');
    expect(
      buildPhase0cK6Environment({
        baseUrl: 'https://test.authrim.com',
        tenantId: 'default',
        clientId: 'client',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
        userListPath: '/private/tmp/users.txt',
        resultPath: '/private/tmp/result.json',
        runId,
        runtimeTopology,
        preset: 'phase0c-pre-gate',
        parentEnv: { PATH: '/usr/bin' },
      }).PRESET
    ).toBe('phase0c-pre-gate');
    expect(
      buildPhase0cK6Environment({
        baseUrl: 'https://test.authrim.com',
        tenantId: 'default',
        clientId: 'client',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
        userListPath: '/private/tmp/users.txt',
        resultPath: '/private/tmp/result.json',
        runId,
        runtimeTopology,
        preset: 'phase0c-load',
        parentEnv: { PATH: '/usr/bin' },
      }).PRESET
    ).toBe('phase0c-load');
  });

  it('accepts a secret-free load result without applying a release gate', () => {
    const evidence = {
      runId: 'phase0c-mail-20260731102030-abcdef',
      tenantId: 'default',
      metrics: { iterations: 7500, flow_success_rate: 0.99 },
    };
    expect(
      validatePhase0cMailLoadEvidence({
        evidence,
        runId: evidence.runId,
        tenantId: evidence.tenantId,
        forbiddenValues: ['access-token', 'client-secret'],
      })
    ).toBe(evidence);
  });

  it('accepts only one successful secret-free smoke iteration', () => {
    const evidence = {
      runId: 'phase0c-mail-20260731102030-abcdef',
      tenantId: 'default',
      metrics: {
        iterations: 1,
        flow_success_rate: 1,
        errors: { rate_limit: 0, server: 0, timeout: 0, d1_overloaded: 0 },
      },
    };
    expect(
      validatePhase0cMailSmokeEvidence({
        evidence,
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: ['access-token', 'client-secret'],
      })
    ).toBe(evidence);
    expect(() =>
      validatePhase0cMailSmokeEvidence({
        evidence: {
          ...evidence,
          metrics: { ...evidence.metrics, flow_success_rate: 0 },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toThrow('phase0c_mail_smoke_evidence_invalid');
  });

  it('accepts only a 60-second boundary-safe error-free bounded sample', () => {
    const evidence = {
      runId: 'phase0c-mail-20260731102030-abcdef',
      tenantId: 'default',
      phase0c_sample: {
        warmup: { durationSeconds: 15, ratePerSecond: 1, excludedFromMeasurement: true },
        measurement: {
          durationSeconds: 60,
          ratePerSecond: 1,
          successCount: 60,
          failureCount: 0,
          droppedIterations: 0,
          p95Ms: 4_000,
        },
        errors: { rateLimited: 0, routing5xx: 0, timeouts: 0, d1Overloaded: 0 },
      },
    };
    expect(
      validatePhase0cMailSampleEvidence({
        evidence,
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: ['access-token', 'client-secret'],
      })
    ).toBe(evidence);
    expect(
      validatePhase0cMailSampleEvidence({
        evidence: {
          ...evidence,
          phase0c_sample: {
            ...evidence.phase0c_sample,
            measurement: { ...evidence.phase0c_sample.measurement, successCount: 61 },
          },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toBeDefined();
    expect(() =>
      validatePhase0cMailSampleEvidence({
        evidence: {
          ...evidence,
          phase0c_sample: {
            ...evidence.phase0c_sample,
            measurement: { ...evidence.phase0c_sample.measurement, successCount: 62 },
          },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toThrow('phase0c_mail_sample_evidence_invalid');
    expect(() =>
      validatePhase0cMailSampleEvidence({
        evidence: {
          ...evidence,
          phase0c_sample: {
            ...evidence.phase0c_sample,
            measurement: { ...evidence.phase0c_sample.measurement, droppedIterations: 1 },
          },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toThrow('phase0c_mail_sample_evidence_invalid');
  });

  it('accepts only a boundary-safe error-free two-LPS pre-gate', () => {
    const evidence = {
      runId: 'phase0c-mail-20260731102030-abcdef',
      tenantId: 'default',
      phase0c_pre_gate: {
        warmup: { durationSeconds: 15, ratePerSecond: 1, excludedFromMeasurement: true },
        measurement: {
          durationSeconds: 60,
          ratePerSecond: 2,
          successCount: 120,
          failureCount: 0,
          droppedIterations: 0,
          p95Ms: 4_500,
        },
        errors: { rateLimited: 0, routing5xx: 0, timeouts: 0, d1Overloaded: 0 },
      },
    };
    expect(
      validatePhase0cMailPreGateEvidence({
        evidence,
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: ['access-token', 'client-secret'],
      })
    ).toBe(evidence);
    expect(
      validatePhase0cMailPreGateEvidence({
        evidence: {
          ...evidence,
          phase0c_pre_gate: {
            ...evidence.phase0c_pre_gate,
            measurement: { ...evidence.phase0c_pre_gate.measurement, successCount: 122 },
          },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toBeDefined();
    expect(() =>
      validatePhase0cMailPreGateEvidence({
        evidence: {
          ...evidence,
          phase0c_pre_gate: {
            ...evidence.phase0c_pre_gate,
            measurement: { ...evidence.phase0c_pre_gate.measurement, successCount: 119 },
          },
        },
        runId: evidence.runId,
        tenantId: 'default',
        forbiddenValues: [],
      })
    ).toThrow('phase0c_mail_pre_gate_evidence_invalid');
  });

  it('locks evidence permissions before validation can reject a failed sample', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('./phase0c-mail-otp-live.ts', import.meta.url), 'utf8')
    );
    const chmodIndex = source.indexOf('await chmod(options.resultPath, 0o600)');
    const readIndex = source.indexOf('const evidence = await readPhase0cJson(options.resultPath)');
    expect(chmodIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(chmodIndex);
  });
});
