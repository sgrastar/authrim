-- The tenant creation moved from POST /start to GET /status. A new row is inserted in state
-- `provisioning` with neither column below set (that is the "queued" situation: it has no tenant
-- yet). The first /status request claims it with a guarded UPDATE that sets `create_started_at`
-- and counts an attempt. Epoch seconds, like the other timestamps. No state is added, so the CHECK
-- constraint of 0001 stays valid and no table is rebuilt.
ALTER TABLE demo_tenants ADD COLUMN create_started_at INTEGER;
ALTER TABLE demo_tenants ADD COLUMN create_attempts INTEGER NOT NULL DEFAULT 0;
-- A row that the old code was still creating when this migration ran has no acceptance record. It
-- counts as one attempt already made, so it is repeated (idempotently) at most once more.
UPDATE demo_tenants
   SET create_started_at = created_at, create_attempts = 1
 WHERE state = 'provisioning' AND create_accepted_at IS NULL;
