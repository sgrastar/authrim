-- Which first-steps checklist items an admin has finished in the admin console, per tenant. One
-- row per finished item; an item that was never finished (or was reopened) has no row. Only the
-- progress is kept here: what the items are and what they point at is the console's.
CREATE TABLE admin_onboarding_progress (
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (admin_user_id, tenant_id, item_id)
);
