-- Durable two-phase Control token cutover and exact child-token ownership evidence.
ALTER TABLE control_environments ADD COLUMN provisioning_bootstrap_phase TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_bootstrap_phase IN ('none', 'pending_revocation', 'cutover_verified'));
ALTER TABLE control_environments ADD COLUMN provisioning_bootstrap_token_ownership TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_bootstrap_token_ownership IN ('none', 'user', 'account'));
ALTER TABLE control_environments ADD COLUMN provisioning_bootstrap_token_id TEXT
  CHECK (provisioning_bootstrap_token_id IS NULL OR (
    length(provisioning_bootstrap_token_id) = 32
    AND provisioning_bootstrap_token_id NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE control_environments ADD COLUMN provisioning_bootstrap_token_fingerprint TEXT
  CHECK (provisioning_bootstrap_token_fingerprint IS NULL OR (
    length(provisioning_bootstrap_token_fingerprint) = 64
    AND provisioning_bootstrap_token_fingerprint NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE control_environments ADD COLUMN provisioning_child_tokens_json TEXT
  CHECK (provisioning_child_tokens_json IS NULL OR (
    json_valid(provisioning_child_tokens_json)
    AND json_type(provisioning_child_tokens_json) = 'array'
  ));

DROP TRIGGER trg_control_environment_provisioning_authority_insert;
DROP TRIGGER trg_control_environment_provisioning_authority_update;

CREATE TRIGGER trg_control_environment_provisioning_authority_insert
BEFORE INSERT ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL)
      OR
      (NEW.provisioning_capability_state IN ('ready', 'blocked')
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;

CREATE TRIGGER trg_control_environment_provisioning_authority_update
BEFORE UPDATE OF automatic_provisioning_enabled, provisioning_token_ownership,
  provisioning_capability_state, provisioning_bootstrap_phase,
  provisioning_bootstrap_token_ownership, provisioning_bootstrap_token_id,
  provisioning_bootstrap_token_fingerprint, provisioning_child_tokens_json
ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL)
      OR
      (NEW.provisioning_capability_state IN ('ready', 'blocked')
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;
