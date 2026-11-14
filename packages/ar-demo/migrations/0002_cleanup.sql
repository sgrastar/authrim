-- Bookkeeping of the scheduled cleanup. Epoch seconds, like the other timestamps.
ALTER TABLE demo_tenants ADD COLUMN delete_attempted_at INTEGER;
ALTER TABLE demo_tenants ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;
-- Set when the Admin API accepted the creation (202): only such a row is known to own its tenant.
ALTER TABLE demo_tenants ADD COLUMN create_accepted_at INTEGER;
