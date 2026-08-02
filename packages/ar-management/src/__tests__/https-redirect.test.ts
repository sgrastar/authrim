import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { app, isManagementRequestDiagnosticTimingEnabled } from '../index';

describe('management HTTPS redirect', () => {
  it('redirects external HTTP requests to HTTPS before route handling', async () => {
    const response = await app.request('http://admin.test.authrim.com/admin');

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://admin.test.authrim.com/admin');
  });
});

describe('management Phase 0c request diagnostics', () => {
  const runId = 'phase0c-mail-20260731102030-abcdef';

  it('auto-enables only a valid run in the test environment', () => {
    expect(
      isManagementRequestDiagnosticTimingEnabled({ AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env, runId)
    ).toBe(true);
    expect(
      isManagementRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'production' } as Env,
        runId
      )
    ).toBe(false);
    expect(
      isManagementRequestDiagnosticTimingEnabled(
        { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env,
        'phase0c-mail-invalid'
      )
    ).toBe(false);
  });

  it('still permits explicitly enabled operator diagnostics with a session id', () => {
    expect(
      isManagementRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'yes' } as Env,
        'operator-session'
      )
    ).toBe(true);
    expect(
      isManagementRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'yes' } as Env,
        null
      )
    ).toBe(false);
  });
});
