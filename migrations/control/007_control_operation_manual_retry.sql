-- Manual retry windows are independent from the original operation creation time.
-- The operator action itself is recorded in control_audit_events before any state transition.

ALTER TABLE control_operations ADD COLUMN retry_budget_started_at INTEGER;
