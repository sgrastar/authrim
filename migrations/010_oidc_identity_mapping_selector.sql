-- OIDC runtime identity mapping selector stored per OAuth client.
-- The value is a JSON object with fields such as fieldMappingSetId, fieldMappingVersionId,
-- destinationNamespace, sourceProfileId, and destinationProfileId.

ALTER TABLE oauth_clients ADD COLUMN identity_mapping TEXT;
