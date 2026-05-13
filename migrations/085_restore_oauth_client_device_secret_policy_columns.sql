-- Migration: 085_restore_oauth_client_device_secret_policy_columns.sql
-- Description: Restore device secret client policy columns after the tenant-scoped oauth_clients rebuild.
--
-- Migration 077 rebuilds oauth_clients to make client_id tenant-scoped, but the
-- rebuilt table missed the columns introduced by migration 072. Client creation
-- writes these columns, so missing them breaks Admin API client provisioning.

ALTER TABLE oauth_clients ADD COLUMN device_secret_revoke_enabled INTEGER;
ALTER TABLE oauth_clients ADD COLUMN device_secret_revoke_trust_groups TEXT;
ALTER TABLE oauth_clients ADD COLUMN device_secret_introspection_enabled INTEGER;
ALTER TABLE oauth_clients ADD COLUMN device_secret_introspection_trust_groups TEXT;
