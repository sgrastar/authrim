-- Links operation-bound Agent elevation challenges to the existing approval/CIBA workflow.
ALTER TABLE agent_elevation_challenges ADD COLUMN approval_request_id TEXT;
ALTER TABLE agent_elevation_challenges ADD COLUMN approval_artifact_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_elevation_approval_request
  ON agent_elevation_challenges(approval_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_elevation_approval_artifact
  ON agent_elevation_challenges(approval_artifact_id);
