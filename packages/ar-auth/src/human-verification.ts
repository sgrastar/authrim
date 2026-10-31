import type { Context, Env as HonoEnv } from 'hono';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  verifyHumanVerificationWithRunner,
  type Env,
} from '@authrim/ar-lib-core';

export type HumanVerificationAction = 'login' | 'signup' | 'reauth';

type AuthContext<TContextEnv extends HonoEnv & { Bindings: Env }> = Context<TContextEnv>;

function remoteIp<TContextEnv extends HonoEnv & { Bindings: Env }>(
  c: AuthContext<TContextEnv>
): string | undefined {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    undefined
  );
}

function failedValidationResponse<TContextEnv extends HonoEnv & { Bindings: Env }>(
  c: AuthContext<TContextEnv>
) {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field: 'human_verification_response' },
  });
}

export async function verifyHumanVerificationForAction<
  TContextEnv extends HonoEnv & { Bindings: Env },
>(
  c: AuthContext<TContextEnv>,
  action: HumanVerificationAction,
  responseToken: unknown,
  alsoRequiredFor: readonly HumanVerificationAction[] = []
): Promise<Response | null> {
  const tenantId = getTenantIdFromContext(c);
  try {
    const ip = remoteIp(c);
    const result = await verifyHumanVerificationWithRunner(c.env, {
      tenantId,
      action,
      ...(alsoRequiredFor.length > 0 ? { alsoRequiredFor } : {}),
      responseToken,
      ...(ip ? { remoteIp: ip } : {}),
    });
    return result.verified ? null : failedValidationResponse(c);
  } catch {
    return failedValidationResponse(c);
  }
}

/** The header a client names its human verification screen with ('login' or 'signup'). */
export const HUMAN_VERIFICATION_ACTION_HEADER = 'X-Authrim-Human-Verification-Action';

/** The login or sign-up screen a client says its token came from, if it says. */
export function readDeclaredHumanVerificationScreen<
  TContextEnv extends HonoEnv & { Bindings: Env },
>(c: AuthContext<TContextEnv>): 'login' | 'signup' | null {
  const value = c.req.header(HUMAN_VERIFICATION_ACTION_HEADER)?.trim().toLowerCase();
  return value === 'login' || value === 'signup' ? value : null;
}
