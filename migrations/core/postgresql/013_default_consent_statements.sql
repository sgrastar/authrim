-- Migration: 013_default_consent_statements.sql
-- Description: Every tenant starts with a published terms of service and privacy policy
--              (packages/ar-lib-core/src/services/default-consent-statements.ts seeds new tenants
--              the same way). Each is a link version with no link yet, in ar/de/en/ja, with the
--              earlier admin UI's agreement sentence as its description. A tenant that already has
--              a statement of the same kind or key gets none of that kind. The rows are written as
--              activateVersion leaves them: version active and current with its content hash,
--              agreement required from it, and its consent projection job queued.
-- Author: @authrim
-- Date: 2026-11-18

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- terms-of-service
INSERT INTO consent_statements
  (id, tenant_id, slug, category, legal_basis, display_order, is_active, withdrawal_allowed,
   definition_generation, required_consent_version, created_at, updated_at)
SELECT 'cst_default_terms:' || t.id, t.id, 'terms-of-service', 'terms_of_service', 'consent', 0, 1, 1, 1, '20261118', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM consent_statements s
    WHERE s.tenant_id = t.id AND (s.slug = 'terms-of-service' OR s.category = 'terms_of_service')
 );

INSERT INTO consent_statement_versions
  (id, tenant_id, statement_id, version, content_type, effective_at, content_hash, is_current,
   current_statement_guard, status, created_at, updated_at)
SELECT 'csv_default_terms:' || t.id, t.id, 'cst_default_terms:' || t.id, '20261118', 'url', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, '93b2806611c768398c2970d31ad962c2abfe4659dcfe24be428e0a2edd705741', 1, 'cst_default_terms:' || t.id, 'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (SELECT 1 FROM consent_statements s WHERE s.tenant_id = t.id AND s.id = 'cst_default_terms:' || t.id)
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_versions v WHERE v.tenant_id = t.id AND v.statement_id = 'cst_default_terms:' || t.id
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_terms_ar:' || t.id, t.id, 'csv_default_terms:' || t.id, 'ar', 'شروط الخدمة', 'لقد قرأت شروط الخدمة وأوافق عليها.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_terms:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_terms:' || t.id AND l.language = 'ar'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_terms_de:' || t.id, t.id, 'csv_default_terms:' || t.id, 'de', 'Nutzungsbedingungen', 'Ich habe die Nutzungsbedingungen gelesen und stimme ihnen zu.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_terms:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_terms:' || t.id AND l.language = 'de'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_terms_en:' || t.id, t.id, 'csv_default_terms:' || t.id, 'en', 'Terms of Service', 'I have read and agree to the Terms of Service.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_terms:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_terms:' || t.id AND l.language = 'en'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_terms_ja:' || t.id, t.id, 'csv_default_terms:' || t.id, 'ja', '利用規約', '利用規約を読み、その内容に同意します。', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_terms:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_terms:' || t.id AND l.language = 'ja'
   );

INSERT INTO statement_consent_projection_jobs
  (tenant_id, statement_id, definition_generation, closed_generation, mode, targets_json,
   cursor_binding_ref, updated_at)
SELECT t.id, 'cst_default_terms:' || t.id, 1, 0, 'enforced', NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statements s
    WHERE s.tenant_id = t.id AND s.id = 'cst_default_terms:' || t.id AND s.definition_generation = 1
 )
   AND NOT EXISTS (
     SELECT 1 FROM statement_consent_projection_jobs j WHERE j.tenant_id = t.id AND j.statement_id = 'cst_default_terms:' || t.id
   );

-- privacy-policy
INSERT INTO consent_statements
  (id, tenant_id, slug, category, legal_basis, display_order, is_active, withdrawal_allowed,
   definition_generation, required_consent_version, created_at, updated_at)
SELECT 'cst_default_privacy:' || t.id, t.id, 'privacy-policy', 'privacy_policy', 'consent', 0, 1, 1, 1, '20261118', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE NOT EXISTS (
   SELECT 1 FROM consent_statements s
    WHERE s.tenant_id = t.id AND (s.slug = 'privacy-policy' OR s.category = 'privacy_policy')
 );

INSERT INTO consent_statement_versions
  (id, tenant_id, statement_id, version, content_type, effective_at, content_hash, is_current,
   current_statement_guard, status, created_at, updated_at)
SELECT 'csv_default_privacy:' || t.id, t.id, 'cst_default_privacy:' || t.id, '20261118', 'url', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, '93b2806611c768398c2970d31ad962c2abfe4659dcfe24be428e0a2edd705741', 1, 'cst_default_privacy:' || t.id, 'active', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (SELECT 1 FROM consent_statements s WHERE s.tenant_id = t.id AND s.id = 'cst_default_privacy:' || t.id)
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_versions v WHERE v.tenant_id = t.id AND v.statement_id = 'cst_default_privacy:' || t.id
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_privacy_ar:' || t.id, t.id, 'csv_default_privacy:' || t.id, 'ar', 'سياسة الخصوصية', 'لقد قرأت سياسة الخصوصية وأوافق عليها.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_privacy:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_privacy:' || t.id AND l.language = 'ar'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_privacy_de:' || t.id, t.id, 'csv_default_privacy:' || t.id, 'de', 'Datenschutzerklärung', 'Ich habe die Datenschutzerklärung gelesen und stimme ihr zu.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_privacy:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_privacy:' || t.id AND l.language = 'de'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_privacy_en:' || t.id, t.id, 'csv_default_privacy:' || t.id, 'en', 'Privacy Policy', 'I have read and agree to the Privacy Policy.', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_privacy:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_privacy:' || t.id AND l.language = 'en'
   );

INSERT INTO consent_statement_localizations
  (id, tenant_id, version_id, language, title, description, created_at, updated_at)
SELECT 'csl_default_privacy_ja:' || t.id, t.id, 'csv_default_privacy:' || t.id, 'ja', 'プライバシーポリシー', 'プライバシーポリシーを読み、その内容に同意します。', __AUTHRIM_NOW_EPOCH_MILLISECONDS__, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statement_versions v
    WHERE v.tenant_id = t.id AND v.id = 'csv_default_privacy:' || t.id
 )
   AND NOT EXISTS (
     SELECT 1 FROM consent_statement_localizations l WHERE l.version_id = 'csv_default_privacy:' || t.id AND l.language = 'ja'
   );

INSERT INTO statement_consent_projection_jobs
  (tenant_id, statement_id, definition_generation, closed_generation, mode, targets_json,
   cursor_binding_ref, updated_at)
SELECT t.id, 'cst_default_privacy:' || t.id, 1, 0, 'enforced', NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__
  FROM tenants t
 WHERE EXISTS (
   SELECT 1 FROM consent_statements s
    WHERE s.tenant_id = t.id AND s.id = 'cst_default_privacy:' || t.id AND s.definition_generation = 1
 )
   AND NOT EXISTS (
     SELECT 1 FROM statement_consent_projection_jobs j WHERE j.tenant_id = t.id AND j.statement_id = 'cst_default_privacy:' || t.id
   );
