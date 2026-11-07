-- Admin groups: a tenant's administrators gathered under one name, and the roles given to the
-- group, which every member holds as long as both the membership and the grant exist. Membership
-- is manual. A group belongs to one tenant, holds that tenant's administrators only, and gives
-- roles for that tenant only (never a global assignment).
--
-- What an administrator holds is read from the view admin_effective_role_assignments: their own
-- assignments and the ones that come through their groups, side by side. Nothing is copied into
-- admin_role_assignments, so removing a member, a grant or the group takes the roles away at once.
-- Members and grants carry the group's tenant; the view only joins rows whose tenants agree.
CREATE TABLE admin_groups (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  -- Stable name for APIs and imports, unique in the tenant
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  -- Raised whenever the group's grants change. Adding a member checks the version it was
  -- judged against, so a role granted meanwhile is not handed out unchecked.
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);

CREATE TABLE admin_group_members (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  admin_group_id TEXT NOT NULL,
  -- Only administrators for now; a group inside a group would be a later change
  member_type TEXT NOT NULL DEFAULT 'admin_user' CHECK (member_type = 'admin_user'),
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  added_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (admin_group_id, admin_user_id),
  FOREIGN KEY (admin_group_id) REFERENCES admin_groups(id) ON DELETE CASCADE
);

CREATE TABLE admin_group_role_grants (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  admin_group_id TEXT NOT NULL,
  admin_role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  -- A group gives roles for its own tenant only
  scope_type TEXT NOT NULL DEFAULT 'tenant' CHECK (scope_type = 'tenant'),
  scope_id TEXT NOT NULL,
  expires_at INTEGER,
  assigned_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (admin_group_id, admin_role_id, scope_type, scope_id),
  CHECK (scope_id = tenant_id),
  -- The platform role is held through a global assignment only, never through a group (also when
  -- a row arrives by restore rather than the API)
  CHECK (admin_role_id <> 'role_ar_super_admin'),
  FOREIGN KEY (admin_group_id) REFERENCES admin_groups(id) ON DELETE CASCADE
);

-- The groups an invitation adds its admin to on enrolment, with the group version the inviter
-- was judged against; a group whose grants changed since, or that was deleted, is not joined.
-- Not a foreign key to the group: the row (with the group's name then) outlives a deleted group,
-- so enrolment can still say which group was left out.
CREATE TABLE admin_invitation_groups (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL REFERENCES admin_invitations(id) ON DELETE CASCADE,
  admin_group_id TEXT NOT NULL,
  group_display_name TEXT NOT NULL,
  group_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (invitation_id, admin_group_id)
);

CREATE INDEX idx_admin_group_members_user ON admin_group_members(admin_user_id);
CREATE INDEX idx_admin_group_members_tenant ON admin_group_members(tenant_id, admin_group_id);
CREATE INDEX idx_admin_group_role_grants_group ON admin_group_role_grants(admin_group_id);
CREATE INDEX idx_admin_group_role_grants_role ON admin_group_role_grants(admin_role_id);
CREATE INDEX idx_admin_group_role_grants_tenant ON admin_group_role_grants(tenant_id, id);
CREATE INDEX idx_admin_invitation_groups_tenant ON admin_invitation_groups(tenant_id, id);
CREATE INDEX idx_admin_invitation_groups_group ON admin_invitation_groups(admin_group_id);

-- Every assignment an administrator holds: their own (source 'direct', the row of
-- admin_role_assignments) and one per membership and grant of their groups (source 'group').
-- Expiry is not applied here; readers compare expires_at with the clock in milliseconds.
CREATE VIEW admin_effective_role_assignments AS
  SELECT ra.id AS id,
         ra.tenant_id AS tenant_id,
         ra.admin_user_id AS admin_user_id,
         ra.admin_role_id AS admin_role_id,
         ra.scope_type AS scope_type,
         ra.scope_id AS scope_id,
         ra.expires_at AS expires_at,
         ra.assigned_by AS assigned_by,
         ra.created_at AS created_at,
         'direct' AS source,
         NULL AS admin_group_id,
         NULL AS group_member_id,
         NULL AS group_grant_id
    FROM admin_role_assignments ra
  UNION ALL
  SELECT 'group:' || m.id || ':' || g.id AS id,
         g.tenant_id AS tenant_id,
         m.admin_user_id AS admin_user_id,
         g.admin_role_id AS admin_role_id,
         g.scope_type AS scope_type,
         g.scope_id AS scope_id,
         g.expires_at AS expires_at,
         g.assigned_by AS assigned_by,
         g.created_at AS created_at,
         'group' AS source,
         g.admin_group_id AS admin_group_id,
         m.id AS group_member_id,
         g.id AS group_grant_id
    FROM admin_group_members m
    -- Only the group's own tenant's administrators, whatever a row says
    JOIN admin_users au
      ON au.id = m.admin_user_id
     AND au.tenant_id = m.tenant_id
    JOIN admin_groups grp
      ON grp.id = m.admin_group_id
     AND grp.tenant_id = m.tenant_id
    JOIN admin_group_role_grants g
      ON g.admin_group_id = grp.id
     AND g.tenant_id = grp.tenant_id
   WHERE m.member_type = 'admin_user';
