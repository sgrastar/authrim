import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { isTokenRequestDiagnosticTimingEnabled } from '../request-diagnostics';

describe('token Phase 0c request diagnostics', () => {
  const runId = 'phase0c-mail-20260731102030-abcdef';
  const totpRunId = 'phase0c-totp-20260731102030-abcdef';

  it('auto-enables only a valid run in the test environment', () => {
    expect(
      isTokenRequestDiagnosticTimingEnabled({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, runId)
    ).toBe(true);
    expect(
      isTokenRequestDiagnosticTimingEnabled({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, totpRunId)
    ).toBe(true);
    expect(
      isTokenRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'production' } as Env,
        runId
      )
    ).toBe(false);
    expect(
      isTokenRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env,
        'phase0c-mail-invalid'
      )
    ).toBe(false);
  });

  it('still permits explicitly enabled operator diagnostics with a session id', () => {
    expect(
      isTokenRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: '1' } as Env,
        'operator-session'
      )
    ).toBe(true);
    expect(
      isTokenRequestDiagnosticTimingEnabled({ AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: '1' } as Env, null)
    ).toBe(false);
  });
});
