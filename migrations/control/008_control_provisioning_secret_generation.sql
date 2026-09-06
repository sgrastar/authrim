-- Retain exact Worker secret-generation evidence across Control token cutover completion.
ALTER TABLE control_environments ADD COLUMN provisioning_token_management TEXT NOT NULL DEFAULT 'none'
  CHECK (provisioning_token_management IN ('none', 'setup', 'operator'));
ALTER TABLE control_environments ADD COLUMN provisioning_secret_generation_deployment_id TEXT
  CHECK (provisioning_secret_generation_deployment_id IS NULL OR (
    length(provisioning_secret_generation_deployment_id) BETWEEN 1 AND 128
    AND instr(provisioning_secret_generation_deployment_id, char(0)) = 0
    AND provisioning_secret_generation_deployment_id GLOB '[A-Za-z0-9]*'
    AND provisioning_secret_generation_deployment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ));
ALTER TABLE control_environments ADD COLUMN provisioning_secret_generation_version_id TEXT
  CHECK (provisioning_secret_generation_version_id IS NULL OR (
    length(provisioning_secret_generation_version_id) BETWEEN 1 AND 128
    AND instr(provisioning_secret_generation_version_id, char(0)) = 0
    AND provisioning_secret_generation_version_id GLOB '[A-Za-z0-9]*'
    AND provisioning_secret_generation_version_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ));

-- 007 did not retain the immutable Worker version that received the child-token secrets, nor did
-- it retain child-token fingerprints. Such rows cannot be promoted safely into the stricter 008
-- authority model. Normalize them while the 007 trigger is still installed so the next setup run
-- performs a new, fully evidenced cutover. The old Worker secrets continue serving until that new
-- generation is verified; deterministic token names let bootstrap retire the superseded tokens
-- only after the replacement generation is active.
UPDATE control_environments
   SET provisioning_token_ownership = 'none',
       provisioning_token_management = 'none',
       provisioning_capability_state = 'pending',
       provisioning_capability_checked_at = NULL,
       provisioning_bootstrap_phase = 'none',
       provisioning_bootstrap_token_ownership = 'none',
       provisioning_bootstrap_token_id = NULL,
       provisioning_bootstrap_token_fingerprint = NULL,
       provisioning_child_tokens_json = NULL,
       provisioning_secret_generation_deployment_id = NULL,
       provisioning_secret_generation_version_id = NULL
 WHERE automatic_provisioning_enabled = 1
   AND (
     provisioning_capability_state IN ('ready', 'blocked')
     OR provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
   );

DROP TRIGGER trg_control_environment_provisioning_authority_insert;
DROP TRIGGER trg_control_environment_provisioning_authority_update;

CREATE TRIGGER trg_control_environment_provisioning_authority_insert
BEFORE INSERT ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_token_management = 'none'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL
    AND NEW.provisioning_secret_generation_deployment_id IS NULL
    AND NEW.provisioning_secret_generation_version_id IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'setup'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'ready'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management IN ('setup', 'operator')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'blocked'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;

CREATE TRIGGER trg_control_environment_provisioning_authority_update
BEFORE UPDATE OF automatic_provisioning_enabled, provisioning_token_ownership,
  provisioning_capability_state, provisioning_token_management, provisioning_bootstrap_phase,
  provisioning_bootstrap_token_ownership, provisioning_bootstrap_token_id,
  provisioning_bootstrap_token_fingerprint, provisioning_child_tokens_json,
  provisioning_secret_generation_deployment_id, provisioning_secret_generation_version_id
ON control_environments
WHEN NOT (
  (NEW.automatic_provisioning_enabled = 0
    AND NEW.provisioning_token_ownership = 'none'
    AND NEW.provisioning_capability_state = 'disabled'
    AND NEW.provisioning_token_management = 'none'
    AND NEW.provisioning_bootstrap_phase = 'none'
    AND NEW.provisioning_bootstrap_token_ownership = 'none'
    AND NEW.provisioning_bootstrap_token_id IS NULL
    AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
    AND NEW.provisioning_child_tokens_json IS NULL
    AND NEW.provisioning_secret_generation_deployment_id IS NULL
    AND NEW.provisioning_secret_generation_version_id IS NULL)
  OR
  (NEW.automatic_provisioning_enabled = 1
    AND (
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
      OR
      (NEW.provisioning_capability_state = 'pending'
        AND NEW.provisioning_token_ownership = 'none'
        AND NEW.provisioning_token_management = 'setup'
        AND NEW.provisioning_bootstrap_phase IN ('pending_revocation', 'cutover_verified')
        AND NEW.provisioning_bootstrap_token_ownership IN ('user', 'account')
        AND NEW.provisioning_bootstrap_token_id IS NOT NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NOT NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'ready'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management IN ('setup', 'operator')
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NOT NULL
        AND NEW.provisioning_secret_generation_version_id IS NOT NULL
        AND NEW.provisioning_child_tokens_json IS NOT NULL
        AND json_array_length(NEW.provisioning_child_tokens_json) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.provisioning_child_tokens_json) AS child
          WHERE json_type(child.value) IS NOT 'object'
             OR json_type(child.value, '$.resourceClass') IS NOT 'text'
             OR json_extract(child.value, '$.resourceClass') NOT IN ('d1', 'workers', 'kv', 'r2')
             OR json_type(child.value, '$.tokenId') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenId')) <> 32
             OR json_extract(child.value, '$.tokenId') GLOB '*[^0-9a-f]*'
             OR json_type(child.value, '$.tokenName') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenName')) NOT BETWEEN 1 AND 128
             OR instr(json_extract(child.value, '$.tokenName'), char(0)) <> 0
             OR json_extract(child.value, '$.tokenName') NOT GLOB '[A-Za-z0-9]*'
             OR json_extract(child.value, '$.tokenName') GLOB '*[^A-Za-z0-9._:-]*'
             OR json_type(child.value, '$.secretName') IS NOT 'text'
             OR json_extract(child.value, '$.secretName') <> CASE json_extract(child.value, '$.resourceClass')
                  WHEN 'd1' THEN 'CLOUDFLARE_D1_API_TOKEN'
                  WHEN 'workers' THEN 'CLOUDFLARE_WORKERS_API_TOKEN'
                  WHEN 'kv' THEN 'CLOUDFLARE_KV_API_TOKEN'
                  WHEN 'r2' THEN 'CLOUDFLARE_R2_API_TOKEN'
                END
             OR json_type(child.value, '$.tokenFingerprint') IS NOT 'text'
             OR length(json_extract(child.value, '$.tokenFingerprint')) <> 64
             OR json_extract(child.value, '$.tokenFingerprint') GLOB '*[^0-9a-f]*'
        )
        AND (SELECT count(DISTINCT json_extract(child.value, '$.resourceClass'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json)
        AND (SELECT count(DISTINCT json_extract(child.value, '$.tokenId'))
               FROM json_each(NEW.provisioning_child_tokens_json) AS child)
            = json_array_length(NEW.provisioning_child_tokens_json))
      OR
      (NEW.provisioning_capability_state = 'blocked'
        AND NEW.provisioning_token_ownership IN ('user', 'account')
        AND NEW.provisioning_token_management = 'none'
        AND NEW.provisioning_bootstrap_phase = 'none'
        AND NEW.provisioning_bootstrap_token_ownership = 'none'
        AND NEW.provisioning_bootstrap_token_id IS NULL
        AND NEW.provisioning_bootstrap_token_fingerprint IS NULL
        AND NEW.provisioning_child_tokens_json IS NULL
        AND NEW.provisioning_secret_generation_deployment_id IS NULL
        AND NEW.provisioning_secret_generation_version_id IS NULL)
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'control_automatic_provisioning_authority_invalid');
END;
