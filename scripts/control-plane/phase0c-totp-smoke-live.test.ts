import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getTotpTimeStep } from '../../packages/ar-lib-core/src/utils/totp.js';
import {
  buildTotpSettingsRestorePatch,
  cleanupPhase0cMachinePrincipal,
  createPhase0cTotpRunId,
  isPhase0cTotpEntrypoint,
  parsePhase0cServerTiming,
  parsePhase0cTotpSmokeArgs,
  phase0cTotpActivationTimeStep,
  phase0cTotpServerClockOffsetMs,
  safePhase0cTotpExecutionError,
  validatePhase0cTotpSmokeEvidence,
} from './phase0c-totp-smoke-live.js';

function evidence() {
  return {
    schemaVersion: 1,
    runId: 'phase0c-totp-20260801010203-abcdef',
    tenantId: 'default',
    scenario: 'production_totp_full_login_smoke',
    iterations: 1,
    authenticationBypass: false,
    testInbox: false,
    readReplication: 'disabled',
    success: true,
    latencyMs: {
      authorizeInit: 10,
      totpStart: 510,
      totpVerify: 520,
      authorizeCode: 20,
      token: 30,
      totpCompletion: 570,
      fullFlow: 1090,
    },
    cleanup: {
      user: 'absent',
      client: 'deleted',
      settings: 'restored',
      machinePrincipal: 'deleted',
    },
  };
}

describe('Phase 0c production TOTP smoke runner', () => {
  it('parses only numeric Server-Timing entries', () => {
    expect(
      parsePhase0cServerTiming(
        'auth_authorize_session_read;dur=12.4, auth_csrf;dur=1.5, unknown_metric;dur=99, invalid entry, auth_total;dur=20.0'
      )
    ).toEqual({ auth_authorize_session_read: 12.4, auth_csrf: 1.5, auth_total: 20 });
    expect(parsePhase0cServerTiming('secret;desc="value"')).toEqual({});
  });

  it('requires explicit disposable-test authorization and a temporary result path', () => {
    expect(
      parsePhase0cTotpSmokeArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--result',
        '/private/tmp/phase0c-totp.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      resultPath: '/private/tmp/phase0c-totp.json',
    });
    expect(() =>
      parsePhase0cTotpSmokeArgs([
        '--env',
        'production',
        '--confirm-test-data',
        '--result',
        '/private/tmp/result.json',
      ])
    ).toThrow('phase0c_totp_test_environment_required');
    expect(() =>
      parsePhase0cTotpSmokeArgs(['--env', 'test', '--result', '/private/tmp/result.json'])
    ).toThrow('phase0c_totp_test_data_confirmation_required');
    expect(() =>
      parsePhase0cTotpSmokeArgs([
        '--env',
        'test',
        '--confirm-test-data',
        '--result',
        './result.json',
      ])
    ).toThrow('phase0c_totp_result_must_use_temporary_json_path');
  });

  it('accepts the pnpm argument separator', () => {
    expect(
      parsePhase0cTotpSmokeArgs([
        '--',
        '--env',
        'test',
        '--confirm-test-data',
        '--result',
        '/private/tmp/phase0c-totp.json',
      ])
    ).toEqual({
      environment: 'test',
      confirmTestData: true,
      resultPath: '/private/tmp/phase0c-totp.json',
    });
  });

  it('creates deterministic, secret-free run identifiers', () => {
    expect(
      createPhase0cTotpRunId(
        new Date('2026-08-01T01:02:03.000Z'),
        'abcdef12-3456-7890-abcd-ef1234567890'
      )
    ).toBe('phase0c-totp-20260801010203-abcdef');
  });

  it('uses the prior accepted time step for activation so immediate login is not a replay', () => {
    expect(
      phase0cTotpActivationTimeStep(Date.parse('2026-08-01T00:45:24Z'), {
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
      })
    ).toBe(getTotpTimeStep(Date.parse('2026-08-01T00:45:24Z'), 30) - 1);
  });

  it('calibrates TOTP generation from the Cloudflare response clock', () => {
    const localNow = Date.parse('2026-08-01T00:00:10Z');
    expect(phase0cTotpServerClockOffsetMs('Sat, 01 Aug 2026 00:00:40 GMT', localNow)).toBe(30_000);
    expect(phase0cTotpServerClockOffsetMs(null, localNow)).toBe(0);
  });

  it('recognizes the repository script path as the CLI entrypoint', () => {
    expect(
      isPhase0cTotpEntrypoint(
        '/private/tmp/repository/scripts/control-plane/phase0c-totp-smoke-live.ts',
        '/private/tmp/repository'
      )
    ).toBe(true);
    expect(isPhase0cTotpEntrypoint('/private/tmp/vitest.mjs', '/private/tmp/repository')).toBe(
      false
    );
  });

  it('preserves only known diagnostic codes and drops response details', () => {
    expect(
      safePhase0cTotpExecutionError(
        new Error('phase0c_totp_public_request_failed:/api/auth/totp/signup/options:409:AR000013')
      )
    ).toBe('phase0c_totp_public_request_failed:/api/auth/totp/signup/options:409:AR000013');
    expect(
      safePhase0cTotpExecutionError(
        new Error('phase0c_totp_authorization_code_missing:login_required:client')
      )
    ).toBe('phase0c_totp_authorization_code_missing:login_required:client');
    expect(
      safePhase0cTotpExecutionError(
        new Error(
          'phase0c_totp_public_request_failed:/api/auth/totp/signup/options:409:user@example.com'
        )
      )
    ).toBe('phase0c_totp_execution_failed');
    expect(
      safePhase0cTotpExecutionError(
        new Error(
          'phase0c_totp_cleanup_incomplete:user_absence_check_timeout:phase0c_totp_public_request_failed:/api/auth/totp/signup/activate:503'
        )
      )
    ).toBe(
      'phase0c_totp_cleanup_incomplete:user_absence_check_timeout:phase0c_totp_public_request_failed:/api/auth/totp/signup/activate:503'
    );
    expect(
      safePhase0cTotpExecutionError(
        new Error('phase0c_mail_admin_request_failed:PATCH:/api/admin/settings:403:secret-value')
      )
    ).toBe('phase0c_totp_admin_request_failed:PATCH:403');
    expect(
      safePhase0cTotpExecutionError(
        new Error(
          'phase0c_totp_cleanup_incomplete:user_reconciliation_lookup_failed:phase0c_totp_settings_not_applied'
        )
      )
    ).toBe(
      'phase0c_totp_cleanup_incomplete:user_reconciliation_lookup_failed:phase0c_totp_settings_not_applied'
    );
    expect(safePhase0cTotpExecutionError(new Error('secret-value'))).toBe(
      'phase0c_totp_execution_failed'
    );
  });

  it('allows secret-free authorization timing names in evidence', () => {
    const value = evidence();
    value.diagnosticTimingMs = {
      authorizeInit: {},
      totpStart: {},
      totpVerify: {},
      authorizeCode: {},
      token: { token_authorization_code_lookup: 12.5 },
    };
    expect(
      validatePhase0cTotpSmokeEvidence({
        evidence: value,
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: ['actual-secret-value'],
      })
    ).toEqual(value);
  });

  it('distinguishes secret values from sensitive field names without exposing either', () => {
    const value = evidence();
    expect(() =>
      validatePhase0cTotpSmokeEvidence({
        evidence: value,
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [value.runId],
      })
    ).toThrow('phase0c_totp_evidence_contains_forbidden_value');
    expect(() =>
      validatePhase0cTotpSmokeEvidence({
        evidence: { ...value, access_token: '[redacted]' },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [],
      })
    ).toThrow('phase0c_totp_evidence_contains_sensitive_field');
  });

  it('restores KV-owned values and clears inherited/default overrides', () => {
    const patch = buildTotpSettingsRestorePatch(
      {
        category: 'authentication-methods',
        version: 'before',
        values: {
          'authentication-methods.totp.login_enabled': false,
          'authentication-methods.totp.signup_enabled': true,
          'authentication-methods.totp.preset': 'strong',
          'authentication-methods.human_verification.signup_enabled': true,
        },
        sources: {
          'authentication-methods.totp.login_enabled': 'default',
          'authentication-methods.totp.signup_enabled': 'kv',
          'authentication-methods.totp.preset': 'kv',
          'authentication-methods.human_verification.signup_enabled': 'env',
        },
      },
      'current'
    );

    expect(patch).toEqual({
      ifMatch: 'current',
      set: {
        'authentication-methods.totp.signup_enabled': true,
        'authentication-methods.totp.preset': 'strong',
      },
      clear: [
        'authentication-methods.totp.login_enabled',
        'authentication-methods.human_verification.signup_enabled',
      ],
    });
  });

  it('retries idempotent machine-principal cleanup after response loss', async () => {
    let attempts = 0;
    const delays: number[] = [];
    await cleanupPhase0cMachinePrincipal({
      adminDatabaseName: 'test-authrim-admin-db',
      clientId: 'authrim-phase0c-totp-test',
      principalId: 'amp_phase0c_totp_test',
      principalType: 'automation',
      retryDelayMs: 10,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('response_lost');
        return { stdout: '', stderr: '' };
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([10]);
  });

  it('accepts only a cleaned, production-path, Read Replication-off result', () => {
    const value = evidence();
    expect(
      validatePhase0cTotpSmokeEvidence({
        evidence: value,
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: ['admin-secret', 'totp-secret'],
      })
    ).toEqual(value);

    expect(() =>
      validatePhase0cTotpSmokeEvidence({
        evidence: { ...value, authenticationBypass: true },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [],
      })
    ).toThrow('phase0c_totp_evidence_invalid');
    expect(() =>
      validatePhase0cTotpSmokeEvidence({
        evidence: { ...value, diagnostic: 'totp-secret' },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: ['totp-secret'],
      })
    ).toThrow('phase0c_totp_evidence_contains_forbidden_value');
    expect(() =>
      validatePhase0cTotpSmokeEvidence({
        evidence: { ...value, cleanup: { ...value.cleanup, user: 'deletion_requested' } },
        runId: value.runId,
        tenantId: value.tenantId,
        forbiddenValues: [],
      })
    ).toThrow('phase0c_totp_evidence_invalid');
  });

  it('uses only production auth endpoints and includes response-loss reconciliation', async () => {
    const source = await readFile(new URL('./phase0c-totp-smoke-live.ts', import.meta.url), 'utf8');
    expect(source).toContain("path: '/api/auth/totp/signup/options'");
    expect(source).toContain(
      'phase0c_totp_public_request_failed:/api/auth/totp/signup/options:500:AR900001'
    );
    expect(source).toContain("path: '/api/auth/totp/signup/activate'");
    expect(source).toContain(
      'phase0c_totp_public_request_failed:/api/auth/totp/signup/activate:400:AR000006'
    );
    expect(source).toContain("path: '/api/auth/totp/login/start'");
    expect(source).toContain("path: '/api/auth/totp/login/verify'");
    expect(source).toContain("new URL('/authorize', input.baseUrl)");
    expect(source).toContain("new URL('/token', input.baseUrl)");
    expect(source).not.toContain('/api/admin/test/email-codes');
    expect(source).toContain('findPhase0cUserIdByExactEmail');
    expect(source).toContain('if (adminToken && userCreationStarted)');
    expect(source).toContain('phase0c_totp_stage_${executionStage}_failed');
    expect(source).toContain("cleanupErrors.push('user_reconciliation_lookup_failed')");
    expect(source).toContain('waitForPhase0cTotpUserAbsent');
    expect(source).toContain('mode: 0o600');
    expect(source).toContain('await rm(tempDir, { recursive: true, force: true })');
  });
});
