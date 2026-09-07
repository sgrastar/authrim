import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

export const AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY = 'authrimRequestDiagnostics';

interface AuthRequestDiagnosticState {
  lastMarkAt: number;
  spans: Array<{ name: string; durationMs: number }>;
}

function getAuthRequestDiagnosticState(
  c: Context<{ Bindings: Env }>
): AuthRequestDiagnosticState | null {
  return (
    ((c as unknown as { get(key: string): unknown }).get(AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY) as
      | AuthRequestDiagnosticState
      | undefined) ?? null
  );
}

export async function timeAuthRequestDiagnosticOperation<T>(
  c: Context<{ Bindings: Env }>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const state = getAuthRequestDiagnosticState(c);
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
