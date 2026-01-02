/**
 * Error Factory
 *
 * Creates normalized ErrorDescriptor instances.
 * The factory does NOT produce HTTP responses - serialization happens at the endpoint layer.
 *
 * Design Principle:
 * ErrorFactory → ErrorDescriptor → Endpoint Layer (serialize to OAuth/Problem Details)
 *
 * @packageDocumentation
 */

import type { ErrorDescriptor, ErrorFactoryOptions, ErrorIdMode, ErrorLocale } from './types';
import type { ARErrorCode, RFCErrorCode } from './codes';
import { AR_ERROR_CODES, RFC_ERROR_CODES, getErrorDefinition } from './codes';
import { getTitle, getDetail, getRFCErrorMessage } from './resolver';
import { applySecurityMasking, generateErrorId } from './security';

/**
 * Error Factory class
 *
 * Produces ErrorDescriptor instances with proper localization and security masking.
 */
export class ErrorFactory {
  private locale: ErrorLocale;
  private errorIdMode: ErrorIdMode;

  constructor(options: { locale?: ErrorLocale; errorIdMode?: ErrorIdMode } = {}) {
    this.locale = options.locale || 'en';
    this.errorIdMode = options.errorIdMode || '5xx';
  }

  /**
   * Create error descriptor from AR error code
   *
   * @param code - Authrim error code (e.g., AR_ERROR_CODES.AUTH_SESSION_EXPIRED)
   * @param options - Additional options
   * @returns ErrorDescriptor
   */
  create(code: ARErrorCode, options: ErrorFactoryOptions = {}): ErrorDescriptor {
    const definition = getErrorDefinition(code);
    if (!definition) {
      // Fallback to internal error if code not found
      return this.createInternalError(options);
    }

    const locale = options.locale || this.locale;
    const errorIdMode = options.errorIdMode || this.errorIdMode;

    // Get title (always from titleKey)
    const title = getTitle(definition.titleKey, locale);

    // Get detail message:
    // 1. If detailFixed exists, use it (RFC-compliant fixed messages)
    // 2. Otherwise, resolve from detailKey
    // 3. Variables are only applied for 'public' security level
    let detail: string;
    if (definition.detailFixed) {
      // Use fixed detail (RFC-compliant, no translation, no variables)
      detail = definition.detailFixed;
    } else {
      // Resolve from detailKey
      // Variables are only applied for 'public' security level to prevent information leakage
      const effectiveVariables =
        definition.securityLevel === 'public' ? options.variables : undefined;
      detail = getDetail(definition.detailKey, locale, effectiveVariables);
    }

    // Generate error ID if applicable
    const errorId = generateErrorId(
      errorIdMode,
      definition.rfcError,
      definition.typeSlug,
      definition.status
    );

    // Create base descriptor
    let descriptor: ErrorDescriptor = {
      code: definition.code,
      rfcError: definition.rfcError,
      typeSlug: definition.typeSlug,
      title,
      detail,
      status: definition.status,
      meta: { ...definition.meta },
      errorId,
      state: options.state,
    };

    // Apply security masking (replaces detail with generic message for masked/internal levels)
    descriptor = applySecurityMasking(descriptor, definition, locale);

    return descriptor;
  }

  /**
   * Create error descriptor from RFC error code
   *
   * Used when only RFC error code is known (e.g., from external validation).
   *
   * @param rfcError - RFC error code
   * @param status - HTTP status code
   * @param customDetail - Optional custom detail message
   * @param options - Additional options
   * @returns ErrorDescriptor
   */
  createFromRFC(
    rfcError: RFCErrorCode,
    status: number,
    customDetail?: string,
    options: ErrorFactoryOptions = {}
  ): ErrorDescriptor {
    const locale = options.locale || this.locale;
    const errorIdMode = options.errorIdMode || this.errorIdMode;

    // Get RFC error message as title
    const title = getRFCErrorMessage(rfcError, locale);
    const detail = customDetail
      ? options.variables
        ? this.replacePlaceholders(customDetail, options.variables)
        : customDetail
      : title;

    // Generate error ID if applicable
    const errorId = generateErrorId(errorIdMode, rfcError, `rfc/${rfcError}`, status);

    // Map to reasonable defaults
    const descriptor: ErrorDescriptor = {
      code: `RFC_${rfcError.toUpperCase()}`,
      rfcError,
      typeSlug: `rfc/${rfcError}`,
      title,
      detail,
      status,
      meta: {
        retryable: status === 503 || status === 429,
        user_action: status === 401 ? 'login' : status >= 500 ? 'retry' : 'none',
        severity: status >= 500 ? 'error' : 'warn',
      },
      errorId,
      state: options.state,
    };

    return descriptor;
  }

  /**
   * Create internal error descriptor
   *
   * Used for unexpected errors or when error code is not found.
   *
   * @param options - Additional options
   * @returns ErrorDescriptor
   */
  createInternalError(options: ErrorFactoryOptions = {}): ErrorDescriptor {
    return this.create(AR_ERROR_CODES.INTERNAL_ERROR, options);
  }

  /**
   * Update locale
   *
   * @param locale - New locale
   */
  setLocale(locale: ErrorLocale): void {
    this.locale = locale;
  }

  /**
   * Update error ID mode
   *
   * @param mode - New error ID mode
   */
  setErrorIdMode(mode: ErrorIdMode): void {
    this.errorIdMode = mode;
  }

  /**
   * Get current locale
   */
  getLocale(): ErrorLocale {
    return this.locale;
  }

  /**
   * Get current error ID mode
   */
  getErrorIdMode(): ErrorIdMode {
    return this.errorIdMode;
  }

  /**
   * Replace placeholders in a string
   */
  private replacePlaceholders(message: string, variables: Record<string, string | number>): string {
    return message.replace(/\{(\w+)\}/g, (match, key: string) => {
      const value = variables[key];
      return value !== undefined ? String(value) : match;
    });
  }
}

// ============================================
// Convenience Factory Functions
// ============================================

/**
 * Default factory instance
 */
let defaultFactory: ErrorFactory | null = null;

/**
 * Get or create default factory
 */
function getDefaultFactory(): ErrorFactory {
  if (!defaultFactory) {
    defaultFactory = new ErrorFactory();
  }
  return defaultFactory;
}

/**
 * Configure default factory
 *
 * @param options - Factory options
 */
export function configureFactory(options: {
  locale?: ErrorLocale;
  errorIdMode?: ErrorIdMode;
}): void {
  defaultFactory = new ErrorFactory(options);
}

/**
 * Create error descriptor using default factory
 *
 * @param code - AR error code
 * @param options - Additional options
 * @returns ErrorDescriptor
 */
export function createError(code: ARErrorCode, options?: ErrorFactoryOptions): ErrorDescriptor {
  return getDefaultFactory().create(code, options);
}

/**
 * Create error from RFC error code using default factory
 *
 * @param rfcError - RFC error code
 * @param status - HTTP status code
 * @param customDetail - Optional custom detail
 * @param options - Additional options
 * @returns ErrorDescriptor
 */
export function createRFCError(
  rfcError: RFCErrorCode,
  status: number,
  customDetail?: string,
  options?: ErrorFactoryOptions
): ErrorDescriptor {
  return getDefaultFactory().createFromRFC(rfcError, status, customDetail, options);
}

// ============================================
// Pre-built Error Creators
// ============================================

/**
 * Pre-built error creators for common errors
 *
 * These provide a convenient API for creating common errors.
 */
export const Errors = {
  // Auth
  sessionExpired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_SESSION_EXPIRED, options),
  sessionNotFound: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_SESSION_NOT_FOUND, options),
  loginRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED, options),
  mfaRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_MFA_REQUIRED, options),
  passkeyFailed: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_PASSKEY_FAILED, options),
  invalidCode: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_INVALID_CODE, options),
  codeExpired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_CODE_EXPIRED, options),
  pkceRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_PKCE_REQUIRED, options),
  pkceInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.AUTH_PKCE_INVALID, options),

  // Token
  tokenInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_INVALID, options),
  tokenExpired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_EXPIRED, options),
  tokenRevoked: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_REVOKED, options),
  tokenReuseDetected: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_REUSE_DETECTED, options),
  dpopRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_DPOP_REQUIRED, options),
  dpopInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_DPOP_INVALID, options),
  dpopNonceRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.TOKEN_DPOP_NONCE_REQUIRED, options),

  // Client
  clientAuthFailed: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_AUTH_FAILED, options),
  clientInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_INVALID, options),
  redirectUriInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_REDIRECT_URI_INVALID, options),
  clientMetadataInvalid: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_METADATA_INVALID, options),
  grantNotAllowed: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT, options),
  scopeNotAllowed: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CLIENT_NOT_ALLOWED_SCOPE, options),

  // User
  invalidCredentials: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.USER_INVALID_CREDENTIALS, options),
  userLocked: (options?: ErrorFactoryOptions) => createError(AR_ERROR_CODES.USER_LOCKED, options),
  userInactive: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.USER_INACTIVE, options),

  // Policy
  featureDisabled: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.POLICY_FEATURE_DISABLED, options),
  insufficientPermissions: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS, options),
  invalidApiKey: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.POLICY_INVALID_API_KEY, options),

  // Rate Limiting
  rateLimitExceeded: (retryAfter?: number, options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
      ...options,
      variables: { retry_after: retryAfter || 60, ...options?.variables },
    }),
  slowDown: (options?: ErrorFactoryOptions) => createError(AR_ERROR_CODES.RATE_SLOW_DOWN, options),

  // Admin
  adminAuthRequired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.ADMIN_AUTH_REQUIRED, options),
  adminInsufficientPermissions: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, options),
  adminResourceNotFound: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, options),

  // Internal
  internalError: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.INTERNAL_ERROR, options),
  serverError: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.INTERNAL_ERROR, options),

  // Validation
  requiredField: (field?: string, options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      ...options,
      variables: field ? { field, ...options?.variables } : options?.variables,
    }),
  invalidFormat: (field?: string, options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
      ...options,
      variables: field ? { field, ...options?.variables } : options?.variables,
    }),
  invalidValue: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.VALIDATION_INVALID_VALUE, options),
  invalidJson: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.VALIDATION_INVALID_JSON, options),
  invalidLength: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.VALIDATION_INVALID_LENGTH, options),

  // Device Flow (RFC 8628)
  deviceAuthorizationPending: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.DEVICE_AUTHORIZATION_PENDING, options),
  deviceSlowDown: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.DEVICE_SLOW_DOWN, options),
  deviceCodeExpired: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.DEVICE_CODE_EXPIRED, options),

  // CIBA
  cibaAuthorizationPending: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CIBA_AUTHORIZATION_PENDING, options),
  cibaSlowDown: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CIBA_SLOW_DOWN, options),
  cibaExpired: (options?: ErrorFactoryOptions) => createError(AR_ERROR_CODES.CIBA_EXPIRED, options),
  cibaInvalidBindingMessage: (options?: ErrorFactoryOptions) =>
    createError(AR_ERROR_CODES.CIBA_INVALID_BINDING_MESSAGE, options),
};

// Re-export codes for convenience
export { AR_ERROR_CODES, RFC_ERROR_CODES };
