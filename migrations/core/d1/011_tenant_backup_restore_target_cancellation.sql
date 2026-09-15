-- Cancellation may invalidate a sealed unpublished restore target; invalid remains terminal.
DROP TRIGGER tenant_backup_restore_target_monotonic;
CREATE TRIGGER tenant_backup_restore_target_monotonic
BEFORE UPDATE ON tenant_backup_restore_targets
WHEN NEW.fencing_token<OLD.fencing_token
  OR (NEW.fencing_token=OLD.fencing_token AND NEW.owner!=OLD.owner)
  OR (OLD.state='invalid' AND NEW.state!='invalid')
  OR (OLD.state='sealed' AND NEW.state='loading')
BEGIN SELECT RAISE(ABORT,'backup_restore_target_regression'); END;
