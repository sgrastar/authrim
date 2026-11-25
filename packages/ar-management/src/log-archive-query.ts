import type { Context } from 'hono';
import { getLogger, type Env } from '@authrim/ar-lib-core';
/** Shared API errors for a bounded log view. No legacy archive reader or database fallback lives here. */
export type LogSqlRow = Record<string, string | number | null>;
export type LogDataset = string;
export interface LogReadWindow {
  fromMs?: number;
  toMs?: number;
}

export class LogQueryIncompleteError extends Error {
  /** Internal code for the Worker log; the client sees only the generic description. */
  readonly reason: string;
  constructor(reason = 'unspecified') {
    super('Log results are incomplete. Narrow the time range or retry later.');
    this.name = 'LogQueryIncompleteError';
    this.reason = reason;
  }
}

export class LogQueryInvalidRequestError extends Error {}

export function logQueryErrorResponse(c: Context, error: unknown): Response | undefined {
  if (error instanceof LogQueryInvalidRequestError)
    return c.json({ error: 'invalid_request', error_description: error.message }, 400);
  if (!(error instanceof LogQueryIncompleteError)) return;
  // Codes only (no SQL, parameters or row data): the Worker log is the one place the cause is kept.
  getLogger(c as Context<{ Bindings: Env }>)
    .module('LOG_QUERY')
    .error('Log query incomplete', { action: 'log_query', path: c.req.path, reason: error.reason });
  return c.json(
    { error: 'log_query_incomplete', error_description: error.message, complete: false },
    503
  );
}
