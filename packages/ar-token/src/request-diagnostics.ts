import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const PHASE0C_DIAGNOSTIC_SESSION = /^phase0c-(?:mail|totp)-[0-9]{14}-[a-f0-9]{6}$/u;
export const TOKEN_REQUEST_DIAGNOSTIC_CONTEXT_KEY = 'authrimTokenRequestDiagnostics';

interface TokenRequestDiagnosticState {
  lastMarkAt: number;
  spans: Array<{ name: string; durationMs: number }>;
}

function diagnosticFlagEnabled(env: Env): boolean {
  const value = env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export function isTokenRequestDiagnosticTimingEnabled(env: Env, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return (
    diagnosticFlagEnabled(env) ||
    (env.AUTHRIM_ENVIRONMENT_NAME === 'test' && PHASE0C_DIAGNOSTIC_SESSION.test(sessionId))
  );
}

function getTokenRequestDiagnosticState(
  c: Context<{ Bindings: Env }>
): TokenRequestDiagnosticState | null {
  return (
    ((c as unknown as { get(key: string): unknown }).get(TOKEN_REQUEST_DIAGNOSTIC_CONTEXT_KEY) as
      | TokenRequestDiagnosticState
      | undefined) ?? null
  );
}

export async function timeTokenRequestDiagnosticOperation<T>(
  c: Context<{ Bindings: Env }>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const state = getTokenRequestDiagnosticState(c);
  if (!state) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const now = performance.now();
    state.spans.push({ name, durationMs: Math.round((now - startedAt) * 10) / 10 });
    state.lastMarkAt = now;
  }
}
