import { describe, expect, it } from 'vitest';
import {
  DelegatedWriteEnvelopeError,
  createDelegatedWriteEnvelopeErrorResponse,
  parseDelegatedWriteEnvelope,
} from '../delegated-write';

describe('delegated write envelope', () => {
  it('requires the input sibling field', () => {
    expect(() => parseDelegatedWriteEnvelope({ audit: { reason_code: 'repair' } })).toThrow(
      DelegatedWriteEnvelopeError
    );
  });

  it('rejects step_up_receipt in the body', () => {
    try {
      parseDelegatedWriteEnvelope({
        input: {},
        step_up_receipt: 'receipt-in-body',
      });
      throw new Error('expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DelegatedWriteEnvelopeError);
      expect((error as DelegatedWriteEnvelopeError).field).toBe('step_up_receipt');
    }
  });

  it('normalizes allowed audit fields', () => {
    const envelope = parseDelegatedWriteEnvelope<{ display_name: string }>({
      input: {
        display_name: 'Yuta',
      },
      audit: {
        reason_code: ' admin_repair ',
        reason_note: ' approved by on-call\nwith ticket ',
        reference_id: ' CASE-123 ',
      },
    });

    expect(envelope.input.display_name).toBe('Yuta');
    expect(envelope.audit).toEqual({
      reason_code: 'admin_repair',
      reason_note: 'approved by on-call\nwith ticket',
      reference_id: 'CASE-123',
    });
  });

  it('rejects unknown audit fields with machine-readable details', async () => {
    let delegatedError: DelegatedWriteEnvelopeError | null = null;
    try {
      parseDelegatedWriteEnvelope({
        input: {},
        audit: {
          reason_code: 'repair',
          ticket_id: 'CASE-123',
        },
      });
    } catch (error) {
      delegatedError = error as DelegatedWriteEnvelopeError;
    }

    expect(delegatedError).toBeInstanceOf(DelegatedWriteEnvelopeError);
    expect(delegatedError?.error).toBe('unknown_audit_field');
    expect(delegatedError?.field).toBe('audit.ticket_id');

    const response = createDelegatedWriteEnvelopeErrorResponse(delegatedError!);
    const body = (await response.json()) as { error: string; error_details?: { code?: string; field?: string } };

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.error).toBe('unknown_audit_field');
    expect(body.error_details?.code).toBe('unknown_audit_field');
    expect(body.error_details?.field).toBe('audit.ticket_id');
  });

  it('rejects empty audit objects after normalization', () => {
    expect(() =>
      parseDelegatedWriteEnvelope({
        input: {},
        audit: {
          reason_note: '   ',
        },
      })
    ).toThrow(DelegatedWriteEnvelopeError);
  });
});
