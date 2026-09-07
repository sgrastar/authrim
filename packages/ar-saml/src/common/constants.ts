/**
 * SAML 2.0 Constants
 */

/**
 * XML Namespaces used in SAML 2.0
 */
export const SAML_NAMESPACES = {
  SAML2P: 'urn:oasis:names:tc:SAML:2.0:protocol',
  SAML2: 'urn:oasis:names:tc:SAML:2.0:assertion',
  MD: 'urn:oasis:names:tc:SAML:2.0:metadata',
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XENC: 'http://www.w3.org/2001/04/xmlenc#',
  XENC11: 'http://www.w3.org/2009/xmlenc11#',
  XML: 'http://www.w3.org/XML/1998/namespace',
  XS: 'http://www.w3.org/2001/XMLSchema',
  XSI: 'http://www.w3.org/2001/XMLSchema-instance',
  XS_INSTANCE: 'http://www.w3.org/2001/XMLSchema-instance',
} as const;

/**
 * SAML 2.0 Binding URIs
 */
export const BINDING_URIS = {
  HTTP_POST: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  HTTP_REDIRECT: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  HTTP_ARTIFACT: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact',
  SOAP: 'urn:oasis:names:tc:SAML:2.0:bindings:SOAP',
} as const;

/**
 * SAML 2.0 NameID Format URIs
 */
export const NAMEID_FORMATS = {
  EMAIL: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  PERSISTENT: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  TRANSIENT: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  UNSPECIFIED: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  SHIBBOLETH: 'urn:mace:shibboleth:1.0:nameIdentifier',
} as const;

/**
 * SAML 2.0 Status Codes
 */
export const STATUS_CODES = {
  SUCCESS: 'urn:oasis:names:tc:SAML:2.0:status:Success',
  REQUESTER: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
  RESPONDER: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
  VERSION_MISMATCH: 'urn:oasis:names:tc:SAML:2.0:status:VersionMismatch',
  AUTHN_FAILED: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed',
  INVALID_ATTR_NAME_OR_VALUE: 'urn:oasis:names:tc:SAML:2.0:status:InvalidAttrNameOrValue',
  INVALID_NAMEID_POLICY: 'urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy',
  NO_AUTHN_CONTEXT: 'urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext',
  NO_PASSIVE: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
  REQUEST_DENIED: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
  UNSUPPORTED_BINDING: 'urn:oasis:names:tc:SAML:2.0:status:UnsupportedBinding',
  UNKNOWN_PRINCIPAL: 'urn:oasis:names:tc:SAML:2.0:status:UnknownPrincipal',
} as const;

/**
 * AuthnContext Class References
 */
export const AUTHN_CONTEXT = {
  PASSWORD: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
  PASSWORD_PROTECTED_TRANSPORT: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  UNSPECIFIED: 'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified',
  AUTHRIM_PHISHING_RESISTANT: 'urn:authrim:acr:phishing-resistant',
} as const;

/**
 * Subject Confirmation Methods
 */
export const SUBJECT_CONFIRMATION_METHODS = {
  BEARER: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
} as const;

/**
 * Signature Algorithms
 */
export const SIGNATURE_ALGORITHMS = {
  RSA_SHA256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  RSA_SHA1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', // Deprecated
} as const;

/**
 * Digest Algorithms
 */
export const DIGEST_ALGORITHMS = {
  SHA256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  SHA1: 'http://www.w3.org/2000/09/xmldsig#sha1', // Deprecated
} as const;

/**
 * XML Encryption Algorithms
 */
export const XML_ENCRYPTION_ALGORITHMS = {
  AES256_GCM: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
  AES256_CBC: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
  RSA_OAEP: 'http://www.w3.org/2009/xmlenc11#rsa-oaep',
  RSA_OAEP_MGF1P: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
  MGF1_SHA256: 'http://www.w3.org/2009/xmlenc11#mgf1sha256',
} as const;

/**
 * Canonicalization Algorithms
 */
export const CANONICALIZATION_ALGORITHMS = {
  EXCLUSIVE_C14N: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  EXCLUSIVE_C14N_WITH_COMMENTS: 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
} as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  /** Assertion validity in seconds */
  ASSERTION_VALIDITY_SECONDS: 300, // 5 minutes
  /** Request validity in seconds */
  REQUEST_VALIDITY_SECONDS: 300, // 5 minutes
  /** Session validity in seconds */
  SESSION_VALIDITY_SECONDS: 3600, // 1 hour
  /** Clock skew tolerance in seconds */
  CLOCK_SKEW_SECONDS: 60, // 1 minute
  /**
   * Strict InResponseTo validation mode
   * When enabled, InResponseTo MUST match a stored AuthnRequest ID
   * This prevents unsolicited assertion injection. Deployments that intentionally support
   * IdP-initiated SSO must explicitly disable this setting.
   */
  STRICT_INRESPONSETO: true,
} as const;
