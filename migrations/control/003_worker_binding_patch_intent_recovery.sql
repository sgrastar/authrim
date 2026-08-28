-- Preserve the first Worker settings mutation timestamp independently from lease renewals.
-- This lets Control distinguish provider propagation from a request that never took effect.
ALTER TABLE control_worker_deployment_leases
  ADD COLUMN mutation_started_at INTEGER;

-- Rollback (fresh test environments only before 1.0):
-- ALTER TABLE control_worker_deployment_leases DROP COLUMN mutation_started_at;
