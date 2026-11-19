import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  isTokenRequestDiagnosticTimingEnabled,
  timeTokenRequestDiagnosticOperation,
} from '../request-diagnostics';
import { getRequestIssuer } from '../issuer';

type DiagnosticState = { lastMarkAt: number; spans: Array<{ name: string; durationMs: number }> };

/** Context whose diagnostic state is reachable only under the shared context key. */
function contextWith(state: DiagnosticState | undefined): Context<{ Bindings: Env }> {
  return {
    get: (key: string) => (key === 'authrimTokenRequestDiagnostics' ? state : undefined),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('token diagnostic timing flag', () => {
  it.each(['true', 'TRUE', ' Yes ', '1', 'yes'])('enables operator diagnostics for %j', (flag) => {
    expect(
      isTokenRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag } as Env,
        'operator-session'
      )
    ).toBe(true);
  });

  it.each(['false', '0', 'no', '', 'on'])('keeps diagnostics off for %j', (flag) => {
    expect(
      isTokenRequestDiagnosticTimingEnabled(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: flag } as Env,
        'operator-session'
      )
    ).toBe(false);
  });

  it('anchors the Phase 0c run id pattern at both ends', () => {
    const env = { AUTHRIM_ENVIRONMENT_NAME: 'test' } as Env;
    expect(isTokenRequestDiagnosticTimingEnabled(env, 'phase0c-mail-20260731102030-abcdef')).toBe(
      true
    );
    expect(isTokenRequestDiagnosticTimingEnabled(env, 'x-phase0c-mail-20260731102030-abcdef')).toBe(
      false
    );
    expect(
      isTokenRequestDiagnosticTimingEnabled(env, 'phase0c-mail-20260731102030-abcdef-extra')
    ).toBe(false);
  });
});

describe('timeTokenRequestDiagnosticOperation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs the operation without recording when no diagnostic state exists', async () => {
    const now = vi.spyOn(performance, 'now');
    await expect(
      timeTokenRequestDiagnosticOperation(contextWith(undefined), 'op', async () => 'value')
    ).resolves.toBe('value');
    expect(now).not.toHaveBeenCalled();
  });

  it('records a span rounded to 0.1 ms and advances the last mark', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(112.34);
    const state: DiagnosticState = { lastMarkAt: 0, spans: [] };
    await expect(
      timeTokenRequestDiagnosticOperation(contextWith(state), 'db_lookup', async () => 42)
    ).resolves.toBe(42);
    expect(state.spans).toEqual([{ name: 'db_lookup', durationMs: 12.3 }]);
    expect(state.lastMarkAt).toBe(112.34);
  });

  it('records the span even when the operation fails', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(15.06);
    const state: DiagnosticState = { lastMarkAt: 0, spans: [] };
    await expect(
      timeTokenRequestDiagnosticOperation(contextWith(state), 'failing', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(state.spans).toEqual([{ name: 'failing', durationMs: 5.1 }]);
    expect(state.lastMarkAt).toBe(15.06);
  });
});

describe('getRequestIssuer tenant trimming', () => {
  it('passes the trimmed tenant id to tenant-subdomain issuer resolution', () => {
    const context = {
      get: () => '  tenant-a  ',
      req: { raw: null },
      env: { BASE_DOMAIN: 'auth.example.com' },
    } as unknown as Context<{ Bindings: Env }>;
    expect(getRequestIssuer(context)).toBe('https://tenant-a.auth.example.com');
  });
});
