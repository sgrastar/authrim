import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Env } from '@authrim/ar-lib-core';
import {
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  AdminPasskeyRepository,
  AdminSessionRepository,
  ElevationGrantRepository,
  adminAuthMiddleware,
  createErrorResponse,
  AR_ERROR_CODES,
  createStepUpErrorResponse,
  getTenantIdFromContext,
  type ApprovalDecisionStatus,
  type ApprovalTransportMethod,
  type ApprovalApproverSubjectType,
  type StepUpInputState,
  type StepUpStatusObject,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import {
  getApprovalCompletionArtifact,
  consumeApprovalCompletionArtifact,
} from '../approval-completion-artifact';
import { issueApprovalDecisionReceipt } from '../approval-completion-receipt';
import {
  buildApprovalCompletionRequirements,
  resolveApprovalCompletionMode,
} from '../approval-completion-guidance';
import { appendApprovalTransportEvent } from '../approval-transport-detail';
import {
  renderApprovalArtifactPortalPage,
  renderApprovalCibaDevicePage,
} from '../approval-artifact-portal';
import {
  ApprovalArtifactMethodSwitchError,
  switchApprovalArtifactMethod,
} from '../approval-artifact-method-switch';
import {
  getApprovalCibaStatus,
  respondToApprovalCibaRequest,
  startApprovalCibaRequest,
} from '../approval-ciba';
import {
  ApprovalCibaNotificationError,
  assertApprovalCibaNotificationCooldown,
  dispatchApprovalCibaUserCode,
  recordApprovalCibaNotificationDispatch,
} from '../approval-ciba-notification';
import { resolveApprovalNotificationPolicy } from '../approval-notification-policy';
import { verifyApprovalOtpChallenge } from '../approval-otp';
import { ApprovalWorkflowPolicyError, applyApprovalDecisionForRequest } from '../approval-workflow';

const ApprovalArtifactDecisionSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  method: z
    .enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth'])
    .optional(),
  transport_channel: z.string().min(1).optional(),
  reason_code: z.string().min(1).optional(),
  reason_note: z.string().min(1).optional(),
  transport_summary: z
    .object({
      provider: z.string().min(1).optional(),
      delivery_status: z.string().min(1).optional(),
      target: z.string().min(1).optional(),
      correlation_id: z.string().min(1).optional(),
      transport_request_id: z.string().min(1).optional(),
    })
    .optional(),
  transport_detail: z
    .object({
      request: z.record(z.string(), z.unknown()).nullable().optional(),
      response: z.record(z.string(), z.unknown()).nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
  completion_assertion: z
    .object({
      method: z.enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth']),
      actor_subject_type: z
        .enum(['admin_user', 'end_user', 'customer_delegate', 'service_principal'])
        .optional(),
      actor_subject_id: z.string().min(1).optional(),
      verified_at: z.number().int().positive().optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
});

export const approvalArtifactsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();
const APPROVAL_ARTIFACT_BODY_MAX_BYTES = 100 * 1024;
const APPROVAL_ARTIFACT_PORTAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

approvalArtifactsRouter.use('*', (c, next) =>
  bodyLimit({
    maxSize: APPROVAL_ARTIFACT_BODY_MAX_BYTES,
    onError: (ctx) =>
      ctx.json(
        {
          error: 'payload_too_large',
          error_description: 'Request body exceeds maximum allowed size',
        },
        413
      ),
  })(c, next)
);

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

const ApprovalArtifactPasskeyOptionsSchema = z.object({
  rp_id: z.string().min(1).optional(),
});

const ApprovalArtifactPasskeyVerifySchema = z.object({
  challenge_id: z.string().min(1),
  credential: z.custom<AuthenticationResponseJSON>(),
});

const ApprovalArtifactOtpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

const ApprovalArtifactSwitchMethodSchema = z.object({
  method: z.enum(['ciba', 'passkey', 'portal_confirm', 'email_otp', 'sms_otp', 'reauth']),
});

const ApprovalArtifactCibaRespondSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  auth_req_id: z.string().min(1),
  user_code: z.string().min(1),
});

type PendingApprovalArtifactState = {
  adapter: ReturnType<typeof getAdminAdapter>;
  requestRepo: ApprovalRequestRepository;
  approvalRepo: ApprovalRequestApprovalRepository;
  request: NonNullable<
    Awaited<ReturnType<ApprovalRequestRepository['getApprovalRequestByPublicId']>>
  >;
  approval: NonNullable<Awaited<ReturnType<ApprovalRequestApprovalRepository['getApprovalById']>>>;
  artifact: NonNullable<Awaited<ReturnType<typeof getApprovalCompletionArtifact>>>;
};

function getAdminAdapter(env: Env) {
  return requireDedicatedAdminDatabaseAdapter(env, 'approval-artifacts');
}

function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    if (/^[A-Za-z0-9+/]+=*$/.test(input)) {
      return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return input;
  }

  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loadPendingApprovalArtifactState(
  env: Env,
  artifactId: string,
  tenantId: string
): Promise<PendingApprovalArtifactState | null> {
  const artifact = await getApprovalCompletionArtifact(env, artifactId, tenantId);
  if (!artifact || artifact.consumed) {
    return null;
  }

  const adapter = getAdminAdapter(env);
  const requestRepo = new ApprovalRequestRepository(adapter);
  const approvalRepo = new ApprovalRequestApprovalRepository(adapter);
  const request = await requestRepo.getApprovalRequestByPublicId(artifact.request_id);
  const approval = await approvalRepo.getApprovalById(artifact.approval_id);

  if (!request || !approval || approval.approval_request_id !== request.id) {
    return null;
  }
  if (approval.status !== 'pending') {
    return null;
  }
  if (request.status !== 'pending' && request.status !== 'partially_approved') {
    return null;
  }

  return {
    adapter,
    requestRepo,
    approvalRepo,
    request,
    approval,
    artifact,
  };
}

function buildCompletionRequirements(input: {
  artifactId: string;
  method: ApprovalTransportMethod;
  transportChannel: string | null;
  acceptableMethods?: ApprovalTransportMethod[];
  approval: {
    subject_type: ApprovalApproverSubjectType;
    subject_id: string | null;
    relation_type: string | null;
    relation_source: string | null;
  };
}) {
  return buildApprovalCompletionRequirements(input);
}

function resolveCompletionRequirementsFromState(state: PendingApprovalArtifactState) {
  const notificationPolicy = resolveApprovalNotificationPolicy({
    request: state.request,
    approval: state.approval,
    overrideMethod: state.artifact.method,
    overrideTransportChannel: state.artifact.transport_channel,
  });

  return buildCompletionRequirements({
    artifactId: state.artifact.artifact_id,
    method: state.artifact.method,
    transportChannel: state.artifact.transport_channel,
    acceptableMethods: notificationPolicy.acceptableMethods,
    approval: {
      subject_type: state.approval.subject_type,
      subject_id: state.approval.subject_id,
      relation_type: state.approval.relation_type,
      relation_source: state.approval.relation_source,
    },
  });
}

function buildApprovalStepUpStatus(
  state: PendingApprovalArtifactState,
  status: StepUpStatusObject['status'] = 'pending'
): StepUpStatusObject {
  return {
    action_id: state.artifact.artifact_id,
    status,
    ...(state.artifact.method
      ? {
          preferred_method: {
            method: state.artifact.method,
          },
        }
      : {}),
    expires_at: new Date(state.artifact.expires_at).toISOString(),
    expires_at_unix: Math.floor(state.artifact.expires_at / 1000),
  };
}

approvalArtifactsRouter.post('/:artifactId/reauth/assert', adminAuthMiddleware({}), async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'reauth') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for reauth completion.',
        },
        409
      );
    }
    if (state.approval.subject_type !== 'admin_user' || !state.approval.subject_id) {
      return c.json(
        {
          error: 'approval_completion_not_supported',
          error_description:
            'Reauth completion is currently only supported for admin user approvers.',
        },
        409
      );
    }

    const adminAuth = c.get('adminAuth');
    if (!adminAuth || adminAuth.authMethod !== 'session' || !adminAuth.sessionId) {
      return c.json(
        {
          error: 'approval_reauth_session_required',
          error_description:
            'A matching admin session is required to complete reauth for this approval artifact.',
        },
        403
      );
    }
    if (adminAuth.userId !== state.approval.subject_id) {
      return c.json(
        {
          error: 'approval_completion_actor_mismatch',
          error_description:
            'The authenticated admin session does not match the intended approver.',
        },
        403
      );
    }

    const adminSessionRepo = new AdminSessionRepository(state.adapter);
    await adminSessionRepo.setMfaVerified(adminAuth.sessionId);

    return c.json({
      completion_assertion: {
        method: 'reauth',
        actor_subject_type: 'admin_user',
        actor_subject_id: adminAuth.userId,
        verified_at: Date.now(),
        metadata: {
          session_id: adminAuth.sessionId,
          auth_method: adminAuth.authMethod,
          source: 'admin_session_reauth',
        },
      },
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.post('/:artifactId/passkey/options', async (c) => {
  try {
    const body = ApprovalArtifactPasskeyOptionsSchema.parse(await c.req.json().catch(() => ({})));
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'passkey') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for passkey completion.',
        },
        409
      );
    }
    if (state.approval.subject_type !== 'admin_user' || !state.approval.subject_id) {
      return c.json(
        {
          error: 'approval_completion_not_supported',
          error_description:
            'Passkey completion is currently only supported for admin user approvers.',
        },
        409
      );
    }
    if (!c.env.AUTHRIM_CONFIG) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Challenge storage is not configured for passkey completion.',
        },
        500
      );
    }

    const rpId =
      body.rp_id ??
      (() => {
        const originHeader = c.req.header('origin');
        if (!originHeader) {
          return null;
        }
        return new URL(originHeader).hostname;
      })();
    if (!rpId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'rp_id or Origin header is required for passkey completion.',
        },
        400
      );
    }

    const passkeyRepo = new AdminPasskeyRepository(state.adapter);
    const passkeys = await passkeyRepo.getPasskeysByUser(state.approval.subject_id);
    if (passkeys.length === 0) {
      return c.json(
        {
          error: 'approval_completion_not_configured',
          error_description: 'The intended approver has no registered admin passkeys.',
        },
        409
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credential_id,
        transports: (passkey.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
    });

    const challengeId = `${state.artifact.artifact_id}:pk:${crypto.randomUUID()}`;
    const originHeader = c.req.header('origin') ?? null;
    await c.env.AUTHRIM_CONFIG.put(
      `approval_passkey:challenge:${challengeId}`,
      JSON.stringify({
        challenge: options.challenge,
        rpID: rpId,
        origin: originHeader,
        artifactId: state.artifact.artifact_id,
        approvalId: state.approval.id,
        approverSubjectId: state.approval.subject_id,
      }),
      { expirationTtl: 300 }
    );

    return c.json({
      options,
      challenge_id: challengeId,
      completion_requirements: resolveCompletionRequirementsFromState(state),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid passkey options payload',
        },
      });
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.post('/:artifactId/passkey/verify', async (c) => {
  try {
    const body = ApprovalArtifactPasskeyVerifySchema.parse(await c.req.json());
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'passkey') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for passkey completion.',
        },
        409
      );
    }
    if (state.approval.subject_type !== 'admin_user' || !state.approval.subject_id) {
      return c.json(
        {
          error: 'approval_completion_not_supported',
          error_description:
            'Passkey completion is currently only supported for admin user approvers.',
        },
        409
      );
    }
    if (!c.env.AUTHRIM_CONFIG) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Challenge storage is not configured for passkey completion.',
        },
        500
      );
    }

    const challengeData = await c.env.AUTHRIM_CONFIG.get(
      `approval_passkey:challenge:${body.challenge_id}`
    );
    if (!challengeData) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Passkey challenge expired or not found.',
        },
        400
      );
    }

    const storedChallenge = JSON.parse(challengeData) as {
      challenge: string;
      rpID: string;
      origin: string | null;
      artifactId: string;
      approvalId: string;
      approverSubjectId: string;
    };
    if (
      storedChallenge.artifactId !== state.artifact.artifact_id ||
      storedChallenge.approvalId !== state.approval.id ||
      storedChallenge.approverSubjectId !== state.approval.subject_id
    ) {
      await c.env.AUTHRIM_CONFIG.delete(`approval_passkey:challenge:${body.challenge_id}`);
      return c.json(
        {
          error: 'approval_completion_actor_mismatch',
          error_description: 'The passkey challenge does not match the intended approval artifact.',
        },
        403
      );
    }

    const credentialId = toBase64URLString(body.credential.id);
    const passkeyRepo = new AdminPasskeyRepository(state.adapter);
    const passkey = await passkeyRepo.findByCredentialId(credentialId);
    if (!passkey || passkey.admin_user_id !== state.approval.subject_id) {
      await c.env.AUTHRIM_CONFIG.delete(`approval_passkey:challenge:${body.challenge_id}`);
      return c.json(
        {
          error: 'auth_failed',
          error_description: 'The supplied passkey does not belong to the intended approver.',
        },
        401
      );
    }

    const expectedOrigin = storedChallenge.origin ?? c.req.header('origin');
    if (!expectedOrigin) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Origin header is required for passkey verification.',
        },
        400
      );
    }

    const publicKey = Uint8Array.from(Buffer.from(passkey.public_key, 'base64'));
    const verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin,
      expectedRPID: storedChallenge.rpID,
      credential: {
        id: passkey.credential_id,
        publicKey,
        counter: passkey.counter,
      },
    });

    if (!verification.verified) {
      await c.env.AUTHRIM_CONFIG.delete(`approval_passkey:challenge:${body.challenge_id}`);
      return c.json(
        {
          error: 'auth_failed',
          error_description: 'Passkey verification failed for this approval artifact.',
        },
        401
      );
    }

    await passkeyRepo.updateCounter(passkey.id, verification.authenticationInfo.newCounter);
    await c.env.AUTHRIM_CONFIG.delete(`approval_passkey:challenge:${body.challenge_id}`);

    return c.json({
      completion_assertion: {
        method: 'passkey',
        actor_subject_type: 'admin_user',
        actor_subject_id: state.approval.subject_id,
        verified_at: Date.now(),
        metadata: {
          challenge_id: body.challenge_id,
          credential_id: passkey.credential_id,
          source: 'admin_passkey',
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid passkey verification payload',
        },
      });
    }
    return c.json(
      {
        error: 'auth_failed',
        error_description: 'Passkey verification failed for this approval artifact.',
      },
      401
    );
  }
});

approvalArtifactsRouter.post('/:artifactId/otp/verify', async (c) => {
  let stepUpState: PendingApprovalArtifactState | null = null;
  try {
    const body = ApprovalArtifactOtpVerifySchema.parse(await c.req.json());
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    stepUpState = state;
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'email_otp' && state.artifact.method !== 'sms_otp') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for OTP completion.',
        },
        409
      );
    }
    if (!state.approval.transport_channel) {
      return c.json(
        {
          error: 'approval_completion_not_configured',
          error_description: 'This approval step does not have a bound OTP delivery target.',
        },
        409
      );
    }

    const verification = await verifyApprovalOtpChallenge(c.env, {
      tenantId: state.request.tenant_id,
      artifactId: state.artifact.artifact_id,
      code: body.code,
      target: state.approval.transport_channel,
    });

    return c.json({
      completion_assertion: {
        method: state.artifact.method,
        actor_subject_type: state.approval.subject_type,
        actor_subject_id: state.approval.subject_id ?? undefined,
        verified_at: verification.verifiedAt,
        metadata: {
          source: 'approval_otp',
          target: state.approval.transport_channel,
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid OTP verification payload',
        },
      });
    }
    if (stepUpState && error instanceof Error && error.message.startsWith('Invalid approval OTP')) {
      const inputState: StepUpInputState = {
        field: 'code',
        method: stepUpState.artifact.method,
      };
      return createStepUpErrorResponse(
        {
          error: 'invalid_step_up_input',
          error_description: 'Approval OTP verification failed.',
          code: 'invalid_step_up_input',
          field: 'code',
          input_state: inputState,
          status: buildApprovalStepUpStatus(stepUpState),
        },
        400
      );
    }
    return c.json(
      {
        error: 'auth_failed',
        error_description: 'Approval OTP verification failed.',
      },
      401
    );
  }
});

approvalArtifactsRouter.post('/:artifactId/ciba/start', async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'ciba') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for CIBA completion.',
        },
        409
      );
    }

    const deliveryState = await assertApprovalCibaNotificationCooldown({
      env: c.env,
      artifactId: state.artifact.artifact_id,
      policyPreset: state.request.policy_preset,
    });

    const started = await startApprovalCibaRequest({
      env: c.env,
      tenantId: state.request.tenant_id,
      artifact: state.artifact,
      request: state.request,
      approval: state.approval,
    });
    if (!started.userCode) {
      return c.json(
        {
          error: 'approval_completion_not_configured',
          error_description: 'CIBA completion requires a verification code.',
        },
        409
      );
    }
    await dispatchApprovalCibaUserCode(c, {
      request: state.request,
      approval: state.approval,
      artifactId: state.artifact.artifact_id,
      authReqId: started.authReqId,
      userCode: started.userCode,
    });
    await recordApprovalCibaNotificationDispatch({
      env: c.env,
      artifactId: state.artifact.artifact_id,
      authReqId: started.authReqId,
      expiresAt: started.expiresAt,
      previousState: deliveryState,
    });

    return c.json({
      auth_req_id: started.authReqId,
      expires_at: started.expiresAt,
      interval: started.interval,
      status_path: `/api/approval-artifacts/${encodeURIComponent(state.artifact.artifact_id)}/ciba/status`,
      device_path: `/api/approval-artifacts/${encodeURIComponent(state.artifact.artifact_id)}/ciba/device?auth_req_id=${encodeURIComponent(started.authReqId)}`,
    });
  } catch (error) {
    if (error instanceof ApprovalCibaNotificationError) {
      return c.json(
        {
          error: 'approval_ciba_delivery_failed',
          error_description: error.message,
          ...(error.retryAfterMs ? { retry_after_ms: error.retryAfterMs } : {}),
        },
        error.status as 409 | 429 | 503
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.get('/:artifactId/ciba/status', async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'ciba') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for CIBA completion.',
        },
        409
      );
    }

    const status = await getApprovalCibaStatus({
      env: c.env,
      tenantId: state.request.tenant_id,
      artifactId: state.artifact.artifact_id,
    });
    if (!status) {
      return c.json({
        status: 'not_started',
      });
    }

    return c.json({
      auth_req_id: status.authReqId,
      status: status.status,
      interval: status.interval,
      completion_assertion:
        status.status === 'approved'
          ? {
              method: 'ciba',
              actor_subject_type: state.approval.subject_type,
              actor_subject_id: state.approval.subject_id ?? undefined,
              verified_at: status.decisionAt ?? Date.now(),
              metadata: {
                source: 'approval_ciba',
                auth_req_id: status.authReqId,
              },
            }
          : null,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.get('/:artifactId/ciba/device', async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return new Response('Approval artifact not found or no longer active.', { status: 404 });
    }
    if (state.artifact.method !== 'ciba') {
      return new Response('This approval artifact is not configured for CIBA completion.', {
        status: 409,
      });
    }

    return new Response(
      renderApprovalCibaDevicePage({
        artifactId: state.artifact.artifact_id,
        request: state.request,
        approval: state.approval,
      }),
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': APPROVAL_ARTIFACT_PORTAL_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      }
    );
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
});

approvalArtifactsRouter.post('/:artifactId/ciba/respond', async (c) => {
  try {
    const body = ApprovalArtifactCibaRespondSchema.parse(await c.req.json());
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    if (state.artifact.method !== 'ciba') {
      return c.json(
        {
          error: 'approval_completion_method_mismatch',
          error_description: 'This approval artifact is not configured for CIBA completion.',
        },
        409
      );
    }

    const result = await respondToApprovalCibaRequest({
      env: c.env,
      tenantId: state.request.tenant_id,
      artifactId: state.artifact.artifact_id,
      actorSubjectId:
        state.approval.subject_id ??
        state.artifact.approver_subject_id ??
        state.artifact.transport_channel ??
        state.request.target_subject_id,
      authReqId: body.auth_req_id,
      userCode: body.user_code,
      decision: body.decision,
    });

    return c.json({
      auth_req_id: result.authReqId,
      status: result.status,
      decision_at: result.decisionAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid CIBA response payload',
        },
      });
    }
    if (
      error instanceof Error &&
      /verification code|request mismatch|metadata not found/i.test(error.message)
    ) {
      return c.json(
        {
          error: 'auth_failed',
          error_description: 'CIBA verification failed for this approval artifact.',
        },
        401
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.get('/:artifactId', async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const completionRequirements = resolveCompletionRequirementsFromState(state);

    return c.json({
      artifact: state.artifact,
      request: {
        public_request_id: state.request.public_request_id,
        investigation_id: state.request.investigation_id,
        request_surface: state.request.request_surface,
        requested_action: state.request.requested_action,
        redaction_level: state.request.redaction_level,
        status: state.request.status,
        reason_code: state.request.reason_code,
        policy_preset: state.request.policy_preset,
        ticket_reference: state.request.ticket_reference,
        reference: state.request.reference,
      },
      approval: {
        id: state.approval.id,
        step_key: state.approval.step_key,
        side: state.approval.side,
        subject_type: state.approval.subject_type,
        subject_id: state.approval.subject_id,
        status: state.approval.status,
        method: state.approval.method,
        transport_channel: completionRequirements.transport_channel,
        expires_at: state.approval.expires_at,
      },
      completion_requirements: completionRequirements,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.post('/:artifactId/switch-method', async (c) => {
  try {
    const body = ApprovalArtifactSwitchMethodSchema.parse(await c.req.json());
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const switched = await switchApprovalArtifactMethod(c, {
      adapter: state.adapter,
      requestRepo: state.requestRepo,
      approvalRepo: state.approvalRepo,
      request: state.request,
      approval: state.approval,
      currentArtifactId: state.artifact.artifact_id,
      currentMethod: state.artifact.method,
      requestedMethod: body.method,
    });

    const completionArtifact = switched.dispatchResult.completionArtifact;
    if (!completionArtifact) {
      return c.json(
        {
          error: 'approval_artifact_issue_failed',
          error_description: 'The fallback completion artifact could not be issued.',
        },
        500
      );
    }

    return c.json({
      replaced_artifact_id: switched.replacedArtifactId,
      notification_result: {
        success: switched.dispatchResult.success,
        method: switched.dispatchResult.method,
        transport_channel: switched.dispatchResult.transportChannel,
        delivery_status: switched.dispatchResult.summary.delivery_status,
        target: switched.dispatchResult.summary.target,
        transport_request_id: switched.dispatchResult.summary.transport_request_id,
      },
      artifact: {
        artifact_id: completionArtifact.artifactId,
        path: completionArtifact.path,
        expires_at: completionArtifact.expiresAt,
      },
      completion_requirements: buildApprovalCompletionRequirements({
        artifactId: completionArtifact.artifactId,
        method: switched.dispatchResult.method,
        transportChannel: switched.dispatchResult.transportChannel,
        acceptableMethods: switched.allowedMethods,
        approval: {
          subject_type: switched.approval.subject_type,
          subject_id: switched.approval.subject_id,
          relation_type: switched.approval.relation_type,
          relation_source: switched.approval.relation_source,
        },
      }),
      request_status: switched.requestWithDetail.status,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid approval fallback method payload',
        },
      });
    }
    if (error instanceof ApprovalArtifactMethodSwitchError) {
      return c.json(
        {
          error: error.code,
          error_description: error.message,
          ...(error.retryAfterMs
            ? {
                retry_after_ms: error.retryAfterMs,
                retry_after_seconds: Math.ceil(error.retryAfterMs / 1000),
              }
            : {}),
        },
        error.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalArtifactsRouter.get('/:artifactId/portal', async (c) => {
  try {
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return new Response('Approval artifact not found or no longer active.', { status: 404 });
    }

    const completionRequirements = resolveCompletionRequirementsFromState(state);

    return new Response(
      renderApprovalArtifactPortalPage({
        artifactId: state.artifact.artifact_id,
        request: state.request,
        approval: state.approval,
        completionRequirements,
      }),
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': APPROVAL_ARTIFACT_PORTAL_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      }
    );
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
});

approvalArtifactsRouter.post('/:artifactId/complete', async (c) => {
  try {
    const body = ApprovalArtifactDecisionSchema.parse(await c.req.json());
    const state = await loadPendingApprovalArtifactState(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );
    if (!state) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const previewArtifact = state.artifact;
    const grantRepo = new ElevationGrantRepository(state.adapter);

    const completionMode = resolveApprovalCompletionMode(previewArtifact.method);
    if (completionMode === 'step_up_required' && body.decision === 'approved') {
      if (!body.completion_assertion) {
        return createStepUpErrorResponse(
          {
            error: 'step_up_required',
            error_description:
              'This completion flow requires a method-bound step-up assertion before the artifact can be consumed.',
            code: 'step_up_required',
            status: buildApprovalStepUpStatus(state),
          },
          409
        );
      }
      if (body.completion_assertion.method !== previewArtifact.method) {
        return createStepUpErrorResponse(
          {
            error: 'invalid_step_up_input',
            error_description:
              'The completion assertion method does not match the artifact method.',
            code: 'invalid_step_up_input',
            field: 'completion_assertion.method',
            status: buildApprovalStepUpStatus(state),
          },
          409
        );
      }
      if (
        previewArtifact.approver_subject_id &&
        body.completion_assertion.actor_subject_id &&
        body.completion_assertion.actor_subject_id !== previewArtifact.approver_subject_id
      ) {
        return createStepUpErrorResponse(
          {
            error: 'invalid_step_up_input',
            error_description:
              'The completion assertion actor does not match the intended approver.',
            code: 'invalid_step_up_input',
            field: 'completion_assertion.actor_subject_id',
            details: {
              retryable: false,
              user_action: 'reauthenticate',
              severity: 'error',
            },
            status: buildApprovalStepUpStatus(state, 'failed'),
          },
          403
        );
      }
      if (
        body.completion_assertion.actor_subject_type &&
        body.completion_assertion.actor_subject_type !== previewArtifact.approver_subject_type
      ) {
        return createStepUpErrorResponse(
          {
            error: 'invalid_step_up_input',
            error_description:
              'The completion assertion actor does not match the intended approver.',
            code: 'invalid_step_up_input',
            field: 'completion_assertion.actor_subject_type',
            details: {
              retryable: false,
              user_action: 'reauthenticate',
              severity: 'error',
            },
            status: buildApprovalStepUpStatus(state, 'failed'),
          },
          403
        );
      }
    }

    const occurredAt = Date.now();
    const artifact = await consumeApprovalCompletionArtifact(
      c.env,
      c.req.param('artifactId')!,
      getTenantIdFromContext(c)
    );

    const result = await applyApprovalDecisionForRequest(
      c,
      {
        adapter: state.adapter,
        requestRepo: state.requestRepo,
        approvalRepo: state.approvalRepo,
        grantRepo,
      },
      {
        request: state.request,
        approval: state.approval,
        nextStatus: body.decision as ApprovalDecisionStatus,
        actorSubjectType: artifact.approver_subject_type,
        actorSubjectId: artifact.approver_subject_id,
        method: (body.method ??
          artifact.method ??
          state.approval.method ??
          null) as ApprovalTransportMethod | null,
        transportChannel:
          body.transport_channel ?? artifact.transport_channel ?? state.approval.transport_channel,
        reasonCode: body.reason_code ?? state.request.reason_code,
        reasonNote: body.reason_note ?? null,
        transportSummary: body.transport_summary ?? {
          provider: 'authrim.approval_artifact',
          delivery_status: body.decision === 'approved' ? 'approved' : 'denied',
          target: artifact.transport_channel ?? artifact.approver_subject_id,
          correlation_id: artifact.investigation_id,
          transport_request_id: artifact.artifact_id,
        },
        transportDetail: body.transport_detail ?? {
          request: {
            artifact_id: artifact.artifact_id,
          },
          response: {
            decision: body.decision,
          },
          metadata: {
            completion_source: 'approval_artifact',
            completion_assertion: body.completion_assertion ?? null,
          },
        },
        occurredAt,
      }
    );

    const updatedApproval =
      result.approvals.find((item) => item.id === state.approval.id) ?? state.approval;
    let receipt: Awaited<ReturnType<typeof issueApprovalDecisionReceipt>> | null = null;

    try {
      receipt = await issueApprovalDecisionReceipt(c.env, {
        artifact,
        request: result.request,
        approval: updatedApproval,
        decision: body.decision as ApprovalDecisionStatus,
        requestStatus: result.request.status,
        grants: result.grants,
        completedAt: occurredAt,
      });

      await appendApprovalTransportEvent(c, state.adapter, state.requestRepo, result.request, {
        kind: 'step_receipt_issued',
        actorSubjectType: artifact.approver_subject_type,
        actorSubjectId: artifact.approver_subject_id,
        requestStatus: result.request.status,
        approval: updatedApproval,
        method: (body.method ??
          artifact.method ??
          state.approval.method ??
          null) as ApprovalTransportMethod | null,
        transportChannel:
          body.transport_channel ?? artifact.transport_channel ?? state.approval.transport_channel,
        reasonCode: body.reason_code ?? state.request.reason_code,
        reasonNote: body.reason_note ?? null,
        transportSummary: {
          provider: 'authrim.approval_receipt',
          delivery_status: 'recorded',
          target: artifact.transport_channel ?? artifact.approver_subject_id,
          correlation_id: artifact.investigation_id,
          transport_request_id: receipt.receipt_id,
        },
        transportDetail: {
          metadata: {
            approval_decision_receipt: {
              receipt_id: receipt.receipt_id,
              path: `/api/approval-receipts/${receipt.receipt_id}`,
              portal_path: `/api/approval-receipts/${receipt.receipt_id}/portal`,
              decision: receipt.decision,
              request_status: receipt.request_status,
              grant_ids: receipt.grant_ids,
              expires_at: receipt.expires_at,
            },
          },
        },
        occurredAt,
      });
    } catch {
      receipt = null;
    }

    return c.json({
      artifact_id: artifact.artifact_id,
      request_id: result.request.public_request_id,
      approval_id: state.approval.id,
      decision: body.decision,
      request_status: result.request.status,
      grant_ids: result.grants.map((grant) => grant.public_grant_id),
      ...(receipt
        ? {
            receipt_id: receipt.receipt_id,
            receipt_path: `/api/approval-receipts/${receipt.receipt_id}`,
            receipt_portal_path: `/api/approval-receipts/${receipt.receipt_id}/portal`,
            receipt_expires_at: receipt.expires_at,
          }
        : {
            receipt_error: 'receipt_unavailable',
          }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: error.issues[0]?.path.join('.') || 'body',
          reason: error.issues[0]?.message || 'Invalid approval artifact decision payload',
        },
      });
    }
    if (error instanceof Error && /already consumed|invalid|expired/i.test(error.message)) {
      return c.json(
        {
          error: 'invalid_approval_artifact',
          error_description: 'The approval completion artifact is invalid, expired, or consumed.',
        },
        410
      );
    }
    if (error instanceof ApprovalWorkflowPolicyError) {
      return c.json(
        {
          error: error.code,
          error_description: error.message,
        },
        error.status as 409
      );
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});
