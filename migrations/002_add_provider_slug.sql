-- Migration: 002_add_provider_slug.sql
-- Description: Add slug column to upstream_providers for user-friendly callback URLs
-- Author: Claude
-- Date: 2025-12-11

-- Add slug column for user-friendly callback URLs
-- Example: /auth/external/google/callback instead of /auth/external/{uuid}/callback
ALTER TABLE upstream_providers ADD COLUMN slug TEXT;

-- Create unique index on tenant_id + slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug)
  WHERE slug IS NOT NULL;
