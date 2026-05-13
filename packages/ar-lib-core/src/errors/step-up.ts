import {
  createPhase1ErrorDetails,
  type Phase1ErrorDetailCode,
  type Phase1ErrorDetails,
  type Phase1ErrorDetailsOverrides,
} from './details';

export type StepUpErrorDetailCode = Extract<
  Phase1ErrorDetailCode,
  | 'step_up_required'
  | 'preferred_method_unavailable'
  | 'invalid_step_up_input'
  | 'step_up_attempts_exhausted'
  | 'resend_limit_exceeded'
  | 'user_canceled'
  | 'idempotency_conflict'
>;

export type StepUpActionStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'canceled';

export interface StepUpPreferredMethod {
  category?: string;
  method?: string;
}

export interface StepUpStatusObject {
  action_id?: string;
  status: StepUpActionStatus;
  preferred_method?: StepUpPreferredMethod;
  attempts_remaining?: number;
  max_attempts?: number;
  resend_available_at?: string;
  resend_available_at_unix?: number;
  resends_remaining?: number;
  expires_at?: string;
  expires_at_unix?: number;
  [key: string]: unknown;
}

export interface StepUpInputState {
  field?: string;
  attempts_remaining?: number;
  max_attempts?: number;
  retry_after_seconds?: number;
  [key: string]: unknown;
}

export interface StepUpErrorResponseBody {
  error: string;
  error_description?: string;
  error_details: Phase1ErrorDetails<StepUpErrorDetailCode>;
  step_up?: unknown;
  status?: StepUpStatusObject;
  input_state?: StepUpInputState;
  next_action?: unknown;
}

export interface CreateStepUpErrorBodyInput {
  error: string;
  error_description?: string;
  code: StepUpErrorDetailCode;
  details?: Phase1ErrorDetailsOverrides;
  field?: string;
  input_state?: StepUpInputState;
  step_up?: unknown;
  status?: StepUpStatusObject;
  next_action?: unknown;
}

export function createStepUpErrorBody(input: CreateStepUpErrorBodyInput): StepUpErrorResponseBody {
  const errorDetails = createPhase1ErrorDetails(input.code, {
    ...(input.details ?? {}),
    ...(input.field ? { field: input.field } : {}),
    ...(input.input_state ? { input_state: input.input_state } : {}),
  }) as Phase1ErrorDetails<StepUpErrorDetailCode>;

  return {
    error: input.error,
    ...(input.error_description ? { error_description: input.error_description } : {}),
    error_details: errorDetails,
    ...(input.step_up !== undefined ? { step_up: input.step_up } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.input_state ? { input_state: input.input_state } : {}),
    ...(input.next_action !== undefined ? { next_action: input.next_action } : {}),
  };
}

export function createStepUpErrorResponse(
  input: CreateStepUpErrorBodyInput,
  httpStatus: 400 | 403 | 409 | 429 | 500 = 400
): Response {
  return new Response(JSON.stringify(createStepUpErrorBody(input)), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
