import { createPhase1ErrorDetails } from '../errors/details';

export interface DelegatedWriteAudit {
  reason_code?: string;
  reason_note?: string;
  reference_id?: string;
}

export interface DelegatedWriteEnvelope<Input = unknown> {
  input: Input;
  audit?: DelegatedWriteAudit;
}

export type DelegatedWriteEnvelopeErrorCode = 'invalid_request' | 'unknown_audit_field';

export class DelegatedWriteEnvelopeError extends Error {
  readonly error: DelegatedWriteEnvelopeErrorCode;
  readonly field?: string;

  constructor(error: DelegatedWriteEnvelopeErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'DelegatedWriteEnvelopeError';
    this.error = error;
    this.field = field;
  }
}

const ALLOWED_AUDIT_FIELDS = new Set(['reason_code', 'reason_note', 'reference_id']);
const MAX_REASON_NOTE_LENGTH = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeReasonNote(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (Array.from(normalized).length > MAX_REASON_NOTE_LENGTH) {
    throw new DelegatedWriteEnvelopeError(
      'invalid_request',
      'audit.reason_note must be at most 1024 characters',
      'audit.reason_note'
    );
  }
  return normalized;
}

export function parseDelegatedWriteEnvelope<Input = unknown>(
  body: unknown
): DelegatedWriteEnvelope<Input> {
  if (!isRecord(body)) {
    throw new DelegatedWriteEnvelopeError(
      'invalid_request',
      'Delegated write body must be an object'
    );
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'input')) {
    throw new DelegatedWriteEnvelopeError(
      'invalid_request',
      'Delegated write body must include input',
      'input'
    );
  }

  if (Object.prototype.hasOwnProperty.call(body, 'step_up_receipt')) {
    throw new DelegatedWriteEnvelopeError(
      'invalid_request',
      'step_up_receipt must be sent with the Authrim-Step-Up-Receipt header',
      'step_up_receipt'
    );
  }

  const envelope: DelegatedWriteEnvelope<Input> = {
    input: body.input as Input,
  };

  if (body.audit === undefined) {
    return envelope;
  }

  if (!isRecord(body.audit)) {
    throw new DelegatedWriteEnvelopeError('invalid_request', 'audit must be an object', 'audit');
  }

  for (const field of Object.keys(body.audit)) {
    if (!ALLOWED_AUDIT_FIELDS.has(field)) {
      throw new DelegatedWriteEnvelopeError(
        'unknown_audit_field',
        `Unknown audit field: ${field}`,
        `audit.${field}`
      );
    }
  }

  const reasonCode = normalizeOptionalString(body.audit.reason_code);
  const reasonNote = normalizeReasonNote(body.audit.reason_note);
  const referenceId = normalizeOptionalString(body.audit.reference_id);
  const audit: DelegatedWriteAudit = {
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    ...(reasonNote ? { reason_note: reasonNote } : {}),
    ...(referenceId ? { reference_id: referenceId } : {}),
  };

  if (Object.keys(audit).length === 0) {
    throw new DelegatedWriteEnvelopeError(
      'invalid_request',
      'audit must include at least one supported field',
      'audit'
    );
  }

  envelope.audit = audit;
  return envelope;
}

export function createDelegatedWriteEnvelopeErrorResponse(
  error: DelegatedWriteEnvelopeError
): Response {
  return new Response(
    JSON.stringify({
      error: error.error,
      error_description: error.message,
      ...(error.error === 'unknown_audit_field'
        ? {
            error_details: createPhase1ErrorDetails('unknown_audit_field', {
              ...(error.field ? { field: error.field } : {}),
            }),
          }
        : error.field
          ? { field: error.field }
          : {}),
    }),
    {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}
