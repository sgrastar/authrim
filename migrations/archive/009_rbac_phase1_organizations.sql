-- Migration: 009_rbac_phase1_organizations.sql
-- Description: Create organizations and subject_org_membership tables for RBAC Phase 1
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Organizations Table
-- =============================================================================
-- Represents companies, departments, or other organizational units.
-- Used for B2B/B2B2C scenarios (distributors, enterprise customers, etc.)

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  org_type TEXT NOT NULL DEFAULT 'enterprise',  -- distributor, enterprise, department
  parent_org_id TEXT REFERENCES organizations(id),
  plan TEXT DEFAULT 'free',  -- free, starter, professional, enterprise
  is_active INTEGER DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for organizations
CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id);
CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id);
CREATE INDEX idx_organizations_org_type ON organizations(org_type);
CREATE INDEX idx_organizations_is_active ON organizations(is_active);
CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name);

-- =============================================================================
-- 2. Subject-Organization Membership Table
-- =============================================================================
-- Links users (subjects) to organizations with a specific membership type.
-- is_primary = 1 indicates the user's primary organization (source of truth).

CREATE TABLE subject_org_membership (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_type TEXT NOT NULL DEFAULT 'member',  -- member, admin, owner
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for subject_org_membership
CREATE INDEX idx_subject_org_membership_tenant_id ON subject_org_membership(tenant_id);
CREATE INDEX idx_subject_org_membership_subject_id ON subject_org_membership(subject_id);
CREATE INDEX idx_subject_org_membership_org_id ON subject_org_membership(org_id);
CREATE INDEX idx_subject_org_membership_is_primary ON subject_org_membership(subject_id, is_primary);
CREATE UNIQUE INDEX idx_subject_org_membership_unique ON subject_org_membership(subject_id, org_id);

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 009
-- =============================================================================
