import type { Context } from 'hono';
/** Shared API errors for a bounded log view. No legacy archive reader or database fallback lives here. */
export type LogSqlRow = Record<string, string | number | null>;
export type LogDataset = string;
export interface LogReadWindow {
  fromMs?: number;
  toMs?: number;
}

export class LogQueryIncompleteError extends Error {
  constructor() {
    super('Log results are incomplete. Narrow the time range or retry later.');
    this.name = 'LogQueryIncompleteError';
  }
}

export class LogQueryInvalidRequestError extends Error {}

export function logQueryErrorResponse(c: Context, error: unknown): Response | undefined {
  if (error instanceof LogQueryInvalidRequestError)
    return c.json({ error: 'invalid_request', error_description: error.message }, 400);
  if (!(error instanceof LogQueryIncompleteError)) return;
  return c.json(
    { error: 'log_query_incomplete', error_description: error.message, complete: false },
    503
  );
}
