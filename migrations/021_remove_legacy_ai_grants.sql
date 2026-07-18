-- =============================================================================
-- Authrim Core Migration 021: Remove Legacy AI Grants
-- =============================================================================
-- The legacy core.ai_grants table was never enforced by token issuance. Admin
-- Agent delegation is now owned by DB_ADMIN.admin_agent_grants. No compatibility
-- view or data migration is intentionally provided.

DROP TABLE IF EXISTS ai_grants;
