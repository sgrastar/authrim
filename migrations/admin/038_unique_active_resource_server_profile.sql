-- A Resource Server client has exactly one active Destination Profile.
-- For pre-existing conflicts, keep the most recently updated profile active;
-- use the profile id as a deterministic tie-breaker.

UPDATE destination_profile_versions
SET lifecycle_state = 'reviewed',
    updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE lifecycle_state = 'active'
  AND profile_id IN (
    SELECT older.id
    FROM destination_profiles AS older
    WHERE older.destination_type = 'resource_server'
      AND older.owner_scope_type = 'client'
      AND older.lifecycle_state = 'active'
      AND EXISTS (
        SELECT 1
        FROM destination_profiles AS newer
        WHERE newer.tenant_id = older.tenant_id
          AND newer.destination_type = 'resource_server'
          AND newer.owner_scope_type = 'client'
          AND COALESCE(newer.owner_scope_id, '') = COALESCE(older.owner_scope_id, '')
          AND newer.lifecycle_state = 'active'
          AND (
            newer.updated_at > older.updated_at
            OR (newer.updated_at = older.updated_at AND newer.id > older.id)
          )
      )
  );

UPDATE destination_profiles AS older
SET lifecycle_state = 'retired',
    active_version_id = NULL,
    updated_at = __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE older.destination_type = 'resource_server'
  AND older.owner_scope_type = 'client'
  AND older.lifecycle_state = 'active'
  AND EXISTS (
    SELECT 1
    FROM destination_profiles AS newer
    WHERE newer.tenant_id = older.tenant_id
      AND newer.destination_type = 'resource_server'
      AND newer.owner_scope_type = 'client'
      AND COALESCE(newer.owner_scope_id, '') = COALESCE(older.owner_scope_id, '')
      AND newer.lifecycle_state = 'active'
      AND (
        newer.updated_at > older.updated_at
        OR (newer.updated_at = older.updated_at AND newer.id > older.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_destination_profiles_active_resource_server_client
  ON destination_profiles(
    CASE
      WHEN destination_type = 'resource_server'
        AND owner_scope_type = 'client'
        AND lifecycle_state = 'active'
      THEN tenant_id
      ELSE NULL
    END,
    CASE
      WHEN destination_type = 'resource_server'
        AND owner_scope_type = 'client'
        AND lifecycle_state = 'active'
      THEN COALESCE(owner_scope_id, '')
      ELSE NULL
    END
  );
