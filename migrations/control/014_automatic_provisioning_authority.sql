-- Server-owned execution authority for tenant D1 provisioning.
-- Token values are Worker secrets and must never be stored in this table.

ALTER TABLE control_environments
  ADD COLUMN automatic_provisioning_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (automatic_provisioning_enabled IN (0, 1));

ALTER TABLE control_environments
  ADD COLUMN provisioning_token_ownership TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_token_ownership IN ('none', 'user', 'account'));

ALTER TABLE control_environments
  ADD COLUMN provisioning_capability_state TEXT NOT NULL DEFAULT 'disabled'
  CHECK (provisioning_capability_state IN ('disabled', 'pending', 'ready', 'blocked'));

ALTER TABLE control_environments
  ADD COLUMN provisioning_capability_checked_at INTEGER;

CREATE TRIGGER IF NOT EXISTS trg_control_environment_provisioning_authority_insert
BEFORE INSERT ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled')
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none')
      OR
      (NEW.provisioning_capability_state IN ('ready', 'blocked')
        AND NEW.provisioning_token_ownership IN ('user', 'account'))
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_environment_provisioning_authority_update
BEFORE UPDATE OF automatic_provisioning_enabled, provisioning_token_ownership,
  provisioning_capability_state ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled')
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none')
      OR
      (NEW.provisioning_capability_state IN ('ready', 'blocked')
        AND NEW.provisioning_token_ownership IN ('user', 'account'))
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;
