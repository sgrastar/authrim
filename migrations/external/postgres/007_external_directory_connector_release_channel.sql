-- Add release channel metadata to Wordwarden connector fleet inventory.

ALTER TABLE directory_connector_instances
  ADD COLUMN IF NOT EXISTS release_channel TEXT NOT NULL DEFAULT 'stable';
