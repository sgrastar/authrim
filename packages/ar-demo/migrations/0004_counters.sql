-- Numbers that only grow. The registry is cleaned (deleted rows are purged after a week), so a
-- total cannot be read from it later; it is counted here at the moment it happens.
CREATE TABLE IF NOT EXISTS demo_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
-- `tenants_created`: creations the Admin API accepted. It starts from the accepted rows the
-- registry still holds; what was purged before this migration is not known any more.
-- Apply it AFTER the Worker that counts is deployed: that Worker records acceptances without the
-- table too, and this statement then counts them. Applied before, an acceptance recorded by the
-- older Worker in between is missed.
INSERT OR IGNORE INTO demo_counters (name, value)
SELECT 'tenants_created', COUNT(*) FROM demo_tenants WHERE create_accepted_at IS NOT NULL;
