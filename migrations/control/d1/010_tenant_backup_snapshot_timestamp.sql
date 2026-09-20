-- Persist the instant at which writers have drained and every snapshot participant sees one state.
ALTER TABLE tenant_backup_mutation_boundaries ADD COLUMN held_at INTEGER;

-- Preserve the former release-time boundary for completed operations. A held row can only exist
-- inside the two-second drain window, so its creation time is the conservative recoverable bound.
UPDATE tenant_backup_mutation_boundaries
SET held_at=CASE WHEN state='released' THEN released_at ELSE created_at END
WHERE state IN ('held','released');

CREATE TRIGGER tenant_backup_mutation_boundary_held_at_insert
BEFORE INSERT ON tenant_backup_mutation_boundaries
WHEN NEW.held_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_held_at_invalid'); END;

CREATE TRIGGER tenant_backup_mutation_boundary_held_at_update
BEFORE UPDATE OF state,held_at ON tenant_backup_mutation_boundaries
WHEN (NEW.state IN ('held','released') AND NEW.held_at IS NULL)
  OR (NEW.held_at IS NOT NULL AND (
    NEW.held_at<NEW.created_at OR NEW.held_at>=NEW.deadline_at
    OR (OLD.held_at IS NOT NULL AND NEW.held_at IS NOT OLD.held_at)
    OR (OLD.held_at IS NULL AND NOT (OLD.state='draining' AND NEW.state='held'))
  ))
BEGIN SELECT RAISE(ABORT,'backup_mutation_boundary_held_at_invalid'); END;
