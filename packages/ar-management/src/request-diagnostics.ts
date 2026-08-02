import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

export const MANAGEMENT_REQUEST_DIAGNOSTIC_CONTEXT_KEY = 'authrimManagementRequestDiagnostics';

interface ManagementRequestDiagnosticState {
  lastMarkAt: number;
  spans: Array<{ name: string; durationMs: number }>;
}

function getManagementRequestDiagnosticState(
  c: Context<{ Bindings: Env }>
): ManagementRequestDiagnosticState | null {
  return (
    ((c as unknown as { get(key: string): unknown }).get(
      MANAGEMENT_REQUEST_DIAGNOSTIC_CONTEXT_KEY
    ) as ManagementRequestDiagnosticState | undefined) ?? null
  );
}

export async function timeManagementRequestDiagnosticOperation<T>(
  c: Context<{ Bindings: Env }>,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const state = getManagementRequestDiagnosticState(c);
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
