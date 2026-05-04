import type { ApprovalDecisionReceipt } from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core';
import { getApprovalDecisionReceipt } from './approval-completion-receipt';
import type {
  ApprovalTransportEvidence,
  ApprovalTransportEvidenceEvent,
} from './approval-transport-detail';

export interface ApprovalDecisionReceiptTrackingRecord {
  event_id: string;
  event_at: number;
  receipt_id: string;
  path: string | null;
  portal_path: string | null;
  decision: string | null;
  request_status: string | null;
  expires_at: number | null;
  grant_ids: string[];
  receipt: ApprovalDecisionReceipt | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractReceiptMetadata(
  event: ApprovalTransportEvidenceEvent
): Omit<ApprovalDecisionReceiptTrackingRecord, 'receipt'> | null {
  const metadata = asRecord(event.transport_detail?.metadata);
  const receipt = asRecord(metadata?.approval_decision_receipt);
  const receiptId = asString(receipt?.receipt_id);
  if (!receiptId) {
    return null;
  }

  return {
    event_id: event.id,
    event_at: event.at,
    receipt_id: receiptId,
    path: asString(receipt?.path),
    portal_path: asString(receipt?.portal_path),
    decision: asString(receipt?.decision),
    request_status: asString(receipt?.request_status),
    expires_at: asNumber(receipt?.expires_at),
    grant_ids: Array.isArray(receipt?.grant_ids)
      ? receipt.grant_ids.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

export async function listApprovalDecisionReceiptsForEvidence(
  env: Env,
  detail: ApprovalTransportEvidence
): Promise<ApprovalDecisionReceiptTrackingRecord[]> {
  const receiptRecords = detail.events
    .map((event) => extractReceiptMetadata(event))
    .filter((event): event is Omit<ApprovalDecisionReceiptTrackingRecord, 'receipt'> => !!event);

  return Promise.all(
    receiptRecords.map(async (record) => ({
      ...record,
      receipt: await getApprovalDecisionReceipt(env, record.receipt_id),
    }))
  );
}
