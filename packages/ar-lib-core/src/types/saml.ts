/**
 * SAML 2.0 Type Definitions
 *
 * Type definitions for SAML 2.0 protocol implementation.
 * Includes types for both IdP (Identity Provider) and SP (Service Provider) roles.
 */

import type { AttributeReleaseConsentPolicy } from '../services/identity-release-consent';

/**
 * SAML Binding types
 */
export type SAMLBinding = 'post' | 'redirect' | 'artifact';

/**
 * SAML NameID Format URIs
 */
export const NameIDFormats = {
  EMAIL: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  PERSISTENT: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  TRANSIENT: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  UNSPECIFIED: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  SHIBBOLETH: 'urn:mace:shibboleth:1.0:nameIdentifier',
  X509_SUBJECT: 'urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName',
  WINDOWS_DQN: 'urn:oasis:names:tc:SAML:1.1:nameid-format:WindowsDomainQualifiedName',
  KERBEROS: 'urn:oasis:names:tc:SAML:2.0:nameid-format:kerberos',
  ENTITY: 'urn:oasis:names:tc:SAML:2.0:nameid-format:entity',
} as const;

export type NameIDFormat = (typeof NameIDFormats)[keyof typeof NameIDFormats];

/**
 * SAML Protocol Binding URIs
 */
export const SAMLBindingURIs = {
  HTTP_POST: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  HTTP_REDIRECT: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  HTTP_ARTIFACT: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact',
  SOAP: 'urn:oasis:names:tc:SAML:2.0:bindings:SOAP',
} as const;

export type SAMLBindingURI = (typeof SAMLBindingURIs)[keyof typeof SAMLBindingURIs];

/**
 * SAML Status Codes
 */
export const SAMLStatusCodes = {
  SUCCESS: 'urn:oasis:names:tc:SAML:2.0:status:Success',
  REQUESTER: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
  RESPONDER: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
  VERSION_MISMATCH: 'urn:oasis:names:tc:SAML:2.0:status:VersionMismatch',
  AUTHN_FAILED: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed',
  INVALID_ATTR_NAMEID_POLICY: 'urn:oasis:names:tc:SAML:2.0:status:InvalidAttrNameOrValue',
  INVALID_NAMEID_POLICY: 'urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy',
  NO_AUTHN_CONTEXT: 'urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext',
  NO_AVAILABLE_IDP: 'urn:oasis:names:tc:SAML:2.0:status:NoAvailableIDP',
  NO_PASSIVE: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
  NO_SUPPORTED_IDP: 'urn:oasis:names:tc:SAML:2.0:status:NoSupportedIDP',
  PARTIAL_LOGOUT: 'urn:oasis:names:tc:SAML:2.0:status:PartialLogout',
  PROXY_COUNT_EXCEEDED: 'urn:oasis:names:tc:SAML:2.0:status:ProxyCountExceeded',
  REQUEST_DENIED: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
  REQUEST_UNSUPPORTED: 'urn:oasis:names:tc:SAML:2.0:status:RequestUnsupported',
  REQUEST_VERSION_DEPRECATED: 'urn:oasis:names:tc:SAML:2.0:status:RequestVersionDeprecated',
  REQUEST_VERSION_TOO_HIGH: 'urn:oasis:names:tc:SAML:2.0:status:RequestVersionTooHigh',
  REQUEST_VERSION_TOO_LOW: 'urn:oasis:names:tc:SAML:2.0:status:RequestVersionTooLow',
  RESOURCE_NOT_RECOGNIZED: 'urn:oasis:names:tc:SAML:2.0:status:ResourceNotRecognized',
  TOO_MANY_RESPONSES: 'urn:oasis:names:tc:SAML:2.0:status:TooManyResponses',
  UNKNOWN_ATTR_PROFILE: 'urn:oasis:names:tc:SAML:2.0:status:UnknownAttrProfile',
  UNKNOWN_PRINCIPAL: 'urn:oasis:names:tc:SAML:2.0:status:UnknownPrincipal',
  UNSUPPORTED_BINDING: 'urn:oasis:names:tc:SAML:2.0:status:UnsupportedBinding',
} as const;

export type SAMLStatusCode = (typeof SAMLStatusCodes)[keyof typeof SAMLStatusCodes];

/**
 * SAML AuthnContext Class URIs
 */
export const AuthnContextClassRefs = {
  PASSWORD: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
  PASSWORD_PROTECTED_TRANSPORT: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  TLS_CLIENT: 'urn:oasis:names:tc:SAML:2.0:ac:classes:TLSClient',
  X509: 'urn:oasis:names:tc:SAML:2.0:ac:classes:X509',
  UNSPECIFIED: 'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified',
} as const;

export type AuthnContextClassRef =
  (typeof AuthnContextClassRefs)[keyof typeof AuthnContextClassRefs];

// ============================================================================
// SAML Request/Response Data Structures
// ============================================================================

/**
 * Parsed SAML AuthnRequest data
 */
export interface SAMLAuthnRequest {
  id: string;
  issueInstant: string;
  destination?: string;
  assertionConsumerServiceURL?: string;
  assertionConsumerServiceIndex?: number;
  protocolBinding?: SAMLBindingURI;
  issuer: string;
  nameIdPolicy?: {
    format?: NameIDFormat;
    allowCreate?: boolean;
    spNameQualifier?: string;
  };
  requestedAuthnContext?: {
    comparison?: 'exact' | 'minimum' | 'maximum' | 'better';
    authnContextClassRef?: string[];
  };
  forceAuthn?: boolean;
  isPassive?: boolean;
  relayState?: string;
}

/**
 * SAML Assertion data
 */
export interface SAMLAssertion {
  id: string;
  issueInstant: string;
  issuer: string;
  subject: {
    nameId: string;
    nameIdFormat: NameIDFormat;
    subjectConfirmation?: {
      method: string;
      notOnOrAfter?: string;
      recipient?: string;
      inResponseTo?: string;
    };
  };
  conditions?: {
    notBefore?: string;
    notOnOrAfter?: string;
    audienceRestriction?: string[];
    oneTimeUse?: boolean; // SAML 2.0 Core 2.5.1.5 - Replay attack prevention
    proxyRestriction?: number; // SAML 2.0 Core 2.5.1.6 - Proxy count limit
  };
  authnStatement?: {
    authnInstant: string;
    sessionIndex?: string;
    sessionNotOnOrAfter?: string;
    authnContext: {
      authnContextClassRef: string;
    };
  };
  attributeStatement?: SAMLAttribute[];
}

/**
 * SAML Attribute
 */
export interface SAMLAttribute {
  name: string;
  nameFormat?: string;
  friendlyName?: string;
  /** XML Schema type for AttributeValue. Defaults to xs:string. */
  valueType?: SAMLAttributeValueType;
  values: string[];
}

export type SAMLAttributeValueType =
  | 'xs:string'
  | 'xs:boolean'
  | 'xs:integer'
  | 'xs:dateTime'
  | 'xs:anyURI';

/**
 * SAML attribute release policy.
 *
 * This is the production-oriented replacement path for the legacy
 * SAMLSPConfig.attributeMapping map. The legacy map remains supported for
 * backward compatibility.
 */
export interface SAMLAttributeReleasePolicy {
  attributes: SAMLAttributeReleaseRule[];
}

export interface SAMLAttributeReleaseRule {
  /** SAML Attribute Name */
  name: string;
  /** SAML Attribute NameFormat */
  nameFormat?: string;
  /** SAML Attribute FriendlyName */
  friendlyName?: string;
  /** XML Schema type for AttributeValue. Defaults to xs:string. */
  valueType?: SAMLAttributeValueType;
  /** Where the value should be read from */
  source: SAMLAttributeReleaseSource;
  /** Claim or field key for claim/custom sources */
  claim?: string;
  /** Constant value for source=constant */
  value?: string | string[];
  /** Computed attribute resolver name for source=computed */
  computed?: SAMLComputedAttribute;
  /** Whether a missing value should be treated as policy failure */
  required?: boolean;
}

export type SAMLAttributeReleaseSource =
  | 'claim'
  | 'attribute'
  | 'custom_claim'
  | 'custom_field'
  | 'constant'
  | 'computed';

export type SAMLComputedAttribute = 'eduPersonScopedAffiliation';

export interface SAMLMetadataRequestedAttribute {
  /** SAML Attribute Name requested by SP metadata */
  name: string;
  /** SAML Attribute NameFormat requested by SP metadata */
  nameFormat?: string;
  /** SAML Attribute FriendlyName requested by SP metadata */
  friendlyName?: string;
  /** Whether the SP metadata marks this attribute as required */
  isRequired?: boolean;
  /** AttributeConsumingService index containing this request */
  attributeConsumingServiceIndex?: number;
  /** AttributeConsumingService ServiceName text when present */
  attributeConsumingServiceName?: string;
}

export interface SAMLMetadataEndpointSnapshot {
  type: 'sso' | 'slo' | 'acs';
  binding: string;
  location: string;
  responseLocation?: string;
  index?: number;
}

export interface SAMLMetadataCriticalFields {
  entityId: string;
  validUntil?: string;
  certificates: string[];
  endpoints: SAMLMetadataEndpointSnapshot[];
}

export interface SAMLMetadataDiffSummary {
  changed: boolean;
  previousHash?: string;
  currentHash: string;
  entityIdChanged: boolean;
  validUntilChanged: boolean;
  certificatesAdded: string[];
  certificatesRemoved: string[];
  endpointsAdded: SAMLMetadataEndpointSnapshot[];
  endpointsRemoved: SAMLMetadataEndpointSnapshot[];
  validUntil?: string;
  expiresInSeconds?: number;
  expired: boolean;
}

export interface SAMLMetadataRefreshStatus {
  lastCheckedAt: number;
  lastChangedAt?: number;
  previousHash?: string;
  currentHash: string;
  previous?: SAMLMetadataCriticalFields;
  current: SAMLMetadataCriticalFields;
  diff: SAMLMetadataDiffSummary;
}

export type SAMLMetadataVerificationPolicy = 'strict' | 'warn' | 'disabled';
export type SAMLMetadataVerificationStatus = 'verified' | 'unverified' | 'skipped' | 'failed';

export interface SAMLFederationTrustCertificate {
  id: string;
  name?: string;
  certificate: string;
  fingerprintSha256: string;
  createdAt: number;
}

export interface SAMLFederationTrustProfile {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  metadataUrlPatterns: string[];
  certificates: SAMLFederationTrustCertificate[];
  policy?: SAMLMetadataVerificationPolicy;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SAMLMetadataVerificationSummary {
  status: SAMLMetadataVerificationStatus;
  policy: SAMLMetadataVerificationPolicy;
  trustProfileId?: string;
  trustProfileName?: string;
  certificateFingerprintSha256?: string;
  signedElementId?: string;
  verifiedAt?: number;
  warnings?: string[];
  error?: string;
}

export interface SAMLMetadataAggregateImportSnapshot {
  aggregateSourceUrl?: string;
  aggregateEntityId: string;
  federationTrustProfileId?: string;
  verification: SAMLMetadataVerificationSummary;
  importedAt: number;
}

export interface SAMLErrorResponseOverride {
  /** SAML policy failure kind, for example required_attribute_missing */
  failureKind: string;
  /** Override top-level SAML StatusCode URI */
  statusCode?: string;
  /** Override second-level SAML StatusCode URI. Use null to suppress it. */
  secondLevelStatusCode?: string | null;
  /** Override user-facing StatusMessage */
  statusMessage?: string;
}

export type SAMLAuthnRequestSignaturePolicy = 'required' | 'optional' | 'disabled';
export type SAMLAuthnRequestLegacyAlgorithmPolicy = 'disabled' | 'explicit_opt_in';
export type SAMLJitEmailLinkingPolicy = 'email_linking' | 'jit_create_only' | 'disabled';
export type SAMLAuthnContextClassRefMode = 'legacy_static' | 'session';
export type SAMLAttributeReleaseFailureUserMessageMode = 'generic' | 'detailed';
export type SAMLLogoutResponseBinding = 'auto' | 'post' | 'redirect';
export type SAMLSPProfile = 'baseline' | 'strict' | 'academic_publisher' | 'legacy';
export type SAMLAttributePresetId =
  | 'basic.v1'
  | 'academic_publisher.v1'
  | 'enterprise_saas.v1'
  | 'research_federation.v1'
  | `custom:${string}`;
export type SAMLSigningRole = 'idp' | 'sp';
export type SAMLSigningKeyScope = 'tenant_role' | 'provider';
export type SAMLSigningCertificateSlot = 'active' | 'next' | 'backup';
export type SAMLMetadataCertificatePublication =
  | 'active_only'
  | 'active_next'
  | 'active_next_backup';
export type SAMLAssertionEncryptionAlgorithm = 'aes256-gcm' | 'aes256-cbc';
export type SAMLKeyEncryptionAlgorithm = 'rsa-oaep-256' | 'rsa-oaep-sha1';
export type SAMLEncryptionAlgorithmPolicy = 'modern' | 'legacy_opt_in';
export type SAMLSigningRolloverState =
  | 'draft'
  | 'published_next'
  | 'active'
  | 'overlap'
  | 'retired';

export interface SAMLSigningKeyReference {
  /** Slot in the SAML certificate lifecycle */
  slot: SAMLSigningCertificateSlot;
  /** Stable row identifier for multiple certificates in the same lifecycle slot */
  id?: string;
  /** KeyManager Durable Object reference name */
  keyRef?: string;
  /** Optional KeyManager key id, for audit/display and future lookup */
  kid?: string;
  /** Public certificate to publish in metadata */
  certificate?: string;
  /** Rollover state for this slot */
  state?: SAMLSigningRolloverState;
  /** When this certificate should start appearing in metadata */
  metadataPublishFrom?: number;
  /** Planned manual or automated activation time */
  plannedActivationAt?: number;
  /** Certificate validity start time */
  validFrom?: number;
  /** Certificate validity end time */
  validTo?: number;
  /** Public key algorithm used for this certificate */
  publicKeyAlgorithm?: 'RSA';
  /** Public key size in bits */
  publicKeySizeBits?: number;
}

export interface SAMLSigningKeyPolicy {
  /** Default is tenant_role; provider enables per-counterparty dedicated keys */
  scope?: SAMLSigningKeyScope;
  /** Metadata publication behavior for active/next/backup certificates */
  metadataCertificatePublication?: SAMLMetadataCertificatePublication;
  /** Current signing key slot */
  active?: SAMLSigningKeyReference;
  /** Next signing certificate, normally published before activation */
  next?: SAMLSigningKeyReference;
  /** Additional switchable signing certificates published before activation */
  nextCandidates?: SAMLSigningKeyReference[];
  /** Backup/DR certificate reference. Private key export is handled by DR bundle policy. */
  backup?: SAMLSigningKeyReference;
}

export interface SAMLCertificateValidationStatus {
  validFrom?: string;
  validTo?: string;
  expired: boolean;
  notYetValid: boolean;
  signatureAlgorithm?: string;
  publicKeyAlgorithm?: string;
  publicKeySizeBits?: number;
  fingerprintSha1?: string;
  fingerprintSha256?: string;
  warnings: string[];
}

export interface SAMLCertificateValidationSummary {
  checkedAt: number;
  certificates: SAMLCertificateValidationStatus[];
  validUntil?: string;
  allExpired: boolean;
  hasExpired: boolean;
  hasWeakSignature: boolean;
  warnings: string[];
}

/**
 * SAML Response data
 */
export interface SAMLResponse {
  id: string;
  issueInstant: string;
  destination?: string;
  inResponseTo?: string;
  issuer: string;
  status: {
    statusCode: SAMLStatusCode;
    statusMessage?: string;
    statusDetail?: string;
  };
  assertion?: SAMLAssertion;
}

/**
 * SAML LogoutRequest data
 */
export interface SAMLLogoutRequest {
  id: string;
  issueInstant: string;
  destination?: string;
  issuer: string;
  nameId: string;
  nameIdFormat: NameIDFormat;
  sessionIndex?: string;
  reason?: string;
  notOnOrAfter?: string;
  relayState?: string;
}

/**
 * SAML LogoutResponse data
 */
export interface SAMLLogoutResponse {
  id: string;
  issueInstant: string;
  destination?: string;
  inResponseTo?: string;
  issuer: string;
  status: {
    statusCode: SAMLStatusCode;
    statusMessage?: string;
  };
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * SAML SP Configuration (stored in identity_providers table)
 * Used when Authrim acts as IdP
 */
export interface SAMLSPConfig {
  /** Operator note shown in Admin UI */
  description?: string;
  /** Logo URL shown on Login UI provider buttons */
  logoUrl?: string;
  /** Built-in Login UI icon name used when logoUrl is not configured */
  iconName?: string;
  /** SP Entity ID */
  entityId: string;
  /** Assertion Consumer Service URL */
  acsUrl: string;
  /** Additional allowed Assertion Consumer Service URLs from metadata */
  acsUrls?: string[];
  /** Indexed Assertion Consumer Services from SP metadata */
  acsServices?: SAMLAssertionConsumerService[];
  /** Single Logout URL */
  sloUrl?: string;
  /** Single Logout response URL, from metadata ResponseLocation when present */
  sloResponseUrl?: string;
  /** Binding associated with the selected Single Logout URL */
  sloBinding?: Extract<SAMLBinding, 'post' | 'redirect'>;
  /** SP certificate for signature verification (PEM format) */
  certificate?: string;
  /** SP signing certificates for rollover-aware signature verification (PEM format) */
  certificates?: string[];
  /** Parsed certificate expiry/security summary for Admin UI and safe defaults */
  certificateValidation?: SAMLCertificateValidationSummary;
  /** SP certificate used for XML Encryption when Authrim encrypts assertions (PEM format) */
  encryptionCertificate?: string;
  /** SP encryption certificates imported from metadata (PEM format) */
  encryptionCertificates?: string[];
  /** Encrypt full SAML Assertion before sending the Response */
  encryptAssertions?: boolean;
  /** Encrypt only Subject NameID when full Assertion encryption is disabled */
  encryptNameID?: boolean;
  /** Legacy XML Encryption algorithms are disabled unless explicitly opted in. */
  encryptionAlgorithmPolicy?: SAMLEncryptionAlgorithmPolicy;
  /** XML Encryption content algorithm. Default: aes256-gcm. */
  assertionEncryptionAlgorithm?: SAMLAssertionEncryptionAlgorithm;
  /** XML Encryption key transport algorithm. Default: rsa-oaep-256. */
  keyEncryptionAlgorithm?: SAMLKeyEncryptionAlgorithm;
  /** AuthnRequest signature verification policy */
  authnRequestSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  /** AuthnContext emission policy. Default legacy_static preserves older SP behavior. */
  authnContextClassRefMode?: SAMLAuthnContextClassRefMode;
  /** AuthnContext emitted for legacy/static mode. */
  defaultAuthnContextClassRef?: string;
  /** AuthnContext emitted for passkey sessions when session-aware mode is enabled. */
  passkeyAuthnContextClassRef?: string;
  /** LogoutRequest signature verification policy */
  logoutRequestSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  /** LogoutResponse signature verification policy */
  logoutResponseSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  /** Binding to use when sending IdP LogoutResponse. Default auto mirrors the inbound binding. */
  logoutResponseBinding?: SAMLLogoutResponseBinding;
  /** Accepted AuthnRequest XML/Redirect signature algorithm URIs */
  acceptedAuthnRequestSignatureAlgorithms?: string[];
  /** Accepted AuthnRequest XML digest algorithm URIs */
  acceptedAuthnRequestDigestAlgorithms?: string[];
  /** Legacy algorithm escape hatch. SHA-1 remains disabled unless explicitly allowed here and in accepted algorithm lists. */
  authnRequestLegacyAlgorithmPolicy?: SAMLAuthnRequestLegacyAlgorithmPolicy;
  /** Authrim signing key policy when acting as IdP for this SP */
  signingKeyPolicy?: SAMLSigningKeyPolicy;
  /** Operational profile used to derive defaults when registering/importing this SP */
  samlProfile?: SAMLSPProfile;
  /** NameID format preference */
  nameIdFormat: NameIDFormat;
  /** OIDC claim to SAML attribute mapping */
  attributeMapping: Record<string, string>;
  /** Policy-based SAML attribute release rules */
  attributeReleasePolicy?: SAMLAttributeReleasePolicy;
  /** User-facing attribute release consent policy. Protocol-neutral shape for OIDC reuse. */
  attributeReleaseConsent?: AttributeReleaseConsentPolicy;
  /** Runtime identity mapping policy selector for SAML attribute release */
  identityMapping?: SAMLIdentityMappingPolicySelector;
  /** Built-in attribute preset used as the clone/edit source for the current release policy */
  attributePresetId?: SAMLAttributePresetId;
  /** Built-in attribute preset version used as the clone/edit source for the current release policy */
  attributePresetVersion?: string;
  /** Raw RequestedAttribute hints imported from SP metadata */
  metadataRequestedAttributes?: SAMLMetadataRequestedAttribute[];
  /** Candidate release policy inferred from SP metadata RequestedAttribute hints */
  metadataAttributeReleasePolicySuggestion?: SAMLAttributeReleasePolicy;
  /** User-facing StatusMessage detail for required attribute release failures */
  attributeReleaseFailureUserMessageMode?: SAMLAttributeReleaseFailureUserMessageMode;
  /** Per-SP SAML error response status/message overrides */
  errorResponseOverrides?: SAMLErrorResponseOverride[];
  /** Sign SAML Assertions */
  signAssertions: boolean;
  /** Sign SAML Responses */
  signResponses: boolean;
  /** Allowed bindings */
  allowedBindings: SAMLBinding[];
  /** Assertion validity duration in seconds (default: 300 = 5 minutes) */
  assertionValiditySeconds?: number;
  /** SP metadata XML (cached) */
  metadataXml?: string;
  /** SP metadata source URL */
  metadataUrl?: string;
  /** Last imported/refreshed metadata hash */
  metadataHash?: string;
  /** Last imported/refreshed critical metadata fields */
  metadataCriticalFields?: SAMLMetadataCriticalFields;
  /** Last manual/job metadata refresh status */
  metadataRefreshStatus?: SAMLMetadataRefreshStatus;
  /** Metadata last fetched timestamp */
  metadataLastFetched?: number;
  /** Aggregate metadata import/verification snapshot when imported from federation metadata */
  aggregateImport?: SAMLMetadataAggregateImportSnapshot;
}

export interface SAMLIdentityMappingAttributeDescriptor {
  name?: string;
  nameFormat?: string;
  friendlyName?: string;
  valueType?: 'string' | 'base64Binary' | 'anyType';
  required?: boolean;
}

export interface SAMLIdentityMappingPolicySelector {
  /** Active mapping policy set selected for this SP override. Empty falls back to tenant activation scope. */
  policySetId?: string;
  /** Optional pinned policy version. Runtime still requires an active activation for the version. */
  policyVersionId?: string;
  destinationNamespace?: string;
  sourceProfileId?: string;
  destinationProfileId?: string;
  attributeDescriptors?: Record<string, SAMLIdentityMappingAttributeDescriptor>;
}

export interface SAMLAssertionConsumerService {
  index: number;
  binding: SAMLBinding;
  location: string;
  isDefault?: boolean;
}

/**
 * SAML IdP Configuration (stored in identity_providers table)
 * Used when Authrim acts as SP
 */
export interface SAMLIdPConfig {
  /** Operator note shown in Admin UI */
  description?: string;
  /** SP display name sent as AuthnRequest ProviderName when Authrim acts as SP */
  providerName?: string;
  /** Logo URL from IdP metadata UIInfo, shown on Login UI provider buttons */
  logoUrl?: string;
  /** Built-in Login UI icon name used when logoUrl is not configured */
  iconName?: string;
  /** IdP Entity ID */
  entityId: string;
  /** SSO URL */
  ssoUrl: string;
  /** Single Logout URL */
  sloUrl?: string;
  /** IdP certificate for signature verification (PEM format) */
  certificate: string;
  /** IdP signing certificates for rollover-aware validation when imported from metadata */
  certificates?: string[];
  /** Parsed certificate expiry/security summary for Admin UI and safe defaults */
  certificateValidation?: SAMLCertificateValidationSummary;
  /** Inbound IdP LogoutRequest signature verification policy when Authrim acts as SP */
  logoutRequestSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  /** Accepted inbound IdP LogoutRequest XML/Redirect signature algorithm URIs */
  acceptedLogoutRequestSignatureAlgorithms?: string[];
  /** Accepted inbound IdP LogoutRequest XML digest algorithm URIs */
  acceptedLogoutRequestDigestAlgorithms?: string[];
  /** Legacy algorithm escape hatch for inbound IdP LogoutRequest validation */
  logoutRequestLegacyAlgorithmPolicy?: SAMLAuthnRequestLegacyAlgorithmPolicy;
  /** NameID format */
  nameIdFormat: NameIDFormat;
  /** Authrim signing key policy when acting as SP for this IdP */
  signingKeyPolicy?: SAMLSigningKeyPolicy;
  /** AuthnContext policy for assertions returned by this IdP */
  authnContextPolicy?: {
    mode: 'observe' | 'require_any';
    allowedClassRefs?: string[];
  };
  /**
   * Federated identity registry policy for resolving first SAML logins.
   * Default email_linking resolves existing link, verified local email, then JIT create.
   */
  jitEmailLinkingPolicy?: SAMLJitEmailLinkingPolicy;
  /**
   * Legacy compatibility escape hatch. When false/omitted, ACS rejects assertions that
   * cannot produce an email. When true, ACS uses a non-PII synthetic local email.
   */
  allowSyntheticEmailFallback?: boolean;
  /**
   * SAML attribute to Authrim claim mapping.
   * Standard targets are OIDC-style claims such as email or name.
   * For JIT provisioning, targets may also use:
   * - custom_claims.<field_key>
   * - custom_fields.<field_key>
   */
  attributeMapping: Record<string, string>;
  /** Allowed bindings */
  allowedBindings: SAMLBinding[];
  /** IdP metadata XML (cached) */
  metadataXml?: string;
  /** IdP metadata source URL */
  metadataUrl?: string;
  /** Last imported/refreshed metadata hash */
  metadataHash?: string;
  /** Last imported/refreshed critical metadata fields */
  metadataCriticalFields?: SAMLMetadataCriticalFields;
  /** Last manual/job metadata refresh status */
  metadataRefreshStatus?: SAMLMetadataRefreshStatus;
  /** Metadata last fetched timestamp */
  metadataLastFetched?: number;
  /** Aggregate metadata import/verification snapshot when imported from federation metadata */
  aggregateImport?: SAMLMetadataAggregateImportSnapshot;
}

// ============================================================================
// Durable Object Types
// ============================================================================

/**
 * SAML Request data stored in SAMLRequestStore DO
 */
export interface SAMLRequestData {
  /** SAML Request ID (_xxx format) */
  requestId: string;
  /** RelayState value */
  relayState?: string;
  /** Issuer Entity ID (SP or IdP) */
  issuer: string;
  /** Destination URL */
  destination: string;
  /** Assertion Consumer Service URL (for AuthnRequest) */
  acsUrl?: string;
  /** Binding type */
  binding: SAMLBinding;
  /** Whether this request has been consumed */
  used: boolean;
  /** Expiration timestamp (default: 5 minutes) */
  expiresAt: number;
  /** Creation timestamp */
  createdAt: number;
  /** Request type */
  type: 'authn_request' | 'logout_request' | 'artifact';
  /** Additional data (e.g., parsed AuthnRequest) */
  data?: SAMLAuthnRequest | SAMLLogoutRequest;
  /** Server-side continuation context for interactive protocol gates. */
  context?: SAMLRequestContext;
}

export interface SAMLRequestContext {
  attributeReleaseConsentChallenge?: {
    challengeId: string;
    subjectId: string;
    destinationType: 'saml_sp' | string;
    destinationId: string;
    attributeSetHash: string;
    consentMode: AttributeReleaseConsentPolicy['mode'];
    createdAt: number;
  };
  attributeReleaseConsentConfirmed?: {
    subjectId: string;
    destinationType: 'saml_sp' | string;
    destinationId: string;
    attributeSetHash: string;
    confirmedAt: number;
  };
}

/**
 * SAML Artifact data (for Artifact Binding)
 */
export interface SAMLArtifactData {
  /** Artifact value */
  artifact: string;
  /** Associated SAML Response XML */
  responseXml: string;
  /** Issuer Entity ID */
  issuer: string;
  /** Whether consumed */
  used: boolean;
  /** Expiration timestamp */
  expiresAt: number;
  /** Creation timestamp */
  createdAt: number;
}

// ============================================================================
// Metadata Types
// ============================================================================

/**
 * IdP Metadata structure
 */
export interface IdPMetadata {
  entityId: string;
  ssoServices: Array<{
    binding: SAMLBindingURI;
    location: string;
  }>;
  sloServices?: Array<{
    binding: SAMLBindingURI;
    location: string;
  }>;
  nameIdFormats: NameIDFormat[];
  signingCertificates: string[];
  encryptionCertificates?: string[];
  organization?: {
    name: string;
    displayName: string;
    url: string;
  };
  contactPerson?: {
    type: 'technical' | 'support' | 'administrative' | 'billing' | 'other';
    company?: string;
    givenName?: string;
    surName?: string;
    emailAddress?: string;
    telephoneNumber?: string;
  };
}

/**
 * SP Metadata structure
 */
export interface SPMetadata {
  entityId: string;
  acsServices: Array<{
    binding: SAMLBindingURI;
    location: string;
    index: number;
    isDefault?: boolean;
  }>;
  sloServices?: Array<{
    binding: SAMLBindingURI;
    location: string;
  }>;
  nameIdFormats: NameIDFormat[];
  signingCertificates?: string[];
  encryptionCertificates?: string[];
  authnRequestsSigned?: boolean;
  wantAssertionsSigned?: boolean;
  organization?: {
    name: string;
    displayName: string;
    url: string;
  };
}

// ============================================================================
// API Types
// ============================================================================

/**
 * SAML Provider registration request
 */
export interface SAMLProviderCreateRequest {
  /** Provider name for display */
  name: string;
  /** Provider type */
  providerType: 'saml_idp' | 'saml_sp';
  /** Configuration. Required unless metadataXml or metadataUrl is supplied. */
  config?: SAMLIdPConfig | SAMLSPConfig;
  /** Metadata XML string for metadata-first registration */
  metadataXml?: string;
  /** Metadata URL to fetch for metadata-first registration */
  metadataUrl?: string;
  /** Optional Authrim profile defaults to apply for SP metadata */
  samlProfile?: SAMLSPProfile;
  /** Optional built-in attribute preset to clone into the SP release policy */
  attributePresetId?: SAMLAttributePresetId;
  /** Enable/disable */
  enabled?: boolean;
}

/**
 * SAML Provider update request
 */
export interface SAMLProviderUpdateRequest {
  /** Provider name for display */
  name?: string;
  /** Configuration */
  config?: Partial<SAMLIdPConfig | SAMLSPConfig>;
  /** Enable/disable */
  enabled?: boolean;
}

/**
 * SAML Provider response
 */
export interface SAMLProviderResponse {
  id: string;
  name: string;
  providerType: 'saml_idp' | 'saml_sp';
  config: SAMLIdPConfig | SAMLSPConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Metadata import request
 */
export interface MetadataImportRequest {
  /** Metadata XML string */
  metadataXml?: string;
  /** Metadata URL to fetch */
  metadataUrl?: string;
  /** Optional Authrim profile defaults to apply after metadata import */
  samlProfile?: SAMLSPProfile;
  /** Optional built-in attribute preset to clone into the SP release policy */
  attributePresetId?: SAMLAttributePresetId;
}

export type SAMLMetadataPreviewKind = 'single' | 'aggregate';
export type SAMLMetadataEntityRole = 'saml_idp' | 'saml_sp' | 'ambiguous' | 'unknown';

export interface SAMLMetadataEntitySummary {
  entityId: string;
  role: SAMLMetadataEntityRole;
  displayName?: string;
  acsUrl?: string;
  ssoUrl?: string;
  sloUrl?: string;
  certificateCount: number;
  validUntil?: string;
  keywords?: string[];
  logoUrl?: string;
}

export interface SAMLMetadataKeywordFacetValue {
  keyword: string;
  label: string;
  count: number;
}

export interface SAMLMetadataKeywordFacet {
  category: string;
  label: string;
  values: SAMLMetadataKeywordFacetValue[];
}

export interface SAMLMetadataAggregatePreviewResponse {
  kind: 'aggregate';
  previewId: string;
  metadataUrl?: string;
  entityCount: number;
  expiresAt: number;
  verification: SAMLMetadataVerificationSummary;
}

export interface SAMLMetadataSinglePreviewResponse {
  kind: 'single';
  providerType: 'saml_idp' | 'saml_sp';
  config: SAMLIdPConfig | SAMLSPConfig;
}

export interface SAMLMetadataEntityListResponse {
  previewId: string;
  total: number;
  offset: number;
  limit: number;
  entities: SAMLMetadataEntitySummary[];
  keywordFacets?: SAMLMetadataKeywordFacet[];
}

export interface SAMLMetadataBatchCreateResult {
  entityId: string;
  success: boolean;
  providerId?: string;
  providerType?: 'saml_idp' | 'saml_sp';
  name?: string;
  error?: string;
}

export interface SAMLMetadataBatchStatusResponse {
  batchId: string;
  tenantId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: number;
  completedAt?: number;
  results: SAMLMetadataBatchCreateResult[];
  error?: string;
}
