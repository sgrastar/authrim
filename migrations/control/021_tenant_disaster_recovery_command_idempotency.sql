-- Preserve response-loss-safe idempotency for each externally initiated DR command.
-- Keys remain Control-internal and are write-once after their transition commits.

ALTER TABLE control_tenant_disaster_recovery_operations
  ADD COLUMN restore_idempotency_key TEXT;

ALTER TABLE control_tenant_disaster_recovery_operations
  ADD COLUMN reactivation_idempotency_key TEXT;

ALTER TABLE control_tenant_disaster_recovery_operations
  ADD COLUMN cancel_idempotency_key TEXT;

ALTER TABLE control_tenant_disaster_recovery_operations
  ADD COLUMN cancel_requested_by TEXT;

CREATE TRIGGER IF NOT EXISTS trg_control_tenant_dr_command_idempotency_write_once
BEFORE UPDATE OF restore_idempotency_key, restore_confirmed_by,
  reactivation_idempotency_key, reactivation_requested_by,
  cancel_idempotency_key, cancel_requested_by
ON control_tenant_disaster_recovery_operations
WHEN (OLD.restore_idempotency_key IS NOT NULL AND
      NEW.restore_idempotency_key IS NOT OLD.restore_idempotency_key) OR
     (OLD.restore_confirmed_by IS NOT NULL AND
      NEW.restore_confirmed_by IS NOT OLD.restore_confirmed_by) OR
     (OLD.reactivation_idempotency_key IS NOT NULL AND
      NEW.reactivation_idempotency_key IS NOT OLD.reactivation_idempotency_key) OR
     (OLD.reactivation_requested_by IS NOT NULL AND
      NEW.reactivation_requested_by IS NOT OLD.reactivation_requested_by) OR
     (OLD.cancel_idempotency_key IS NOT NULL AND
      NEW.cancel_idempotency_key IS NOT OLD.cancel_idempotency_key) OR
     (OLD.cancel_requested_by IS NOT NULL AND
      NEW.cancel_requested_by IS NOT OLD.cancel_requested_by)
BEGIN
  SELECT RAISE(ABORT, 'control_tenant_dr_command_idempotency_immutable');
END;
