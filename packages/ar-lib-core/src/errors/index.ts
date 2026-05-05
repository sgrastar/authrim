/**
 * Authrim Error System
 *
 * Centralized error handling for OAuth/OIDC and Authrim-specific errors.
 *
 * Architecture:
 * ```
 * ErrorFactory → ErrorDescriptor → Serializer → HTTP Response
 * ```
 *
 * Key exports for SDK public exposure:
 * - ErrorDescriptor: Normalized error structure
 * - ErrorMeta: Metadata for AI Agents and SDKs
 * - UserAction: Recommended recovery actions
 * - Severity: Error severity levels
 *
 * @packageDocumentation
 */

// ============================================
// Types (SDK Public)
// ============================================
export type {
  // Core types - SDK mandatory
  ErrorDescriptor,
  ErrorMeta,
  UserAction,
  Severity,

  // Response formats
  OAuthErrorResponse,
  ProblemDetailsResponse,
  ErrorResponseFormat,

  // Configuration types
  ErrorLocale,
  ErrorIdMode,
  ErrorSecurityLevel,
  ErrorCodeDefinition,
  ErrorFactoryOptions,
  SerializeOptions,

  // Utility types
  ErrorMessages,
  SecurityTrackedError,
  OIDCCoreEndpoint,
} from './types';

export {
  // Constants
  SECURITY_TRACKED_ERRORS,
  OIDC_CORE_ENDPOINTS,
} from './types';

// ============================================
// Error Codes
// ============================================
export {
  // RFC Standard error codes
  RFC_ERROR_CODES,
  type RFCErrorCode,

  // Authrim error codes
  AR_ERROR_CODES,
  type ARErrorCode,

  // Error definitions
  ERROR_DEFINITIONS,
  getErrorDefinition,
  getErrorDefinitionBySlug,
} from './codes';

export {
  PHASE1_ERROR_DETAIL_CODES,
  PHASE1_ERROR_DETAIL_DEFINITIONS,
  getPhase1ErrorDetailDefinition,
  createPhase1ErrorDetails,
  type Phase1ErrorDetailCode,
  type NativeSSOErrorDetailCode,
  type DeviceSecretPolicyErrorDetailCode,
  type CompatibilityErrorDetailCode,
  type Phase1ErrorDetailDefinition,
  type Phase1ErrorDetailDefinitions,
  type Phase1ErrorDetails,
  type Phase1ErrorDetailsOverrides,
  type Phase1ErrorDetailSeverity,
  type Phase1ErrorDetailUserAction,
} from './details';

export {
  createStepUpErrorBody,
  createStepUpErrorResponse,
  type CreateStepUpErrorBodyInput,
  type StepUpActionStatus,
  type StepUpErrorDetailCode,
  type StepUpErrorResponseBody,
  type StepUpInputState,
  type StepUpPreferredMethod,
  type StepUpStatusObject,
} from './step-up';

// ============================================
// Factory
// ============================================
export {
  // Factory class
  ErrorFactory,

  // Factory configuration
  configureFactory,

  // Factory functions
  createError,
  createRFCError,

  // Pre-built error creators
  Errors,
} from './factory';

// ============================================
// Serializer
// ============================================
export {
  // Main serialization function
  serializeError,

  // Format-specific serializers
  serializeToOAuth,
  serializeToProblemDetails,
  serializeToRedirect,

  // Helpers
  determineFormat,
  createSerializer,
  errorResponse,
  redirectErrorResponse,
} from './serializer';

// ============================================
// Resolver (i18n)
// ============================================
export {
  getMessage,
  getRFCErrorMessage,
  getTitle,
  getDetail,
  replacePlaceholders,
  isLocaleSupported,
  getSupportedLocales,
  registerMessages,
  createResolver,
} from './resolver';

// ============================================
// Security
// ============================================
export {
  applySecurityMasking,
  generateErrorId,
  shouldLogFullDetails,
  sanitizeForLogging,
  getMaskedMessage,
} from './security';

// ============================================
// Middleware (Hono integration)
// ============================================
export {
  AuthrimError,
  RFCError,
  errorMiddleware,
  createErrorFactoryFromContext,
  createErrorResponse,
  createRFCErrorResponse,
} from './middleware';

// ============================================
// Messages (for custom message registration)
// ============================================
export { errorMessagesEn } from './messages/en';
export { errorMessagesJa } from './messages/ja';
