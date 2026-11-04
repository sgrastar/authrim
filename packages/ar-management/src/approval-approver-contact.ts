import type { Context } from 'hono';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTransportMethod,
  Env,
} from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserStore,
  ensureDatabaseAdapter,
  resolveAccountDataContext,
} from '@authrim/ar-lib-core';

type AdminContext = Context<any, any, any>;

export class ApprovalTransportChannelResolutionError extends Error {}

function normalizeChannel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function resolveUserContact(
  c: AdminContext,
  request: ApprovalRequest,
  subjectId: string,
  method: 'email_otp' | 'sms_otp'
): Promise<string> {
  const account = await resolveAccountDataContext(c.env, {
    tenantId: request.tenant_id,
    accountId: `account:${subjectId}`,
  });
  if (account.legacyUserId !== subjectId) {
    throw new ApprovalTransportChannelResolutionError('Approval approver route is inconsistent.');
  }
  const coreAdapter = ensureDatabaseAdapter(account.coreDb, 'approval-contact-core');
  const piiAdapter = ensureDatabaseAdapter(account.piiDb, 'approval-contact-pii');
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter,
    piiAdapter,
    tenantId: request.tenant_id,
  });
  const user = await runtimeUsers.findById(subjectId);

  if (!user) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires an active user approver record.'
    );
  }

  if (method === 'email_otp') {
    if (!user.email_verified || !user.email) {
      throw new ApprovalTransportChannelResolutionError(
        'Approval transport resolution requires a verified email address for this approver.'
      );
    }
    return user.email;
  }

  if (!user.phone_number_verified || !user.phone_number) {
    throw new ApprovalTransportChannelResolutionError(
      'Approval transport resolution requires a verified phone number for this approver.'
    );
  }
  return user.phone_number;
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

/**
 * The approver's own verified contact for an OTP, resolved server-side from the approver's record.
 * Never a channel the caller names: whoever creates or resends a request (its requester among
 * them) must not be able to send the approver's code somewhere else.
 */
async function resolveApproverOtpContact(
  c: AdminContext,
  request: ApprovalRequest,
  approval: Pick<ApprovalRequestApproval, 'subject_type' | 'subject_id'>,
  method: 'email_otp' | 'sms_otp'
): Promise<string> {
  const subjectId = approval.subject_id?.trim() || '';
  if (!subjectId) {
    throw new ApprovalTransportChannelResolutionError(
      'OTP approval requires an approver subject whose verified contact can be resolved.'
    );
  }
  if (approval.subject_type === 'admin_user') {
    return resolveAdminContact(c, request, subjectId, method);
  }
  if (approval.subject_type === 'end_user' || approval.subject_type === 'customer_delegate') {
    return resolveUserContact(c, request, subjectId, method);
  }
  throw new ApprovalTransportChannelResolutionError(
    'OTP approval is not supported for this approver type.'
  );
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
  const method = overrides?.method ?? approval.method ?? null;
  const explicitChannel = normalizeChannel(overrides?.transportChannel);

  if (method === 'email_otp' || method === 'sms_otp') {
    const contact = await resolveApproverOtpContact(c, request, approval, method);
    if (explicitChannel && explicitChannel !== contact) {
      throw new ApprovalTransportChannelResolutionError(
        "An approval OTP goes only to the approver's own verified contact."
      );
    }
    return contact;
  }

  // Other methods carry no secret to a channel: the channel is a label.
  return explicitChannel ?? normalizeChannel(approval.transport_channel);
}
