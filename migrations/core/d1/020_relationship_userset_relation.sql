-- Migration: 020_relationship_userset_relation.sql
-- Description: relationships.from_relation: the relation of a userset source. A group tuple
--              (from_type = 'group') is the userset "every effective member of the group" and
--              carries from_relation = 'member'; every other tuple has NULL. Existing group tuples
--              are left with NULL: they stay inert (the relationship check matches a group tuple
--              only with 'member') until they are written again through the guarded APIs
--              (/api/rebac/write, the Admin tuples API), which check the group's standing
--              (role-grant permission, no self-writable service group below it). Deployment note:
--              such rows are listed (Admin API: inactive_legacy) but grant nothing until re-saved.
--              Data fix: direct-subject tuples older writes stored with from_type = 'user' are
--              stored as 'subject' (the type the relationship check matches); a 'user' row that
--              duplicates a 'subject' row is removed first, the 'subject' row taking the longer
--              validity of the two (idx_relationships_unique would refuse
--              the update). Holds no personal data beyond what the rows already hold.
-- Author: @authrim
-- Date: 2026-11-28

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE relationships ADD COLUMN from_relation TEXT;

-- A `subject` row with a legacy `user` twin keeps the longer validity of the two (no expiry if
-- either has none, else the later expires_at); its other attributes are kept as they are.
UPDATE relationships
   SET expires_at = CASE
     WHEN expires_at IS NULL THEN NULL
     WHEN EXISTS (
       SELECT 1 FROM relationships u
        WHERE u.from_type = 'user' AND u.tenant_id = relationships.tenant_id
            AND u.relationship_type = relationships.relationship_type
            AND u.from_id = relationships.from_id
            AND u.to_type = relationships.to_type
            AND u.to_id = relationships.to_id AND u.expires_at IS NULL
     ) THEN NULL
     ELSE MAX(expires_at, (
       SELECT MAX(u.expires_at) FROM relationships u
        WHERE u.from_type = 'user' AND u.tenant_id = relationships.tenant_id
            AND u.relationship_type = relationships.relationship_type
            AND u.from_id = relationships.from_id
            AND u.to_type = relationships.to_type
            AND u.to_id = relationships.to_id
     ))
   END
 WHERE from_type = 'subject'
   AND EXISTS (
     SELECT 1 FROM relationships u WHERE u.from_type = 'user' AND u.tenant_id = relationships.tenant_id
            AND u.relationship_type = relationships.relationship_type
            AND u.from_id = relationships.from_id
            AND u.to_type = relationships.to_type
            AND u.to_id = relationships.to_id
   );

DELETE FROM relationships
 WHERE from_type = 'user'
   AND EXISTS (
     SELECT 1 FROM relationships s
      WHERE s.tenant_id = relationships.tenant_id
        AND s.relationship_type = relationships.relationship_type
        AND s.from_type = 'subject'
        AND s.from_id = relationships.from_id
        AND s.to_type = relationships.to_type
        AND s.to_id = relationships.to_id
   );

UPDATE relationships SET from_type = 'subject' WHERE from_type = 'user';

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- ALTER TABLE relationships DROP COLUMN from_relation;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 020
-- =============================================================================
