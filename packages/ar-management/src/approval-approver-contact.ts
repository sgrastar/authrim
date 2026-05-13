import type { Context } from 'hono';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
  Env,
} from '@authrim/ar-lib-core';
import { ensureDatabaseAdapter } from '@authrim/ar-lib-core';

type AdminContext = Context<any, any, any>;

export class ApprovalTransportChannelResolutionError extends Error {}

function normalizeChannel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function looksLikePhone(value: string): boolean {
  return /^\+?[0-9().\-\s]{6,}$/.test(value);
}

async function resolveUserContact(
  c: AdminContext,
  request: ApprovalRequest,
  subjectId: string,
  method: 'email_otp' | 'sms_otp'
): Promise<string> {
  const coreAdapter = ensureDatabaseAdapter(c.env.DB, 'approval-contact-core');
  const coreRow = await coreAdapter.queryOne<{
    pii_partition: string | null;
    email_verified: number | boolean | null;
    phone_number_verified: number | boolean | null;
  }>(
    `SELECT pii_partition, email_verified, phone_number_verified
       FROM users_core
      WHERE tenant_id = ? AND id = ? AND is_active = 1`,
    [request.tenant_id, subjectId]
  );

  if (!coreRow) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires an active user approver record.'
    );
  }

  const piiAdapter = ensureDatabaseAdapter(c.env.DB_PII ?? c.env.DB, 'approval-contact-pii');
  const piiRow = await piiAdapter.queryOne<{
    email: string | null;
    phone_number: string | null;
  }>('SELECT email, phone_number FROM users_pii WHERE tenant_id = ? AND id = ?', [
    request.tenant_id,
    subjectId,
  ]);

  if (method === 'email_otp') {
    if (!coreRow.email_verified || !piiRow?.email) {
      throw new ApprovalTransportChannelResolutionError(
        'Approval transport resolution requires a verified email address for this approver.'
      );
    }
    return piiRow.email;
  }

  if (!coreRow.phone_number_verified || !piiRow?.phone_number) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires a verified phone number for this approver.'
    );
  }
  return piiRow.phone_number;
}

async function resolveAdminContact(
  c: AdminContext,
  request: ApprovalRequest,
  subjectId: string,
  method: 'email_otp' | 'sms_otp'
): Promise<string> {
  const adminAdapter = ensureDatabaseAdapter(c.env.DB_ADMIN, 'approval-contact-admin');
  const adminUser = await adminAdapter.queryOne<{
    email: string | null;
    email_verified: number | boolean | null;
  }>(
    `SELECT email, email_verified
       FROM admin_users
      WHERE tenant_id = ? AND id = ? AND is_active = 1`,
    [request.tenant_id, subjectId]
  );
  if (!adminUser) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires an active admin approver record.'
    );
  }

  if (method === 'sms_otp') {
    throw new ApprovalTransportChannelResolutionError(
      'SMS approval is not supported for admin approvers without an explicit transport channel.'
    );
  }

  if (!adminUser.email_verified || !adminUser.email) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires a verified admin email address.'
    );
  }
  return adminUser.email;
}

export async function resolveApprovalTransportChannel(
  c: AdminContext,
  request: ApprovalRequest,
  approval: Pick<ApprovalRequestApproval, 'subject_type' | 'subject_id' | 'transport_channel'> & {
    method: ApprovalTransportMethod | null;
  },
  overrides?: {
    method?: ApprovalTransportMethod | null;
    transportChannel?: string | null;
  }
): Promise<string | null> {
  const method = (overrides?.method ?? approval.method ?? null) as ApprovalTransportMethod | null;
  const explicitChannel = normalizeChannel(overrides?.transportChannel);
  if (explicitChannel) {
    return explicitChannel;
  }

  const existingChannel = normalizeChannel(approval.transport_channel);
  const subjectId = approval.subject_id?.trim() || '';
  const subjectIdIsResolvedContact =
    (method === 'email_otp' && looksLikeEmail(subjectId)) ||
    (method === 'sms_otp' && looksLikePhone(subjectId));
  const channelMatchesUnresolvedSubjectId =
    !!existingChannel &&
    !!subjectId &&
    existingChannel === subjectId &&
    !subjectIdIsResolvedContact;

  if (existingChannel && !channelMatchesUnresolvedSubjectId) {
    return existingChannel;
  }

  if (method !== 'email_otp' && method !== 'sms_otp') {
    return null;
  }

  if (!subjectId) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires an approver subject ID or explicit transport channel.'
    );
  }

  if (method === 'email_otp' && looksLikeEmail(subjectId)) {
    return subjectId;
  }
  if (method === 'sms_otp' && looksLikePhone(subjectId)) {
    return subjectId;
  }

  if (approval.subject_type === 'admin_user') {
    return resolveAdminContact(c, request, subjectId, method);
  }

  if (approval.subject_type === 'end_user' || approval.subject_type === 'customer_delegate') {
    return resolveUserContact(c, request, subjectId, method);
  }

  throw new ApprovalTransportChannelResolutionError(
    'Approval transport resolution requires an explicit transport channel for this approver type.'
  );
}
