import type { Context } from 'hono';
import {
  verifyHumanVerificationToken,
  type HumanVerificationAction,
} from '@authrim/ar-lib-plugin/builtin/security';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  type Env,
} from '@authrim/ar-lib-core';

export type { HumanVerificationAction } from '@authrim/ar-lib-plugin/builtin/security';

function remoteIp(c: Context<{ Bindings: Env }>): string | undefined {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    undefined
  );
}

function failedValidationResponse(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field: 'human_verification_response' },
  });
}

export async function verifyHumanVerificationForAction(
  c: Context<{ Bindings: Env }>,
  action: HumanVerificationAction,
  responseToken: unknown
): Promise<Response | null> {
  const result = await verifyHumanVerificationToken({
    env: c.env,
    tenantId: getTenantIdFromContext(c),
    actions: action,
    response: responseToken,
    remoteIp: remoteIp(c),
  });
  return result.ok ? null : failedValidationResponse(c);
}
