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
--              validity of the two.
--              idx_relationships_unique: the tuple key D1 holds unique (tenant, relation, source,
--              target), plus from_relation compared NULL-safe (COALESCE), which PostgreSQL lacked.
--              Rows that duplicate one another on that key are first reduced to one: the
--              smallest id survives with the longest validity among them (NULL expires_at if
--              any has none, else the latest); its other attributes are kept as they are.
--              Holds no personal data beyond what the rows already hold.
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
     ELSE GREATEST(expires_at, (
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

-- Rows that duplicate one another on the tuple key are reduced to the one with the smallest id,
-- which takes the longest validity among them (no expiry if any has none, else the latest
-- expires_at); its other attributes (permission_level, metadata, evidence) are kept as they are.
UPDATE relationships k
   SET expires_at = d.merged
  FROM (
    SELECT MIN(id) AS keep_id,
           CASE WHEN COUNT(*) > COUNT(expires_at) THEN NULL ELSE MAX(expires_at) END AS merged
      FROM relationships
     GROUP BY tenant_id, relationship_type, from_type, from_id, to_type, to_id,
              COALESCE(from_relation, '')
    HAVING COUNT(*) > 1
  ) d
 WHERE k.id = d.keep_id;

DELETE FROM relationships a
 USING relationships b
 WHERE a.tenant_id = b.tenant_id
   AND a.relationship_type = b.relationship_type
   AND a.from_type = b.from_type
   AND a.from_id = b.from_id
   AND a.to_type = b.to_type
   AND a.to_id = b.to_id
   AND COALESCE(a.from_relation, '') = COALESCE(b.from_relation, '')
   AND a.id > b.id;

CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships (
    tenant_id,
    relationship_type,
    from_type,
    from_id,
    to_type,
    to_id,
    (COALESCE(from_relation, ''))
  );

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- DROP INDEX idx_relationships_unique;
-- ALTER TABLE relationships DROP COLUMN from_relation;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 020
-- =============================================================================
