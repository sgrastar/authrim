-- Add release channel metadata to Wordwarden connector fleet inventory.

ALTER TABLE directory_connector_instances
  ADD COLUMN release_channel TEXT NOT NULL DEFAULT 'stable';
