/**
 * One JSON line per event. Callers pass only the tenant id, a status and a short error code: never
 * a token, an enrolment code, an assertion, a raw IP address or a ticket.
 */
export interface LogFields {
  tenantId?: string;
  status?: number;
  error?: string;
  op?: string;
  detail?: string;
}

export function logEvent(event: string, fields: LogFields = {}): void {
  // eslint-disable-next-line no-console -- structured log line
  console.log(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, fields: LogFields = {}): void {
  // eslint-disable-next-line no-console -- structured log line
  console.error(JSON.stringify({ event, ...fields }));
}
