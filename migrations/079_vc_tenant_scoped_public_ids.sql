-- Migration: 079_vc_tenant_scoped_public_ids.sql
-- Description: Split VC public IDs from internal database IDs.
--
-- Authrim is still pre-release for VC production use. This migration rebuilds
-- the VC issuance tables instead of preserving historical rows so the database
-- constraint model matches the tenant-scoped repository contract.

PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_credential_offers_code;
DROP INDEX IF EXISTS idx_credential_offers_status;
DROP INDEX IF EXISTS idx_issued_credentials_status;
DROP INDEX IF EXISTS idx_issued_credentials_type;
DROP INDEX IF EXISTS idx_issued_credentials_user;
DROP INDEX IF EXISTS idx_issued_credentials_status_list;
DROP INDEX IF EXISTS idx_status_lists_tenant;
DROP INDEX IF EXISTS idx_status_lists_tenant_public;

DROP TABLE IF EXISTS credential_offers;
DROP TABLE IF EXISTS issued_credentials;
DROP TABLE IF EXISTS status_lists;

CREATE TABLE status_lists (
    internal_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'revocation',
    encoded_list TEXT NOT NULL,
    current_index INTEGER DEFAULT 0,
    capacity INTEGER DEFAULT 131072,
    used_count INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active',
    sealed_at TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE (tenant_id, public_id)
);

CREATE TABLE issued_credentials (
    internal_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    format TEXT NOT NULL,
    claims TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    status_list_id TEXT,
    status_list_internal_id TEXT,
    status_list_index INTEGER,
    holder_binding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT,
    UNIQUE (tenant_id, public_id),
    FOREIGN KEY (status_list_internal_id) REFERENCES status_lists(internal_id)
);

CREATE TABLE credential_offers (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    credential_configuration_id TEXT NOT NULL,
    pre_authorized_code TEXT,
    tx_code TEXT,
    grants TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT,
    issued_credential_internal_id TEXT,
    FOREIGN KEY (issued_credential_internal_id) REFERENCES issued_credentials(internal_id)
);

CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code);
CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status);
CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status);
CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type);
CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);
CREATE INDEX idx_issued_credentials_status_list
  ON issued_credentials(tenant_id, status_list_internal_id, status_list_index);
CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id);
CREATE INDEX idx_status_lists_tenant_public ON status_lists(tenant_id, public_id);

PRAGMA foreign_keys = ON;
