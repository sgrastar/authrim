/**
 * Validation Utilities
 *
 * Provides validation functions for OpenID Connect and OAuth 2.0 parameters.
 * Ensures that all input parameters meet specification requirements.
 */

import type {
  PresentationDefinition,
  InputDescriptor,
  InputDescriptorConstraints,
  FieldConstraint,
  SubmissionRequirement,
  ClientIdScheme,
} from '../types/openid4vp';

/**
 * Validation result interface
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Client ID validation
 * Must be a non-empty string with reasonable length
 *
 * @param clientId - Client identifier to validate
 * @returns ValidationResult
 */
export function validateClientId(clientId: string | undefined): ValidationResult {
  if (clientId === undefined || clientId === null) {
    return {
      valid: false,
      error: 'client_id is required',
    };
  }

  if (typeof clientId !== 'string') {
    return {
      valid: false,
      error: 'client_id must be a string',
    };
  }

  if (clientId.length === 0) {
    return {
      valid: false,
      error: 'client_id cannot be empty',
    };
  }

  if (clientId.length > 256) {
    return {
      valid: false,
      error: 'client_id is too long (max 256 characters)',
    };
  }

  // Client ID should contain only alphanumeric characters, hyphens, and underscores
  const clientIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!clientIdPattern.test(clientId)) {
    return {
      valid: false,
      error:
        'client_id contains invalid characters (use only alphanumeric, hyphens, and underscores)',
    };
  }

  return { valid: true };
}

/**
 * Re-export ClientIdScheme from openid4vp types for convenience
 * Note: The canonical definition is in types/openid4vp.ts
 */
export type { ClientIdScheme } from '../types/openid4vp';

/**
 * Client ID Scheme validation result
 */
export interface ClientIdSchemeValidationResult extends ValidationResult {
  /** The validated client_id scheme */
  scheme?: ClientIdScheme;
  /** Extracted identifier from client_id (e.g., DID, domain) */
  identifier?: string;
}

/**
 * Validate client_id based on client_id_scheme per OpenID4VP draft-23
 *
 * Each scheme has different validation rules:
 * - pre-registered: client_id matches pre-registered verifier
 * - redirect_uri: client_id is the redirect URI itself
 * - entity_id: client_id is an OpenID Federation Entity ID
 * - did: client_id is a DID (did:web, did:key, etc.)
 * - verifier_attestation: client_id from attestation JWT
 * - x509_san_dns: client_id is DNS name from X.509 SAN
 * - x509_san_uri: client_id is URI from X.509 SAN
 *
 * @param clientId - Client identifier
 * @param scheme - Client ID scheme
 * @param options - Validation options
 * @returns ClientIdSchemeValidationResult
 */
export function validateClientIdScheme(
  clientId: string | undefined,
  scheme: string | undefined,
  options: {
    /** List of pre-registered client IDs (for pre-registered scheme) */
    preRegisteredClients?: string[];
    /** Allow HTTP for redirect_uri scheme in development */
    allowHttp?: boolean;
  } = {}
): ClientIdSchemeValidationResult {
  if (!clientId) {
    return { valid: false, error: 'client_id is required' };
  }

  // Default to pre-registered if no scheme specified
  const effectiveScheme = (scheme || 'pre-registered') as ClientIdScheme;

  switch (effectiveScheme) {
    case 'pre-registered': {
      // Validate against list of pre-registered clients
      if (options.preRegisteredClients && !options.preRegisteredClients.includes(clientId)) {
        return {
          valid: false,
          error: 'client_id is not a registered verifier',
          scheme: effectiveScheme,
        };
      }
      // Basic format validation
      const basicResult = validateClientId(clientId);
      if (!basicResult.valid) {
        return { ...basicResult, scheme: effectiveScheme };
      }
      return { valid: true, scheme: effectiveScheme, identifier: clientId };
    }

    case 'redirect_uri': {
      // client_id must be a valid HTTPS URI (or http://localhost in dev)
      try {
        const url = new URL(clientId);
        if (url.protocol !== 'https:') {
          if (!(options.allowHttp && url.hostname === 'localhost')) {
            return {
              valid: false,
              error: 'client_id must be an HTTPS URI for redirect_uri scheme',
              scheme: effectiveScheme,
            };
          }
        }
        return { valid: true, scheme: effectiveScheme, identifier: url.origin };
      } catch {
        return {
          valid: false,
          error: 'client_id must be a valid URI for redirect_uri scheme',
          scheme: effectiveScheme,
        };
      }
    }

    case 'entity_id': {
      // client_id must be an OpenID Federation Entity Identifier (HTTPS URL)
      try {
        const url = new URL(clientId);
        if (url.protocol !== 'https:') {
          return {
            valid: false,
            error: 'entity_id must be an HTTPS URL',
            scheme: effectiveScheme,
          };
        }
        return { valid: true, scheme: effectiveScheme, identifier: clientId };
      } catch {
        return {
          valid: false,
          error: 'entity_id must be a valid HTTPS URL',
          scheme: effectiveScheme,
        };
      }
    }

    case 'did': {
      // client_id must be a valid DID
      if (!clientId.startsWith('did:')) {
        return {
          valid: false,
          error: 'client_id must be a DID (e.g., did:web:..., did:key:...)',
          scheme: effectiveScheme,
        };
      }
      // Basic DID format validation
      const didParts = clientId.split(':');
      if (didParts.length < 3) {
        return {
          valid: false,
          error: 'Invalid DID format: must have method and method-specific-id',
          scheme: effectiveScheme,
        };
      }
      const method = didParts[1];
      if (!/^[a-z0-9]+$/.test(method)) {
        return {
          valid: false,
          error: 'Invalid DID method: must be lowercase alphanumeric',
          scheme: effectiveScheme,
        };
      }
      return { valid: true, scheme: effectiveScheme, identifier: clientId };
    }

    case 'verifier_attestation': {
      // client_id is extracted from verifier attestation JWT
      // The actual validation happens when processing the attestation
      // Here we just ensure client_id is present
      if (!clientId || clientId.length === 0) {
        return {
          valid: false,
          error: 'client_id is required for verifier_attestation scheme',
          scheme: effectiveScheme,
        };
      }
      return { valid: true, scheme: effectiveScheme, identifier: clientId };
    }

    case 'x509_san_dns': {
      // client_id must be a valid DNS hostname
      // RFC 1035 hostname validation
      const dnsPattern = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*$/;
      if (!dnsPattern.test(clientId)) {
        return {
          valid: false,
          error: 'client_id must be a valid DNS hostname for x509_san_dns scheme',
          scheme: effectiveScheme,
        };
      }
      return { valid: true, scheme: effectiveScheme, identifier: clientId };
    }

    case 'x509_san_uri': {
      // client_id must be a valid URI
      try {
        const url = new URL(clientId);
        // Must be HTTPS for security
        if (url.protocol !== 'https:') {
          return {
            valid: false,
            error: 'client_id must be an HTTPS URI for x509_san_uri scheme',
            scheme: effectiveScheme,
          };
        }
        return { valid: true, scheme: effectiveScheme, identifier: clientId };
      } catch {
        return {
          valid: false,
          error: 'client_id must be a valid URI for x509_san_uri scheme',
          scheme: effectiveScheme,
        };
      }
    }

    default:
      return {
        valid: false,
        error: `Unknown client_id_scheme: ${scheme}`,
      };
  }
}

/**
 * Redirect URI validation
 * Must be a valid HTTPS URL (or http://localhost for development)
 *
 * @param redirectUri - Redirect URI to validate
 * @param allowHttp - Allow http:// for development (default: false)
 * @returns ValidationResult
 */
export function validateRedirectUri(
  redirectUri: string | undefined,
  allowHttp: boolean = false
): ValidationResult {
  if (!redirectUri) {
    return {
      valid: false,
      error: 'redirect_uri is required',
    };
  }

  if (typeof redirectUri !== 'string') {
    return {
      valid: false,
      error: 'redirect_uri must be a string',
    };
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return {
      valid: false,
      error: 'redirect_uri is not a valid URL',
    };
  }

  // Check protocol
  if (url.protocol === 'https:') {
    // HTTPS is always allowed
    return { valid: true };
  }

  if (url.protocol === 'http:') {
    if (!allowHttp) {
      return {
        valid: false,
        error: 'redirect_uri must use HTTPS (http:// is not allowed)',
      };
    }

    // Allow http://localhost or http://127.0.0.1 for development
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return { valid: true };
    }

    return {
      valid: false,
      error: 'redirect_uri must use HTTPS or be http://localhost',
    };
  }

  return {
    valid: false,
    error: `redirect_uri protocol "${url.protocol}" is not supported`,
  };
}

/**
 * Scope validation
 * Must contain 'openid' and only valid scope values
 *
 * @param scope - Space-separated scope string
 * @param allowCustomScopes - Allow custom scopes (for resource server integration)
 * @returns ValidationResult
 */
export function validateScope(
  scope: string | undefined,
  allowCustomScopes: boolean = true
): ValidationResult {
  if (!scope) {
    return {
      valid: false,
      error: 'scope is required',
    };
  }

  if (typeof scope !== 'string') {
    return {
      valid: false,
      error: 'scope must be a string',
    };
  }

  const scopes = scope
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);

  if (scopes.length === 0) {
    return {
      valid: false,
      error: 'scope cannot be empty',
    };
  }

  // OpenID Connect requires 'openid' scope
  if (!scopes.includes('openid')) {
    return {
      valid: false,
      error: 'scope must include "openid"',
    };
  }

  // Standard OIDC scopes
  const standardScopes = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];

  if (!allowCustomScopes) {
    // Strict mode: only allow standard scopes
    const invalidScopes = scopes.filter((s) => !standardScopes.includes(s));
    if (invalidScopes.length > 0) {
      return {
        valid: false,
        error: `Invalid scope(s): ${invalidScopes.join(', ')}. Only standard OIDC scopes are allowed.`,
      };
    }
  } else {
    // Permissive mode: allow custom scopes but warn about unknown standard scopes
    const unknownScopes = scopes.filter((s) => !standardScopes.includes(s));
    if (unknownScopes.length > 0) {
      // Log warning for monitoring, but don't fail validation
      // This allows custom resource server scopes (e.g., 'api:read', 'admin:write')
      console.warn(`Non-standard scopes requested: ${unknownScopes.join(', ')}`);
    }
  }

  return { valid: true };
}

/**
 * State parameter validation
 * Optional but recommended for CSRF protection
 *
 * @param state - State parameter to validate
 * @returns ValidationResult
 */
export function validateState(state: string | undefined): ValidationResult {
  // State is optional
  if (state === undefined || state === null) {
    return { valid: true };
  }

  if (typeof state !== 'string') {
    return {
      valid: false,
      error: 'state must be a string',
    };
  }

  if (state.length === 0) {
    return {
      valid: false,
      error: 'state cannot be empty if provided',
    };
  }

  if (state.length > 512) {
    return {
      valid: false,
      error: 'state is too long (max 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Nonce parameter validation
 * Optional but recommended for replay protection
 *
 * @param nonce - Nonce parameter to validate
 * @returns ValidationResult
 */
export function validateNonce(nonce: string | undefined): ValidationResult {
  // Nonce is optional (but recommended when using implicit flow)
  if (nonce === undefined || nonce === null) {
    return { valid: true };
  }

  if (typeof nonce !== 'string') {
    return {
      valid: false,
      error: 'nonce must be a string',
    };
  }

  if (nonce.length === 0) {
    return {
      valid: false,
      error: 'nonce cannot be empty if provided',
    };
  }

  if (nonce.length > 512) {
    return {
      valid: false,
      error: 'nonce is too long (max 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Grant type validation
 * Supports 'authorization_code' and 'refresh_token' grant types
 *
 * @param grantType - Grant type to validate
 * @returns ValidationResult
 */
export function validateGrantType(grantType: string | undefined): ValidationResult {
  if (!grantType) {
    return {
      valid: false,
      error: 'grant_type is required',
    };
  }

  if (typeof grantType !== 'string') {
    return {
      valid: false,
      error: 'grant_type must be a string',
    };
  }

  const supportedGrantTypes = ['authorization_code', 'refresh_token'];

  if (!supportedGrantTypes.includes(grantType)) {
    return {
      valid: false,
      error: `Unsupported grant_type: ${grantType}. Supported types: ${supportedGrantTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Response type validation
 * Must be 'code' for authorization code flow
 *
 * @param responseType - Response type to validate
 * @returns ValidationResult
 */
export function validateResponseType(responseType: string | undefined): ValidationResult {
  if (!responseType) {
    return {
      valid: false,
      error: 'response_type is required',
    };
  }

  if (typeof responseType !== 'string') {
    return {
      valid: false,
      error: 'response_type must be a string',
    };
  }

  // Supported response types per OIDC Core 3.3 (Hybrid Flow)
  const supportedResponseTypes = [
    'code', // Authorization Code Flow
    'id_token', // Implicit Flow (ID Token only)
    'id_token token', // Implicit Flow (ID Token + Access Token)
    'code id_token', // Hybrid Flow 1
    'code token', // Hybrid Flow 2
    'code id_token token', // Hybrid Flow 3
  ];

  if (!supportedResponseTypes.includes(responseType)) {
    return {
      valid: false,
      error: `Unsupported response_type: ${responseType}. Supported types: ${supportedResponseTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Authorization code validation
 * Accepts base64url-encoded random strings (recommended minimum 32 characters)
 *
 * @param code - Authorization code to validate
 * @returns ValidationResult
 */
export function validateAuthCode(code: string | undefined): ValidationResult {
  if (code === undefined || code === null) {
    return {
      valid: false,
      error: 'code is required',
    };
  }

  if (typeof code !== 'string') {
    return {
      valid: false,
      error: 'code must be a string',
    };
  }

  if (code.length === 0) {
    return {
      valid: false,
      error: 'code cannot be empty',
    };
  }

  // Base64url format validation (URL-safe: A-Z, a-z, 0-9, -, _)
  // Minimum length: 128 characters (recommended for security)
  // Maximum length: 512 characters (to prevent abuse)
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;

  if (!base64urlPattern.test(code)) {
    return {
      valid: false,
      error: 'code format is invalid (must be base64url format)',
    };
  }

  if (code.length < 32) {
    return {
      valid: false,
      error: 'code is too short (minimum 32 characters recommended)',
    };
  }

  if (code.length > 512) {
    return {
      valid: false,
      error: 'code is too long (maximum 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Token validation (JWT format)
 * Must be a valid JWT format (3 parts separated by dots)
 *
 * @param token - Token to validate
 * @returns ValidationResult
 */
export function validateToken(token: string | undefined): ValidationResult {
  if (!token) {
    return {
      valid: false,
      error: 'token is required',
    };
  }

  if (typeof token !== 'string') {
    return {
      valid: false,
      error: 'token must be a string',
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: 'token format is invalid (must have 3 parts)',
    };
  }

  // Check if parts are base64url encoded
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || !base64urlPattern.test(part)) {
      return {
        valid: false,
        error: `token part ${i + 1} is not valid base64url`,
      };
    }
  }

  return { valid: true };
}

/**
 * Normalize a URL for secure comparison
 *
 * RFC 6749 Section 3.1.2.3: Comparing redirect URIs
 * - Case-sensitive comparison for scheme and host (after normalization)
 * - Path comparison is case-sensitive
 * - Default ports should be normalized (80 for http, 443 for https)
 * - Trailing slashes and query strings need careful handling
 *
 * Security considerations:
 * - Prevents Open Redirect attacks via URL manipulation
 * - Handles edge cases like trailing slashes, default ports, empty paths
 *
 * @param uri - URL to normalize
 * @returns Normalized URL string or null if invalid
 */
export function normalizeRedirectUri(uri: string): string | null {
  try {
    const url = new URL(uri);

    // Only allow http and https schemes
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    // Normalize hostname to lowercase
    const hostname = url.hostname.toLowerCase();

    // Remove default ports (80 for http, 443 for https)
    let port = url.port;
    if (
      (url.protocol === 'http:' && port === '80') ||
      (url.protocol === 'https:' && port === '443')
    ) {
      port = '';
    }

    // Normalize path: ensure at least "/" and remove trailing slash for consistency
    // Exception: root path "/" should remain as "/"
    let path = url.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    // Reconstruct normalized URL
    // Note: We intentionally exclude query strings and fragments from comparison
    // as they should not be part of the registered redirect_uri
    const normalizedPort = port ? `:${port}` : '';
    return `${url.protocol}//${hostname}${normalizedPort}${path}`;
  } catch {
    // Invalid URL
    return null;
  }
}

/**
 * Check if a provided redirect_uri matches any registered URI
 *
 * This function performs secure URL comparison with normalization
 * to prevent Open Redirect vulnerabilities.
 *
 * @param providedUri - The redirect_uri from the authorization request
 * @param registeredUris - Array of registered redirect_uris for the client
 * @returns true if the providedUri matches any registered URI
 */
export function isRedirectUriRegistered(providedUri: string, registeredUris: string[]): boolean {
  const normalizedProvided = normalizeRedirectUri(providedUri);

  // If the provided URI cannot be normalized, it's invalid
  if (!normalizedProvided) {
    return false;
  }

  // Check against each registered URI
  for (const registered of registeredUris) {
    const normalizedRegistered = normalizeRedirectUri(registered);
    if (normalizedRegistered && normalizedProvided === normalizedRegistered) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// OpenID4VP Validation Functions
// =============================================================================

/**
 * Presentation Definition validation result
 */
export interface PDValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a Presentation Definition
 *
 * Validates the structure and content of a Presentation Definition
 * per DIF Presentation Exchange specification.
 *
 * @param pd - The Presentation Definition to validate
 * @returns Validation result with errors
 */
export function validatePresentationDefinition(pd: unknown): PDValidationResult {
  const errors: string[] = [];

  if (!pd || typeof pd !== 'object') {
    return { valid: false, errors: ['Presentation Definition must be an object'] };
  }

  const definition = pd as Record<string, unknown>;

  // Validate id (required)
  if (!definition.id || typeof definition.id !== 'string') {
    errors.push('Presentation Definition must have a string id');
  } else if (definition.id.length === 0) {
    errors.push('Presentation Definition id cannot be empty');
  } else if (definition.id.length > 256) {
    errors.push('Presentation Definition id is too long (max 256 characters)');
  }

  // Validate name (optional)
  if (definition.name !== undefined) {
    if (typeof definition.name !== 'string') {
      errors.push('Presentation Definition name must be a string');
    } else if (definition.name.length > 256) {
      errors.push('Presentation Definition name is too long (max 256 characters)');
    }
  }

  // Validate purpose (optional)
  if (definition.purpose !== undefined) {
    if (typeof definition.purpose !== 'string') {
      errors.push('Presentation Definition purpose must be a string');
    } else if (definition.purpose.length > 1000) {
      errors.push('Presentation Definition purpose is too long (max 1000 characters)');
    }
  }

  // Validate input_descriptors (required)
  if (!definition.input_descriptors) {
    errors.push('Presentation Definition must have input_descriptors');
  } else if (!Array.isArray(definition.input_descriptors)) {
    errors.push('input_descriptors must be an array');
  } else if (definition.input_descriptors.length === 0) {
    errors.push('input_descriptors must have at least one descriptor');
  } else {
    // Track descriptor IDs for uniqueness check
    const seenIds = new Set<string>();

    for (let i = 0; i < definition.input_descriptors.length; i++) {
      const descriptor = definition.input_descriptors[i];
      const descriptorErrors = validateInputDescriptor(descriptor, i);
      errors.push(...descriptorErrors);

      // Check for duplicate IDs
      if (descriptor && typeof descriptor === 'object' && 'id' in descriptor) {
        const id = (descriptor as { id: unknown }).id;
        if (typeof id === 'string') {
          if (seenIds.has(id)) {
            errors.push(`Duplicate input_descriptor id: ${id}`);
          }
          seenIds.add(id);
        }
      }
    }
  }

  // Validate submission_requirements (optional)
  if (definition.submission_requirements !== undefined) {
    if (!Array.isArray(definition.submission_requirements)) {
      errors.push('submission_requirements must be an array');
    } else {
      for (let i = 0; i < definition.submission_requirements.length; i++) {
        const requirement = definition.submission_requirements[i];
        const reqErrors = validateSubmissionRequirement(requirement, i);
        errors.push(...reqErrors);
      }
    }
  }

  // Validate format (optional)
  if (definition.format !== undefined) {
    const formatErrors = validateVPFormats(definition.format);
    errors.push(...formatErrors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an Input Descriptor
 *
 * @param descriptor - The descriptor to validate
 * @param index - Index for error messages
 * @returns Array of error messages
 */
function validateInputDescriptor(descriptor: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `input_descriptors[${index}]`;

  if (!descriptor || typeof descriptor !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  const desc = descriptor as Record<string, unknown>;

  // Validate id (required)
  if (!desc.id || typeof desc.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  } else if (desc.id.length === 0) {
    errors.push(`${prefix}.id cannot be empty`);
  }

  // Validate name (optional)
  if (desc.name !== undefined && typeof desc.name !== 'string') {
    errors.push(`${prefix}.name must be a string`);
  }

  // Validate purpose (optional)
  if (desc.purpose !== undefined && typeof desc.purpose !== 'string') {
    errors.push(`${prefix}.purpose must be a string`);
  }

  // Validate constraints (required)
  if (!desc.constraints) {
    errors.push(`${prefix}.constraints is required`);
  } else if (typeof desc.constraints !== 'object') {
    errors.push(`${prefix}.constraints must be an object`);
  } else {
    const constraintErrors = validateConstraints(desc.constraints, prefix);
    errors.push(...constraintErrors);
  }

  // Validate format (optional)
  if (desc.format !== undefined) {
    const formatErrors = validateVPFormats(desc.format);
    errors.push(...formatErrors.map((e) => `${prefix}.format: ${e}`));
  }

  return errors;
}

/**
 * Validate Input Descriptor Constraints
 *
 * @param constraints - The constraints to validate
 * @param prefix - Prefix for error messages
 * @returns Array of error messages
 */
function validateConstraints(constraints: unknown, prefix: string): string[] {
  const errors: string[] = [];

  if (!constraints || typeof constraints !== 'object') {
    errors.push(`${prefix}.constraints must be an object`);
    return errors;
  }

  const cons = constraints as Record<string, unknown>;

  // Validate fields (optional)
  if (cons.fields !== undefined) {
    if (!Array.isArray(cons.fields)) {
      errors.push(`${prefix}.constraints.fields must be an array`);
    } else {
      for (let i = 0; i < cons.fields.length; i++) {
        const fieldErrors = validateFieldConstraint(
          cons.fields[i],
          `${prefix}.constraints.fields[${i}]`
        );
        errors.push(...fieldErrors);
      }
    }
  }

  // Validate limit_disclosure (optional)
  if (cons.limit_disclosure !== undefined) {
    if (cons.limit_disclosure !== 'required' && cons.limit_disclosure !== 'preferred') {
      errors.push(`${prefix}.constraints.limit_disclosure must be 'required' or 'preferred'`);
    }
  }

  return errors;
}

/**
 * Validate a Field Constraint
 *
 * @param field - The field constraint to validate
 * @param prefix - Prefix for error messages
 * @returns Array of error messages
 */
function validateFieldConstraint(field: unknown, prefix: string): string[] {
  const errors: string[] = [];

  if (!field || typeof field !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  const fc = field as Record<string, unknown>;

  // Validate path (required)
  if (!fc.path) {
    errors.push(`${prefix}.path is required`);
  } else if (!Array.isArray(fc.path)) {
    errors.push(`${prefix}.path must be an array`);
  } else if (fc.path.length === 0) {
    errors.push(`${prefix}.path must have at least one JSONPath`);
  } else {
    for (let i = 0; i < fc.path.length; i++) {
      if (typeof fc.path[i] !== 'string') {
        errors.push(`${prefix}.path[${i}] must be a string`);
      } else {
        // Validate JSONPath syntax (basic check)
        const path = fc.path[i] as string;
        if (!path.startsWith('$')) {
          errors.push(`${prefix}.path[${i}] must start with '$' (JSONPath syntax)`);
        }
      }
    }
  }

  // Validate id (optional)
  if (fc.id !== undefined && typeof fc.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  }

  // Validate purpose (optional)
  if (fc.purpose !== undefined && typeof fc.purpose !== 'string') {
    errors.push(`${prefix}.purpose must be a string`);
  }

  // Validate optional (optional)
  if (fc.optional !== undefined && typeof fc.optional !== 'boolean') {
    errors.push(`${prefix}.optional must be a boolean`);
  }

  // Validate filter (optional) - JSON Schema validation
  if (fc.filter !== undefined) {
    if (typeof fc.filter !== 'object' || fc.filter === null) {
      errors.push(`${prefix}.filter must be an object (JSON Schema)`);
    } else {
      const filterErrors = validateJSONSchemaBasic(fc.filter, `${prefix}.filter`);
      errors.push(...filterErrors);
    }
  }

  return errors;
}

/**
 * Basic JSON Schema validation
 *
 * Validates common JSON Schema properties used in Presentation Definition filters.
 * This is not a full JSON Schema validator, but catches common issues.
 *
 * @param schema - The JSON Schema object to validate
 * @param prefix - Prefix for error messages
 * @returns Array of error messages
 */
function validateJSONSchemaBasic(schema: unknown, prefix: string): string[] {
  const errors: string[] = [];

  if (!schema || typeof schema !== 'object') {
    return errors;
  }

  const s = schema as Record<string, unknown>;

  // Validate type
  if (s.type !== undefined) {
    const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
    if (typeof s.type === 'string') {
      if (!validTypes.includes(s.type)) {
        errors.push(`${prefix}.type must be one of: ${validTypes.join(', ')}`);
      }
    } else if (Array.isArray(s.type)) {
      for (const t of s.type) {
        if (typeof t !== 'string' || !validTypes.includes(t)) {
          errors.push(`${prefix}.type array contains invalid type`);
        }
      }
    } else {
      errors.push(`${prefix}.type must be a string or array of strings`);
    }
  }

  // Validate const
  if (s.const !== undefined) {
    // const can be any type, no validation needed
  }

  // Validate enum
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum)) {
      errors.push(`${prefix}.enum must be an array`);
    } else if (s.enum.length === 0) {
      errors.push(`${prefix}.enum must not be empty`);
    }
  }

  // Validate pattern
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string') {
      errors.push(`${prefix}.pattern must be a string`);
    } else {
      try {
        new RegExp(s.pattern);
      } catch {
        errors.push(`${prefix}.pattern is not a valid regular expression`);
      }
    }
  }

  // Validate format
  if (s.format !== undefined) {
    if (typeof s.format !== 'string') {
      errors.push(`${prefix}.format must be a string`);
    }
  }

  return errors;
}

/**
 * Validate Submission Requirement
 *
 * @param requirement - The requirement to validate
 * @param index - Index for error messages
 * @returns Array of error messages
 */
function validateSubmissionRequirement(requirement: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `submission_requirements[${index}]`;

  if (!requirement || typeof requirement !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  const req = requirement as Record<string, unknown>;

  // Validate rule (required)
  if (!req.rule) {
    errors.push(`${prefix}.rule is required`);
  } else if (req.rule !== 'all' && req.rule !== 'pick') {
    errors.push(`${prefix}.rule must be 'all' or 'pick'`);
  }

  // Validate pick-specific fields
  if (req.rule === 'pick') {
    const hasCount = req.count !== undefined;
    const hasMinMax = req.min !== undefined || req.max !== undefined;

    if (!hasCount && !hasMinMax) {
      errors.push(`${prefix} with rule 'pick' must have count or min/max`);
    }

    if (req.count !== undefined && typeof req.count !== 'number') {
      errors.push(`${prefix}.count must be a number`);
    }

    if (req.min !== undefined && typeof req.min !== 'number') {
      errors.push(`${prefix}.min must be a number`);
    }

    if (req.max !== undefined && typeof req.max !== 'number') {
      errors.push(`${prefix}.max must be a number`);
    }

    if (typeof req.min === 'number' && typeof req.max === 'number' && req.min > req.max) {
      errors.push(`${prefix}.min cannot be greater than max`);
    }
  }

  // Validate from or from_nested (one required)
  if (req.from === undefined && req.from_nested === undefined) {
    errors.push(`${prefix} must have either 'from' or 'from_nested'`);
  }

  if (req.from !== undefined && typeof req.from !== 'string') {
    errors.push(`${prefix}.from must be a string`);
  }

  if (req.from_nested !== undefined) {
    if (!Array.isArray(req.from_nested)) {
      errors.push(`${prefix}.from_nested must be an array`);
    } else {
      for (let i = 0; i < req.from_nested.length; i++) {
        const nestedErrors = validateSubmissionRequirement(req.from_nested[i], i);
        errors.push(...nestedErrors.map((e) => `${prefix}.from_nested: ${e}`));
      }
    }
  }

  return errors;
}

/**
 * Validate VP Formats
 *
 * @param format - The format object to validate
 * @returns Array of error messages
 */
function validateVPFormats(format: unknown): string[] {
  const errors: string[] = [];

  if (!format || typeof format !== 'object') {
    errors.push('format must be an object');
    return errors;
  }

  const f = format as Record<string, unknown>;

  // Known format types
  const knownFormats = [
    'jwt_vp',
    'jwt_vc',
    'jwt_vp_json',
    'jwt_vc_json',
    'ldp_vp',
    'ldp_vc',
    'ac_vp',
    'ac_vc',
    'dc+sd-jwt',
    'mso_mdoc',
  ];

  for (const [key, value] of Object.entries(f)) {
    if (!knownFormats.includes(key)) {
      // Unknown format - warn but don't error (extensibility)
      continue;
    }

    if (value !== undefined && typeof value !== 'object') {
      errors.push(`format.${key} must be an object`);
    }
  }

  return errors;
}

// =============================================================================
// JAR (JWT-Secured Authorization Request) Validation - RFC 9101
// =============================================================================

/**
 * JAR Request Object validation result
 */
export interface JARValidationResult {
  valid: boolean;
  errors: string[];
  claims?: Record<string, unknown>;
}

/**
 * JAR validation options
 */
export interface JARValidationOptions {
  /** Expected audience (usually the authorization server's issuer identifier) */
  audience: string;
  /** Expected issuer (the client_id for OIDC, or client's entity identifier) */
  expectedIssuer?: string;
  /** Maximum age of the request object in seconds (default: 300 = 5 minutes) */
  maxAge?: number;
  /** Clock skew tolerance in seconds (default: 60) */
  clockSkew?: number;
  /** Whether to require jti for replay prevention (default: false) */
  requireJti?: boolean;
  /** Set of previously seen jti values for replay prevention */
  seenJtiSet?: Set<string>;
}

/**
 * Validate JWT-Secured Authorization Request (JAR) claims
 *
 * Per RFC 9101:
 * - iss (REQUIRED): Must match client_id or client's registered issuer
 * - aud (REQUIRED): Must include the authorization server's issuer identifier
 * - exp (RECOMMENDED): Expiration time
 * - iat (RECOMMENDED): Issued at time
 * - jti (OPTIONAL): JWT ID for replay prevention
 *
 * @param claims - Parsed JWT claims from the request object
 * @param options - Validation options
 * @returns JARValidationResult
 */
export function validateJARClaims(
  claims: unknown,
  options: JARValidationOptions
): JARValidationResult {
  const errors: string[] = [];

  if (!claims || typeof claims !== 'object') {
    return { valid: false, errors: ['Request object claims must be an object'] };
  }

  const c = claims as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const clockSkew = options.clockSkew ?? 60;
  const maxAge = options.maxAge ?? 300;

  // Validate iss (REQUIRED per RFC 9101)
  if (!c.iss || typeof c.iss !== 'string') {
    errors.push('iss claim is required in request object');
  } else if (options.expectedIssuer && c.iss !== options.expectedIssuer) {
    errors.push(`iss claim mismatch: expected '${options.expectedIssuer}', got '${c.iss}'`);
  }

  // Validate aud (REQUIRED per RFC 9101)
  if (!c.aud) {
    errors.push('aud claim is required in request object');
  } else {
    const audArray = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!audArray.includes(options.audience)) {
      errors.push(`aud claim must include '${options.audience}'`);
    }
  }

  // Validate exp (RECOMMENDED per RFC 9101)
  if (c.exp !== undefined) {
    if (typeof c.exp !== 'number') {
      errors.push('exp claim must be a number');
    } else if (c.exp < now - clockSkew) {
      errors.push('Request object has expired');
    }
  }

  // Validate iat (RECOMMENDED per RFC 9101)
  if (c.iat !== undefined) {
    if (typeof c.iat !== 'number') {
      errors.push('iat claim must be a number');
    } else {
      // Check not in the future
      if (c.iat > now + clockSkew) {
        errors.push('Request object iat is in the future');
      }
      // Check not too old
      if (c.iat < now - maxAge) {
        errors.push(`Request object is too old (issued ${now - c.iat}s ago, max: ${maxAge}s)`);
      }
    }
  }

  // Validate nbf (not before) if present
  if (c.nbf !== undefined) {
    if (typeof c.nbf !== 'number') {
      errors.push('nbf claim must be a number');
    } else if (c.nbf > now + clockSkew) {
      errors.push('Request object is not yet valid (nbf)');
    }
  }

  // Validate jti (for replay prevention)
  if (options.requireJti && !c.jti) {
    errors.push('jti claim is required for replay prevention');
  }

  if (c.jti !== undefined) {
    if (typeof c.jti !== 'string') {
      errors.push('jti claim must be a string');
    } else if (options.seenJtiSet?.has(c.jti)) {
      errors.push('Request object has already been used (replay detected)');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    claims: errors.length === 0 ? (c as Record<string, unknown>) : undefined,
  };
}

/**
 * Validate that request object claims don't conflict with query parameters
 *
 * Per RFC 9101 Section 6.3:
 * - client_id in query parameter and request object MUST match if both present
 * - Other parameters in request object take precedence
 *
 * @param requestObjectClaims - Claims from the request object
 * @param queryParams - Query parameters from the authorization request
 * @returns Array of error messages
 */
export function validateJARParameterConsistency(
  requestObjectClaims: Record<string, unknown>,
  queryParams: Record<string, string | undefined>
): string[] {
  const errors: string[] = [];

  // client_id MUST match if present in both
  if (queryParams.client_id && requestObjectClaims.client_id) {
    if (queryParams.client_id !== requestObjectClaims.client_id) {
      errors.push('client_id mismatch between query parameter and request object');
    }
  }

  // redirect_uri MUST match if present in both (OIDC Core 6.1)
  if (queryParams.redirect_uri && requestObjectClaims.redirect_uri) {
    if (queryParams.redirect_uri !== requestObjectClaims.redirect_uri) {
      errors.push('redirect_uri mismatch between query parameter and request object');
    }
  }

  // response_type MUST match if present in both
  if (queryParams.response_type && requestObjectClaims.response_type) {
    if (queryParams.response_type !== requestObjectClaims.response_type) {
      errors.push('response_type mismatch between query parameter and request object');
    }
  }

  return errors;
}

// =============================================================================
// Presentation Submission Validation Functions
// =============================================================================

/**
 * Re-export types from openid4vp for convenience
 * Note: The canonical definitions are in types/openid4vp.ts
 */
export type { DescriptorMapEntry, PresentationSubmission } from '../types/openid4vp';

/**
 * Presentation Submission validation result
 */
export interface PSValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a Presentation Submission against a Presentation Definition
 *
 * Per DIF Presentation Exchange specification:
 * - id and definition_id must be strings
 * - descriptor_map must have entries for all required Input Descriptors
 * - Each descriptor_map entry must reference a valid Input Descriptor id
 * - path must be valid JSONPath syntax
 * - format must be a recognized credential format
 *
 * @param submission - The Presentation Submission to validate
 * @param definition - The Presentation Definition to validate against
 * @returns PSValidationResult with errors if invalid
 */
export function validatePresentationSubmission(
  submission: unknown,
  definition: PresentationDefinition
): PSValidationResult {
  const errors: string[] = [];

  // Basic type validation
  if (!submission || typeof submission !== 'object') {
    return { valid: false, errors: ['Presentation Submission must be an object'] };
  }

  const sub = submission as Record<string, unknown>;

  // Validate id (required)
  if (!sub.id || typeof sub.id !== 'string') {
    errors.push('Presentation Submission must have a string id');
  } else if (sub.id.length === 0) {
    errors.push('Presentation Submission id cannot be empty');
  } else if (sub.id.length > 256) {
    errors.push('Presentation Submission id is too long (max 256 characters)');
  }

  // Validate definition_id (required, must match PD id)
  if (!sub.definition_id || typeof sub.definition_id !== 'string') {
    errors.push('Presentation Submission must have a string definition_id');
  } else if (sub.definition_id !== definition.id) {
    errors.push(`definition_id mismatch: expected '${definition.id}', got '${sub.definition_id}'`);
  }

  // Validate descriptor_map (required)
  if (!sub.descriptor_map) {
    errors.push('Presentation Submission must have descriptor_map');
  } else if (!Array.isArray(sub.descriptor_map)) {
    errors.push('descriptor_map must be an array');
  } else {
    // Build a set of valid Input Descriptor IDs for reference
    const validDescriptorIds = new Set<string>();
    for (const inputDesc of definition.input_descriptors) {
      validDescriptorIds.add(inputDesc.id);
    }

    // Track which Input Descriptors are satisfied
    const satisfiedDescriptors = new Set<string>();
    // Track seen descriptor map entry IDs for uniqueness
    const seenIds = new Set<string>();

    for (let i = 0; i < sub.descriptor_map.length; i++) {
      const entry = sub.descriptor_map[i];
      const entryErrors = validateDescriptorMapEntry(entry, i, validDescriptorIds, definition);
      errors.push(...entryErrors);

      if (entry && typeof entry === 'object' && 'id' in entry) {
        const id = (entry as { id: unknown }).id;
        if (typeof id === 'string') {
          // Check for duplicates
          if (seenIds.has(id)) {
            errors.push(`Duplicate descriptor_map entry for id: ${id}`);
          } else {
            seenIds.add(id);
            if (validDescriptorIds.has(id)) {
              satisfiedDescriptors.add(id);
            }
          }
        }
      }
    }

    // Check that all required Input Descriptors are satisfied
    // (unless submission_requirements are used)
    if (!definition.submission_requirements) {
      for (const inputDesc of definition.input_descriptors) {
        if (!satisfiedDescriptors.has(inputDesc.id)) {
          errors.push(
            `Missing descriptor_map entry for required Input Descriptor: ${inputDesc.id}`
          );
        }
      }
    } else {
      // Validate against submission_requirements
      const reqErrors = validateAgainstSubmissionRequirements(
        satisfiedDescriptors,
        definition.submission_requirements,
        definition.input_descriptors
      );
      errors.push(...reqErrors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single Descriptor Map Entry
 *
 * @param entry - The entry to validate
 * @param index - Index for error messages
 * @param validDescriptorIds - Set of valid Input Descriptor IDs
 * @param definition - The Presentation Definition
 * @returns Array of error messages
 */
function validateDescriptorMapEntry(
  entry: unknown,
  index: number,
  validDescriptorIds: Set<string>,
  definition: PresentationDefinition
): string[] {
  const errors: string[] = [];
  const prefix = `descriptor_map[${index}]`;

  if (!entry || typeof entry !== 'object') {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  const e = entry as Record<string, unknown>;

  // Validate id (required, must reference a valid Input Descriptor)
  if (!e.id || typeof e.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  } else if (!validDescriptorIds.has(e.id)) {
    errors.push(
      `${prefix}.id '${e.id}' does not match any Input Descriptor id in the Presentation Definition`
    );
  }

  // Validate format (required)
  if (!e.format || typeof e.format !== 'string') {
    errors.push(`${prefix}.format must be a string`);
  } else {
    // Check if format is supported
    const supportedFormats = [
      'dc+sd-jwt', // SD-JWT VC
      'jwt_vp',
      'jwt_vc',
      'jwt_vp_json',
      'jwt_vc_json',
      'ldp_vp',
      'ldp_vc',
      'ac_vp',
      'ac_vc',
      'mso_mdoc',
    ];

    if (!supportedFormats.includes(e.format)) {
      errors.push(`${prefix}.format '${e.format}' is not a recognized credential format`);
    }

    // Validate format against Presentation Definition's format constraints
    if (typeof e.id === 'string') {
      const inputDescriptor = definition.input_descriptors.find((d) => d.id === e.id);
      if (inputDescriptor?.format) {
        // Check if the format is allowed by the Input Descriptor
        const allowedFormats = Object.keys(inputDescriptor.format);
        if (!allowedFormats.includes(e.format)) {
          errors.push(
            `${prefix}.format '${e.format}' is not allowed by Input Descriptor '${e.id}' (allowed: ${allowedFormats.join(', ')})`
          );
        }
      }
    }
  }

  // Validate path (required, must be valid JSONPath)
  if (!e.path || typeof e.path !== 'string') {
    errors.push(`${prefix}.path must be a string`);
  } else if (!e.path.startsWith('$')) {
    errors.push(`${prefix}.path must be a valid JSONPath starting with '$'`);
  }

  // Validate path_nested (optional)
  if (e.path_nested !== undefined) {
    if (typeof e.path_nested !== 'object' || e.path_nested === null) {
      errors.push(`${prefix}.path_nested must be an object`);
    } else {
      // Recursively validate nested entry
      const nestedErrors = validateDescriptorMapEntry(
        e.path_nested,
        index,
        validDescriptorIds,
        definition
      );
      errors.push(...nestedErrors.map((err) => err.replace(prefix, `${prefix}.path_nested`)));
    }
  }

  return errors;
}

/**
 * Validate descriptor_map against submission_requirements
 *
 * @param satisfiedDescriptors - Set of satisfied Input Descriptor IDs
 * @param requirements - Submission Requirements from PD
 * @param inputDescriptors - Input Descriptors from PD
 * @returns Array of error messages
 */
function validateAgainstSubmissionRequirements(
  satisfiedDescriptors: Set<string>,
  requirements: SubmissionRequirement[],
  inputDescriptors: InputDescriptor[]
): string[] {
  const errors: string[] = [];

  // Build a map of group to descriptor IDs
  const groupMap = new Map<string, string[]>();
  for (const desc of inputDescriptors) {
    if (desc.group) {
      for (const group of desc.group) {
        if (!groupMap.has(group)) {
          groupMap.set(group, []);
        }
        groupMap.get(group)!.push(desc.id);
      }
    }
  }

  for (const req of requirements) {
    const reqError = validateSubmissionRequirementSatisfied(req, satisfiedDescriptors, groupMap);
    if (reqError) {
      errors.push(reqError);
    }
  }

  return errors;
}

/**
 * Check if a Submission Requirement is satisfied
 *
 * @param req - The Submission Requirement
 * @param satisfied - Set of satisfied Input Descriptor IDs
 * @param groupMap - Map of group to descriptor IDs
 * @returns Error message if not satisfied, null otherwise
 */
function validateSubmissionRequirementSatisfied(
  req: SubmissionRequirement,
  satisfied: Set<string>,
  groupMap: Map<string, string[]>
): string | null {
  if (req.from) {
    // Get descriptors in this group
    const groupDescriptors = groupMap.get(req.from) || [];
    const satisfiedCount = groupDescriptors.filter((id) => satisfied.has(id)).length;

    if (req.rule === 'all') {
      if (satisfiedCount !== groupDescriptors.length) {
        return `Submission requirement with rule 'all' for group '${req.from}' not satisfied (${satisfiedCount}/${groupDescriptors.length})`;
      }
    } else if (req.rule === 'pick') {
      const count = req.count ?? req.min ?? 1;
      if (satisfiedCount < count) {
        return `Submission requirement with rule 'pick' for group '${req.from}' not satisfied (need ${count}, got ${satisfiedCount})`;
      }
      if (req.max !== undefined && satisfiedCount > req.max) {
        return `Submission requirement with rule 'pick' for group '${req.from}' exceeded max (max ${req.max}, got ${satisfiedCount})`;
      }
    }
  } else if (req.from_nested) {
    // Nested requirements - all nested requirements must be satisfied
    for (const nested of req.from_nested) {
      const nestedError = validateSubmissionRequirementSatisfied(nested, satisfied, groupMap);
      if (nestedError) {
        return nestedError;
      }
    }
  }

  return null;
}
