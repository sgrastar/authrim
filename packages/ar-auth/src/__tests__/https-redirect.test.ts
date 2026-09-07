import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import app, { isAuthRequestDiagnosticTimingEnabled } from '../index';

describe('auth HTTPS redirect', () => {
  it('redirects external HTTP requests to HTTPS before route handling', async () => {
    const response = await app.request('http://first.test.authrim.com/login');

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://first.test.authrim.com/login');
  });
});

describe('auth Phase 0c request diagnostics', () => {
  const mailRunId = 'phase0c-mail-20260731102030-abcdef';
  const totpRunId = 'phase0c-totp-20260731102030-abcdef';

  it('auto-enables only valid Mail and TOTP runs in the test environment', () => {
    expect(
      isAuthRequestDiagnosticTimingEnabled({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, mailRunId)
    ).toBe(true);
    expect(
      isAuthRequestDiagnosticTimingEnabled({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, totpRunId)
    ).toBe(true);
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'test-ucp' } as Env,
        mailRunId
      )
    ).toBe(true);
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'testing' } as Env,
        mailRunId
      )
    ).toBe(false);
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'production' } as Env,
        totpRunId
      )
    ).toBe(false);
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env,
        'phase0c-mail-invalid'
      )
    ).toBe(false);
  });

  it('still permits explicitly enabled operator diagnostics with a session id', () => {
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' } as Env,
        'operator-session'
      )
    ).toBe(true);
    expect(
      isAuthRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' } as Env,
        null
      )
    ).toBe(false);
  });
});
