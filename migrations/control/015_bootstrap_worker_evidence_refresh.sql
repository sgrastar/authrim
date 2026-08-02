-- Worker deployments may change while the initial handoff is still being verified. Setup may
-- refresh evidence only before acceptance and only while the handoff is otherwise repairable by a
-- Worker redeploy. Accepted evidence remains immutable.

DROP TRIGGER IF EXISTS trg_control_bootstrap_worker_evidence_expectations_immutable;

CREATE TRIGGER trg_control_bootstrap_worker_evidence_expectations_immutable
BEFORE UPDATE OF expected_deployment_id, expected_version_id, expected_settings_digest
ON control_bootstrap_worker_evidence
WHEN (
  OLD.expected_deployment_id <> NEW.expected_deployment_id OR
  OLD.expected_version_id <> NEW.expected_version_id OR
  OLD.expected_settings_digest <> NEW.expected_settings_digest
) AND NOT EXISTS (
  SELECT 1
    FROM control_bootstrap_handoffs handoff
   WHERE handoff.environment_id = OLD.environment_id
     AND (
       handoff.state IN ('creating', 'pending_verification') OR
       (handoff.state = 'blocked'
        AND handoff.verification_error_code GLOB 'control_bootstrap_worker_*')
     )
)
BEGIN
  SELECT RAISE(ABORT, 'control_bootstrap_worker_evidence_immutable');
END;
