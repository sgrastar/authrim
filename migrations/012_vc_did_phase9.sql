-- ============================================================================
-- Phase 9: VC/DID Support Migration
-- ============================================================================
-- Adds tables for OpenID4VP, OpenID4VCI, and DID support
--
-- Design Principles:
-- 1. Data Minimization: raw VCs are NOT stored, only verification results
-- 2. PII Protection: disclosed claims are normalized to user_verified_attributes
-- 3. HAIP Compliance: supports dc+sd-jwt and mso_mdoc formats
--
-- @see /docs/plans/virtual-beaming-hamming.md
-- ============================================================================

-- ============================================================================
-- Trusted Issuers Registry
-- ============================================================================
-- Stores trusted VC issuers per tenant
-- Only VCs from trusted issuers will be accepted

CREATE TABLE IF NOT EXISTS trusted_issuers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    issuer_did TEXT NOT NULL,
    display_name TEXT,
    -- JSON array of accepted Verifiable Credential Types
    credential_types TEXT,
    -- Trust level: 'standard' | 'high' (HAIP-compliant)
    trust_level TEXT DEFAULT 'standard',
    -- JWKS URI for issuer public keys
    jwks_uri TEXT,
    -- Issuer status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, issuer_did)
);

CREATE INDEX IF NOT EXISTS idx_trusted_issuers_tenant ON trusted_issuers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trusted_issuers_did ON trusted_issuers(issuer_did);

-- ============================================================================
-- Presentation Definitions
-- ============================================================================
-- Stores reusable presentation definitions for VP requests
-- Supports both legacy Presentation Exchange and DCQL

CREATE TABLE IF NOT EXISTS presentation_definitions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT,
    -- JSON: {"dc+sd-jwt": {...}, "mso_mdoc": {...}}
    format TEXT NOT NULL,
    -- JSON array of input descriptors
    input_descriptors TEXT NOT NULL,
    -- JSON for complex submission requirements
    submission_requirements TEXT,
    -- DCQL query (preferred for HAIP)
    dcql_query TEXT,
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_presentation_definitions_tenant ON presentation_definitions(tenant_id);

-- ============================================================================
-- VP Authorization Requests
-- ============================================================================
-- Tracks VP authorization request state
-- Primary state is in Durable Object, this is for backup/query

CREATE TABLE IF NOT EXISTS vp_requests (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    -- Nonce for replay protection (single-use, enforced by DO)
    nonce TEXT NOT NULL,
    state TEXT,
    -- Reference to presentation definition (optional, can use inline)
    presentation_definition_id TEXT REFERENCES presentation_definitions(id),
    response_uri TEXT NOT NULL,
    -- Response mode: 'direct_post' | 'direct_post.jwt' | 'fragment' | 'query'
    response_mode TEXT DEFAULT 'direct_post',
    -- Request status: 'pending' | 'submitted' | 'verified' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    -- Error information if failed
    error_code TEXT,
    error_description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vp_requests_tenant_status ON vp_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_vp_requests_nonce ON vp_requests(nonce);

-- ============================================================================
-- Attribute Verifications
-- ============================================================================
-- Stores VC verification RESULTS only (not raw VCs)
-- Data Minimization: no raw_credential or disclosed_claims stored

CREATE TABLE IF NOT EXISTS attribute_verifications (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vp_request_id TEXT REFERENCES vp_requests(id),
    -- Issuer DID
    issuer_did TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verification result: 'verified' | 'failed' | 'expired'
    verification_result TEXT NOT NULL,
    -- Individual verification flags
    holder_binding_verified INTEGER DEFAULT 0,
    issuer_trusted INTEGER DEFAULT 0,
    status_valid INTEGER DEFAULT 0,
    -- JSON array of user_verified_attributes IDs
    mapped_attribute_ids TEXT,
    verified_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_attribute_verifications_result ON attribute_verifications(verification_result);

-- ============================================================================
-- User Verified Attributes
-- ============================================================================
-- Normalized attributes extracted from VCs
-- Raw VC claims are discarded after normalization

CREATE TABLE IF NOT EXISTS user_verified_attributes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Attribute name: 'age_over_18', 'country', 'organization', etc.
    attribute_name TEXT NOT NULL,
    -- Attribute value: 'true', 'JP', 'Acme Corp', etc.
    attribute_value TEXT NOT NULL,
    -- Source type: 'vc' | 'saml' | 'oidc' | 'manual'
    source_type TEXT NOT NULL DEFAULT 'vc',
    -- Issuer DID (for VC-sourced attributes)
    issuer_did TEXT,
    -- Reference to verification record
    verification_id TEXT REFERENCES attribute_verifications(id),
    verified_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    -- Each user can have only one value per attribute
    UNIQUE(tenant_id, user_id, attribute_name)
);

CREATE INDEX IF NOT EXISTS idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name);

-- ============================================================================
-- Issued Credentials
-- ============================================================================
-- Tracks credentials issued by Authrim (as VCI Issuer)

CREATE TABLE IF NOT EXISTS issued_credentials (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- JSON of claims included in credential
    claims TEXT NOT NULL,
    -- Status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    -- Status list index for revocation
    status_list_index INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_issued_credentials_type ON issued_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_issued_credentials_status ON issued_credentials(status);

-- ============================================================================
-- Credential Offers
-- ============================================================================
-- Tracks credential offer state for VCI

CREATE TABLE IF NOT EXISTS credential_offers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Credential configuration ID
    credential_configuration_id TEXT NOT NULL,
    -- Pre-authorized code
    pre_authorized_code TEXT,
    -- Transaction code (PIN)
    tx_code TEXT,
    -- JSON of grants configuration
    grants TEXT NOT NULL,
    -- Status: 'pending' | 'accepted' | 'issued' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT REFERENCES issued_credentials(id)
);

CREATE INDEX IF NOT EXISTS idx_credential_offers_status ON credential_offers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_credential_offers_code ON credential_offers(pre_authorized_code);

-- ============================================================================
-- DID Document Cache
-- ============================================================================
-- Caches resolved DID documents for performance

CREATE TABLE IF NOT EXISTS did_document_cache (
    did TEXT PRIMARY KEY,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_did_document_cache_expires ON did_document_cache(expires_at);

-- ============================================================================
-- Status List
-- ============================================================================
-- Tracks credential revocation status (Status List 2021)

CREATE TABLE IF NOT EXISTS status_lists (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    -- Purpose: 'revocation' | 'suspension'
    purpose TEXT NOT NULL DEFAULT 'revocation',
    -- Bitstring of status values (base64url encoded)
    encoded_list TEXT NOT NULL,
    -- Current index for new credentials
    current_index INTEGER DEFAULT 0,
    -- Total capacity
    capacity INTEGER DEFAULT 131072,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_lists_tenant ON status_lists(tenant_id);

-- ============================================================================
-- Credential Configuration (for VCI)
-- ============================================================================
-- Stores credential configuration for issuance

CREATE TABLE IF NOT EXISTS credential_configurations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    -- Configuration ID (used in metadata)
    configuration_id TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verifiable Credential Type
    vct TEXT NOT NULL,
    -- JSON of display information
    display TEXT,
    -- JSON of claims configuration
    claims TEXT,
    -- JSON of proof types supported
    proof_types_supported TEXT,
    -- Signing algorithm
    signing_alg TEXT DEFAULT 'ES256',
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tenant_id, configuration_id)
);

CREATE INDEX IF NOT EXISTS idx_credential_configurations_tenant ON credential_configurations(tenant_id);
