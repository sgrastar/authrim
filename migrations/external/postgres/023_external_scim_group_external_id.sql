-- Store the SCIM Group externalId attribute on roles for external PostgreSQL deployments.

ALTER TABLE roles ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Manual rollback:
-- ALTER TABLE roles DROP COLUMN external_id;
