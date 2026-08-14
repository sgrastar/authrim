import type { Hono } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import type { CallLedger, LedgerExecutionContext } from './call-ledger';

export interface RunResult {
  status: number;
  body: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export async function runFetch(
  app: Hono<{ Bindings: Env }>,
  request: Request,
  env: Env,
  executionCtx: LedgerExecutionContext,
  ledger: CallLedger
): Promise<{ response: Response; drain: () => Promise<void> }> {
  const response = await app.fetch(request, env, executionCtx);
  return { response, drain: () => ledger.drain() };
}

export function formUrlEncoded(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}
