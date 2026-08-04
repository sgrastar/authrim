-- Migration: 043_account_routing_outbox_lookup_index.sql
-- Description: Add the account-scoped routing outbox lookup index used by runtime publication checks.
-- Author: Authrim maintainers
-- Date: 2026-08-03

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- The existing due-work index starts with status and cannot serve account route revalidation.
-- Keep tenant_id first because every authoritative lookup is tenant constrained, then cover both
-- current-route joins and removal-history reads with one bounded index.
CREATE INDEX IF NOT EXISTS idx_account_routing_outbox_account_event_route
  ON account_routing_outbox(
    tenant_id,
    account_id,
    event_kind,
    route_generation,
    status,
    outbox_id
  );

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP INDEX IF EXISTS idx_account_routing_outbox_account_event_route;
-- DELETE FROM schema_migrations WHERE version = 43;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 043
-- =============================================================================
