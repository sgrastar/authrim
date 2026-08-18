-- Distinguish an initial verified email addition from replacement of an existing email.
-- Existing challenges predate initial additions and therefore remain replacement challenges.

ALTER TABLE identity_identifier_replacement_challenges
  ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'replacement'
    CHECK (operation_mode IN ('addition', 'replacement'));
