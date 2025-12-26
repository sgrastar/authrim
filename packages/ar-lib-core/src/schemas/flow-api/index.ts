/**
 * Flow View API - Type Definitions
 *
 * This module exports TypeScript types for the Flow View API,
 * which is the SDK-facing interface for the Flow × UI separation architecture.
 *
 * @see ../flow-ui/index.ts - UI Contract types
 * @see docs/architecture/flow-ui/04-api-specification.md
 * @see ../../types/contracts - Contract hierarchy types
 */

import type { UIContract } from '../flow-ui';
import type { ResolvedPolicy } from '../../types/contracts';

// =============================================================================
// API Request Types
// =============================================================================

/**
 * Request for GET /api/flow/contracts
 */
export interface FlowContractRequest {
  /** Challenge ID from /authorize redirect */
  challenge_id: string;
  /** Preferred locale (e.g., 'en', 'ja'). Default: 'en' */
  locale?: string;
}

/**
 * Request for POST /api/flow/events
 */
export interface FlowEventRequest {
  /** Challenge ID */
  challenge_id: string;
  /** Event type */
  event: FlowEventType;
  /** Capability data keyed by capability ID */
  data?: Record<string, CapabilityValue>;
  /** Optional client metadata */
  client_metadata?: ClientMetadata;
}

/**
 * Request for POST /api/flow/capabilities/:id/submit
 */
export interface FlowCapabilitySubmitRequest {
  /** Challenge ID */
  challenge_id: string;
  /** WebAuthn credential (for passkey capability) */
  credential?: WebAuthnCredential;
  /** Generic capability data */
  data?: Record<string, unknown>;
}

/**
 * Request for GET /api/flow/webauthn/options
 */
export interface FlowWebAuthnOptionsRequest {
  /** Challenge ID */
  challenge_id: string;
  /** Capability ID (e.g., 'passkey') */
  capability_id: string;
  /** WebAuthn ceremony mode. Default: 'authenticate' */
  mode?: 'authenticate' | 'register';
}

// =============================================================================
// Event Types
// =============================================================================

/**
 * Flow event types that can be sent to POST /api/flow/events.
 *
 * Events are grouped by category:
 * - Form submission: SUBMIT
 * - Auth method selection: USE_PASSKEY, USE_EMAIL_CODE, USE_DID, USE_EXTERNAL_IDP
 * - Consent: APPROVE, DENY
 * - Navigation: CONFIRM, CANCEL, BACK
 * - Organization: SWITCH_ORG
 * - Utility: RESEND_CODE
 */
export type FlowEventType =
  | 'SUBMIT'
  | 'USE_PASSKEY'
  | 'USE_EMAIL_CODE'
  | 'USE_DID'
  | 'USE_EXTERNAL_IDP'
  | 'APPROVE'
  | 'DENY'
  | 'CONFIRM'
  | 'CANCEL'
  | 'BACK'
  | 'SWITCH_ORG'
  | 'RESEND_CODE';

// =============================================================================
// Response Types
// =============================================================================

/**
 * Response from POST /api/flow/events and POST /api/flow/capabilities/:id/submit.
 *
 * This is a discriminated union based on the `type` field:
 * - `contract`: Flow continues, render new UI contract
 * - `redirect`: Flow complete, redirect to client
 * - `pending`: Async action required (e.g., WebAuthn ceremony)
 * - `error`: Business logic error (validation, rate limit, etc.)
 */
export type FlowEventResponse =
  | FlowContractResponse
  | FlowRedirectResponse
  | FlowPendingResponse
  | FlowErrorResponse;

/**
 * Contract response - flow continues with new UI state.
 */
export interface FlowContractResponse {
  type: 'contract';
  /** New UI contract to render */
  contract: UIContract;
  /**
   * Resolved policy for this flow session.
   * Included on first response, optional on subsequent responses.
   * Pinned to session for consistency during authentication flow.
   */
  policy?: ResolvedPolicy;
}

/**
 * Redirect response - flow complete, redirect to client callback.
 */
export interface FlowRedirectResponse {
  type: 'redirect';
  /** URL to redirect the user to */
  redirect_url: string;
}

/**
 * Pending response - async action required before continuing.
 *
 * When received, the client should:
 * 1. Execute the pending action (e.g., WebAuthn ceremony)
 * 2. Submit the result via POST /api/flow/capabilities/:id/submit
 */
export interface FlowPendingResponse {
  type: 'pending';
  /** Type of action required */
  next_action: PendingAction;
  /** Capability ID for submitting results */
  capability_id: string;
}

/**
 * Error response - business logic error occurred.
 *
 * Note: HTTP-level errors (4xx/5xx) use RFC 9457 Problem Details format.
 * This type is for validation and business logic errors within a 200 response.
 */
export interface FlowErrorResponse {
  type: 'error';
  /** Error details */
  error: FlowError;
}

/**
 * Types of pending actions that require async processing.
 */
export type PendingAction =
  | 'webauthn' // Requires WebAuthn ceremony
  | 'device_binding' // Requires device attestation
  | 'external_idp'; // Redirect to external IdP (handled differently)

// =============================================================================
// Error Types
// =============================================================================

/**
 * Flow error details.
 *
 * Used for validation and business logic errors that don't warrant
 * an HTTP error status code.
 */
export interface FlowError {
  /** Error code (e.g., 'validation_failed', 'rate_limited') */
  code: string;
  /** Error message - i18n key (e.g., 'flow.error.validation_failed') */
  message: string;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Suggested user action */
  user_action?: UserAction;
  /** Field-specific validation errors */
  field_errors?: FieldError[];
}

/**
 * Suggested user action for error recovery.
 */
export type UserAction =
  | 'retry' // User can retry the same action
  | 'login' // User should start a new login flow
  | 'contact_admin' // User should contact support
  | 'none'; // No action possible

/**
 * Field-specific validation error.
 */
export interface FieldError {
  /** Capability field ID (e.g., 'email', 'otp') */
  field: string;
  /** Validation error code (e.g., 'required', 'invalid_format') */
  code: string;
  /** Error message - i18n key */
  message: string;
}

// =============================================================================
// Supporting Types
// =============================================================================

/**
 * Value submitted for a capability field.
 */
export interface CapabilityValue {
  /** The submitted value (string, boolean, or string array) */
  value: string | boolean | string[];
  /** Raw data for complex types (e.g., WebAuthn credential) */
  raw?: unknown;
}

/**
 * Client metadata for analytics and security.
 */
export interface ClientMetadata {
  /** User agent string */
  user_agent?: string;
  /** Browser language preference */
  language?: string;
  /** Client timezone */
  timezone?: string;
  /** Screen resolution */
  screen_resolution?: string;
}

/**
 * WebAuthn credential for passkey authentication.
 * Matches the Web Authentication API Credential interface.
 *
 * @see https://www.w3.org/TR/webauthn-2/#iface-pkcredential
 */
export interface WebAuthnCredential {
  /** Base64URL-encoded credential ID */
  id: string;
  /** Base64URL-encoded raw ID */
  rawId: string;
  /** Credential type - always 'public-key' */
  type: 'public-key';
  /** Authenticator response */
  response: WebAuthnAuthenticatorResponse;
  /** Authenticator attachment type (optional) */
  authenticatorAttachment?: 'platform' | 'cross-platform';
}

/**
 * WebAuthn authenticator response.
 */
export interface WebAuthnAuthenticatorResponse {
  /** Base64URL-encoded authenticator data */
  authenticatorData: string;
  /** Base64URL-encoded client data JSON */
  clientDataJSON: string;
  /** Base64URL-encoded signature */
  signature: string;
  /** Base64URL-encoded user handle (optional) */
  userHandle?: string;
}

/**
 * WebAuthn options for credential request.
 * Returned by GET /api/flow/webauthn/options.
 *
 * @see https://www.w3.org/TR/webauthn-2/#dictdef-publickeycredentialrequestoptions
 */
export interface WebAuthnOptions {
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * PublicKeyCredentialRequestOptions in JSON format.
 * Uses Base64URL encoding for binary fields.
 */
export interface PublicKeyCredentialRequestOptionsJSON {
  /** Base64URL-encoded challenge */
  challenge: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Relying Party ID */
  rpId?: string;
  /** Allowed credentials */
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  /** User verification requirement */
  userVerification?: 'required' | 'preferred' | 'discouraged';
  /** Extensions */
  extensions?: AuthenticationExtensionsClientInputs;
}

/**
 * Credential descriptor in JSON format.
 */
export interface PublicKeyCredentialDescriptorJSON {
  /** Credential type */
  type: 'public-key';
  /** Base64URL-encoded credential ID */
  id: string;
  /** Allowed transports */
  transports?: AuthenticatorTransport[];
}

/**
 * Authenticator transport types.
 */
export type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';

/**
 * Authentication extensions input.
 * Placeholder - extend as needed.
 */
export interface AuthenticationExtensionsClientInputs {
  [key: string]: unknown;
}

// =============================================================================
// Error Code Constants
// =============================================================================

/**
 * Flow API error codes.
 * Format: AR120XXX (120 = Flow API module)
 *
 * @see packages/ar-lib-core/src/errors/codes.ts for full registry
 */
export const FLOW_API_ERROR_CODES = {
  /** challenge_id query parameter not provided */
  MISSING_CHALLENGE_ID: 'AR120001',
  /** Challenge does not exist */
  CHALLENGE_NOT_FOUND: 'AR120002',
  /** Challenge has expired */
  CHALLENGE_EXPIRED: 'AR120003',
  /** Challenge has already been used */
  CHALLENGE_CONSUMED: 'AR120004',
  /** Unknown event type */
  INVALID_EVENT: 'AR120005',
  /** Event not allowed in current state */
  INVALID_TRANSITION: 'AR120006',
  /** Capability data validation failed */
  VALIDATION_FAILED: 'AR120007',
  /** WebAuthn credential verification failed */
  WEBAUTHN_FAILED: 'AR120008',
  /** External IdP authentication failed */
  EXTERNAL_IDP_FAILED: 'AR120009',
  /** Capability not found */
  CAPABILITY_NOT_FOUND: 'AR120010',
} as const;

export type FlowApiErrorCode = (typeof FLOW_API_ERROR_CODES)[keyof typeof FLOW_API_ERROR_CODES];

// =============================================================================
// RFC 9457 Problem Details
// =============================================================================

/**
 * RFC 9457 Problem Details for HTTP APIs.
 * Used for HTTP-level error responses (4xx/5xx).
 *
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */
export interface ProblemDetails {
  /** URI reference that identifies the problem type */
  type: string;
  /** Short, human-readable summary */
  title: string;
  /** HTTP status code */
  status: number;
  /** Human-readable explanation specific to this occurrence */
  detail?: string;
  /** URI reference for this specific occurrence */
  instance?: string;

  // Authrim extensions
  /** Machine-readable error code (e.g., 'challenge_expired') */
  error?: string;
  /** Authrim error code (e.g., 'AR002003') */
  error_code?: FlowApiErrorCode;
  /** Trace ID for support requests */
  error_id?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for FlowContractResponse.
 */
export function isFlowContractResponse(
  response: FlowEventResponse
): response is FlowContractResponse {
  return response.type === 'contract';
}

/**
 * Type guard for FlowRedirectResponse.
 */
export function isFlowRedirectResponse(
  response: FlowEventResponse
): response is FlowRedirectResponse {
  return response.type === 'redirect';
}

/**
 * Type guard for FlowPendingResponse.
 */
export function isFlowPendingResponse(
  response: FlowEventResponse
): response is FlowPendingResponse {
  return response.type === 'pending';
}

/**
 * Type guard for FlowErrorResponse.
 */
export function isFlowErrorResponse(response: FlowEventResponse): response is FlowErrorResponse {
  return response.type === 'error';
}
