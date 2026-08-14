import { describe, expect, it } from 'vitest';
import {
  PHASE1_ERROR_DETAIL_CODES,
  PHASE1_ERROR_DETAIL_DEFINITIONS,
  createPhase1ErrorDetails,
  getPhase1ErrorDetailDefinition,
  type Phase1ErrorDetailCode,
} from '../details';
import { createStepUpErrorBody, createStepUpErrorResponse } from '../step-up';

describe('Phase 1 error details', () => {
  it('registers the G-048 machine-readable codes in the runtime source of truth', () => {
    const requiredCodes: Phase1ErrorDetailCode[] = [
      'invalid_cursor',
      'unknown_audit_field',
      'revoke_disabled',
      'introspection_disabled',
      'unauthorized_introspection_caller',
    ];

    for (const code of requiredCodes) {
      expect(PHASE1_ERROR_DETAIL_DEFINITIONS[code]).toBeDefined();
      expect(PHASE1_ERROR_DETAIL_DEFINITIONS[code].retryable).toBe(false);
      expect(PHASE1_ERROR_DETAIL_DEFINITIONS[code].severity).toBe('error');
    }
  });

  it('keeps Native SSO failure codes in the same registry as the response helper', () => {
    const nativeSsoCodes: Phase1ErrorDetailCode[] = [
      PHASE1_ERROR_DETAIL_CODES.NATIVE_SSO_DISABLED,
      PHASE1_ERROR_DETAIL_CODES.NATIVE_SSO_CLIENT_DISABLED,
      PHASE1_ERROR_DETAIL_CODES.NATIVE_SSO_RATE_LIMITED,
      PHASE1_ERROR_DETAIL_CODES.DEVICE_SECRET_MISSING,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_MALFORMED,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_SIGNATURE_INVALID,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_ISSUER_INVALID,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_AUDIENCE_INVALID,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_EXPIRED,
      PHASE1_ERROR_DETAIL_CODES.ID_TOKEN_REPLAYED,
      PHASE1_ERROR_DETAIL_CODES.DPOP_PROOF_MISSING,
      PHASE1_ERROR_DETAIL_CODES.DPOP_PROOF_INVALID,
      PHASE1_ERROR_DETAIL_CODES.DEVICE_SECRET_BINDING_FAILED,
      PHASE1_ERROR_DETAIL_CODES.TRUST_GROUP_NOT_ALLOWED,
      PHASE1_ERROR_DETAIL_CODES.DEVICE_SECRET_INACTIVE,
      PHASE1_ERROR_DETAIL_CODES.NATIVE_SSO_SCOPE_INVALID,
      PHASE1_ERROR_DETAIL_CODES.NATIVE_SSO_SERVER_ERROR,
    ];

    for (const code of nativeSsoCodes) {
      expect(getPhase1ErrorDetailDefinition(code)).toBeDefined();
    }
  });

  it('serializes retry semantics and field context consistently', () => {
    expect(createPhase1ErrorDetails('native_sso_rate_limited')).toMatchObject({
      code: 'native_sso_rate_limited',
      retryable: true,
      transient: true,
      severity: 'warning',
      user_action: 'retry',
    });

    expect(createPhase1ErrorDetails('unknown_audit_field', { field: 'audit.reason' })).toEqual({
      code: 'unknown_audit_field',
      retryable: false,
      severity: 'error',
      user_action: 'contact_support',
      field: 'audit.reason',
    });
  });

  it('classifies compatibility details as fatal', () => {
    expect(createPhase1ErrorDetails('legacy_endpoint_not_supported')).toMatchObject({
      code: 'legacy_endpoint_not_supported',
      retryable: false,
      severity: 'fatal',
      user_action: 'update_client',
    });
  });

  it('builds Step-Up errors without error_uri and with retryable input status details', async () => {
    const inputState = {
      field: 'code',
      attempts_remaining: 4,
      max_attempts: 5,
    };
    const body = createStepUpErrorBody({
      error: 'invalid_step_up_input',
      error_description: 'Invalid verification code',
      code: 'invalid_step_up_input',
      field: 'code',
      input_state: inputState,
      status: {
        action_id: 'act_123',
        status: 'pending',
        preferred_method: { method: 'email_otp' },
      },
    });

    expect(body).toMatchObject({
      error: 'invalid_step_up_input',
      error_details: {
        code: 'invalid_step_up_input',
        retryable: true,
        field: 'code',
        input_state: inputState,
      },
      input_state: inputState,
      status: {
        action_id: 'act_123',
        status: 'pending',
      },
    });
    expect(body).not.toHaveProperty('error_uri');

    const response = createStepUpErrorResponse(
      {
        error: 'step_up_required',
        code: 'step_up_required',
      },
      409
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    await expect(response.json()).resolves.not.toHaveProperty('error_uri');
  });
});
