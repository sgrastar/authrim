-- =============================================================================
-- 052: Consent Management Enhancement (SAP CDC-like)
-- =============================================================================
-- Adds flexible consent management with:
-- - Arbitrary consent items (statements) with versioning
-- - Multi-language localization
-- - Conditional requirements based on user claims
-- - Per-tenant and per-client override support
-- - Full audit history (GDPR Art 7)
-- =============================================================================

-- 1. consent_statements — Consent item definitions
CREATE TABLE consent_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,                    -- Unique identifier (e.g., 'marketing_emails', 'tos')
  category TEXT NOT NULL DEFAULT 'custom', -- 'terms_of_service'|'privacy_policy'|'cookie_policy'|'marketing'|'data_sharing'|'analytics'|'do_not_sell'|'custom'
  legal_basis TEXT NOT NULL DEFAULT 'consent', -- GDPR Art6: 'consent'|'legitimate_interest'|'contract'|'legal_obligation'
  processing_purpose TEXT,               -- Data processing purpose (GDPR Art13/14)
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX idx_consent_statements_tenant ON consent_statements(tenant_id, is_active);

-- 2. consent_statement_versions — Version management
CREATE TABLE consent_statement_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  version TEXT NOT NULL,                 -- YYYYMMDD fixed: '20250206'
  content_type TEXT NOT NULL DEFAULT 'url', -- 'url' | 'inline'
  effective_at INTEGER NOT NULL,         -- Effective date (Unix timestamp)
  content_hash TEXT,                     -- SHA-256 integrity hash
  is_current INTEGER NOT NULL DEFAULT 0, -- Currently active version
  current_statement_guard TEXT,          -- statement_id when is_current=1, NULL otherwise
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft'|'active'|'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id, version)
);
CREATE INDEX idx_csv_statement ON consent_statement_versions(statement_id, is_current);
CREATE INDEX idx_csv_effective ON consent_statement_versions(effective_at);
-- Portable uniqueness: only the current version materializes a statement guard
CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);

-- 3. consent_statement_localizations — Multi-language content
CREATE TABLE consent_statement_localizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,                -- BCP 47: 'en', 'ja', 'de'
  title TEXT NOT NULL,                   -- Display title
  description TEXT NOT NULL,             -- Short description for consent screen
  document_url TEXT,                     -- External document URL (content_type='url')
  inline_content TEXT,                   -- Inline text (content_type='inline')
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE,
  UNIQUE (version_id, language)
);
CREATE INDEX idx_csl_version ON consent_statement_localizations(version_id, language);

-- 4. user_consent_records — Per-user consent records
-- Replaces oauth_client_consents for consent management items
-- Key: UNIQUE (tenant_id, user_id, statement_id) — consent is platform-wide per user (D1)
CREATE TABLE user_consent_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,                 -- YYYYMMDD (quick lookup/comparison)
  status TEXT NOT NULL DEFAULT 'granted', -- 'granted'|'denied'|'withdrawn'|'expired' (D3)
  granted_at INTEGER,                    -- Not nulled on withdrawal (evidence preserved)
  withdrawn_at INTEGER,
  expires_at INTEGER,
  client_id TEXT,                        -- Last client that obtained consent (audit trail only)
  ip_address_hash TEXT,                  -- Tenant-scoped SHA-256 salt (D7)
  user_agent TEXT,
  receipt_id TEXT,                       -- Consent receipt ID (Phase 2)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id),
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id),
  UNIQUE (tenant_id, user_id, statement_id)
);
CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);
CREATE INDEX idx_ucr_status ON user_consent_records(status);
CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);

-- 5. consent_item_history — Consent change audit log
CREATE TABLE consent_item_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,                  -- 'granted'|'denied'|'withdrawn'|'version_upgraded'|'expired'
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,                    -- For withdrawn: must be 'granted' (D3)
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE INDEX idx_cih_user ON consent_item_history(user_id, created_at);
CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);
CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);

-- 6. tenant_consent_requirements — Tenant-level requirement settings
CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  min_version TEXT,                      -- YYYYMMDD: minimum required version
  enforcement TEXT NOT NULL DEFAULT 'block', -- 'block'|'allow_continue'
  show_deletion_link INTEGER NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,           -- JSON: conditional rules
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id)
);
CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id);

-- 7. client_consent_overrides — Per-client overrides
CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'inherit', -- 'required'|'optional'|'hidden'|'inherit'
  min_version TEXT,                      -- null = use tenant default
  enforcement TEXT,                      -- null = use tenant default
  conditional_rules_json TEXT,           -- null = use tenant default
  display_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, statement_id)
);
CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

-- =============================================================================
-- Data Migration: consent_policy_versions → consent_statements + versions
-- =============================================================================
-- Migrate existing policy versions into the new consent_statements structure.
-- Each distinct policy_type becomes a consent_statement with its versions.
-- This is a best-effort migration; manual review is recommended.

-- Create consent_statements from distinct policy types
INSERT INTO consent_statements (id, tenant_id, slug, category, legal_basis, display_order, is_active, created_at, updated_at)
SELECT
  'migrated_' || tenant_id || '_' || policy_type,
  tenant_id,
  policy_type,
  CASE policy_type
    WHEN 'privacy_policy' THEN 'privacy_policy'
    WHEN 'terms_of_service' THEN 'terms_of_service'
    WHEN 'cookie_policy' THEN 'cookie_policy'
    ELSE 'custom'
  END,
  CASE policy_type
    WHEN 'terms_of_service' THEN 'contract'
    ELSE 'consent'
  END,
  CASE policy_type
    WHEN 'terms_of_service' THEN 0
    WHEN 'privacy_policy' THEN 1
    WHEN 'cookie_policy' THEN 2
    ELSE 10
  END,
  1,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM consent_policy_versions
GROUP BY tenant_id, policy_type;

-- Migrate versions
INSERT INTO consent_statement_versions (id, tenant_id, statement_id, version, content_type, effective_at, content_hash, is_current, status, created_at, updated_at)
SELECT
  'migrated_v_' || cpv.id,
  cpv.tenant_id,
  'migrated_' || cpv.tenant_id || '_' || cpv.policy_type,
  cpv.version,
  CASE WHEN cpv.policy_uri IS NOT NULL THEN 'url' ELSE 'inline' END,
  cpv.effective_at,
  cpv.policy_hash,
  0,  -- Will set is_current below
  'active',
  cpv.created_at,
  cpv.created_at
FROM consent_policy_versions cpv;

-- Set is_current=1 for the latest version of each statement
-- (the one with the highest effective_at that is <= now)
UPDATE consent_statement_versions
SET is_current = 1,
    current_statement_guard = statement_id
WHERE id IN (
  SELECT csv.id
  FROM consent_statement_versions csv
  INNER JOIN (
    SELECT statement_id, tenant_id, MAX(effective_at) as max_effective
    FROM consent_statement_versions
    WHERE effective_at <= __AUTHRIM_NOW_EPOCH_MILLISECONDS__
      AND id LIKE 'migrated_v_%'
    GROUP BY statement_id, tenant_id
  ) latest ON csv.statement_id = latest.statement_id
    AND csv.tenant_id = latest.tenant_id
    AND csv.effective_at = latest.max_effective
  WHERE csv.id LIKE 'migrated_v_%'
);

-- Create localizations from policy_uri (for URL-based policies)
INSERT INTO consent_statement_localizations (id, tenant_id, version_id, language, title, description, document_url, created_at, updated_at)
SELECT
  'migrated_l_' || cpv.id,
  cpv.tenant_id,
  'migrated_v_' || cpv.id,
  'en',
  CASE cpv.policy_type
    WHEN 'privacy_policy' THEN 'Privacy Policy'
    WHEN 'terms_of_service' THEN 'Terms of Service'
    WHEN 'cookie_policy' THEN 'Cookie Policy'
    ELSE cpv.policy_type
  END,
  CASE cpv.policy_type
    WHEN 'privacy_policy' THEN 'Please review our privacy policy'
    WHEN 'terms_of_service' THEN 'Please review our terms of service'
    WHEN 'cookie_policy' THEN 'Please review our cookie policy'
    ELSE 'Please review this policy'
  END,
  cpv.policy_uri,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__,
  __AUTHRIM_NOW_EPOCH_MILLISECONDS__
FROM consent_policy_versions cpv
WHERE cpv.policy_uri IS NOT NULL;
