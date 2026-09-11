-- Explicit per-destination account data selection. Existing subscriptions retain identifiers only.
ALTER TABLE webhook_configs ADD COLUMN payload_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE webhook_configs ADD COLUMN registration_states TEXT NOT NULL DEFAULT '[]';
