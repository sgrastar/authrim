-- Role assignments and organisation memberships are account data, kept in the account's database
-- (tenant_core/users); the roles and organisations they name are tenant settings, kept in the
-- tenant metadata database (tenant_core/default). The two may be different D1 databases, where a
-- foreign key from one to the other cannot hold: in an account database, roles and organizations
-- are empty, so every assignment would be refused. role_id and org_id stay references by id,
-- checked against the metadata database when an assignment is made, and an assignment of a role
-- or organisation the tenant no longer has grants nothing. subject_id loses its foreign key to
-- users_core too: accounts are written as identity_accounts, and users_core (the legacy user
-- table) is written by nothing, so with it every assignment and membership of an account would
-- be refused.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE "__authrim_rebuild_role_assignments" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO "__authrim_rebuild_role_assignments"
  ("rowid","id","tenant_id","subject_id","role_id","scope_type","scope_target","expires_at",
   "assigned_by","metadata_json","created_at","updated_at")
SELECT "rowid","id","tenant_id","subject_id","role_id","scope_type","scope_target","expires_at",
       "assigned_by","metadata_json","created_at","updated_at"
  FROM "role_assignments";
DROP TABLE "role_assignments";
ALTER TABLE "__authrim_rebuild_role_assignments" RENAME TO "role_assignments";
CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id);
CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id);

CREATE TABLE "__authrim_rebuild_subject_org_membership" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_type TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO "__authrim_rebuild_subject_org_membership"
  ("rowid","id","tenant_id","subject_id","org_id","membership_type","is_primary","created_at",
   "updated_at")
SELECT "rowid","id","tenant_id","subject_id","org_id","membership_type","is_primary","created_at",
       "updated_at"
  FROM "subject_org_membership";
DROP TABLE "subject_org_membership";
ALTER TABLE "__authrim_rebuild_subject_org_membership" RENAME TO "subject_org_membership";
CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id);
CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id);

PRAGMA defer_foreign_keys = OFF;
