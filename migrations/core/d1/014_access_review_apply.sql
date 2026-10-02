-- Access reviews apply their revocations: each item records where its entitlement lives and what
-- applying the reviewer's decision did; each review records who created and completed it and,
-- for an inactive-user review, the inactivity it was made with.

-- The store (binding) the entitlement was found in, and what it is: a role assignment id, an
-- organization id or an account (user id), by permission_type.
ALTER TABLE access_review_items ADD COLUMN store_ref TEXT;
ALTER TABLE access_review_items ADD COLUMN entitlement_ref TEXT;
-- applying: a completion claimed it (apply_claimed_at) and is making the revocation; its
-- decision cannot change meanwhile, and a claim left by an interrupted completion is taken over
-- once stale. applied: the revocation was made (or the entitlement was already gone).
-- incomplete: the revocation started and did not finish (its row may be gone, its caches or audit
-- not done): completing again finishes it, and its decision can no longer change. failed: it was
-- refused before anything changed (permission, hierarchy, a newer status change), apply_error says
-- why. skipped: approved, nothing to do.
ALTER TABLE access_review_items ADD COLUMN apply_status TEXT
  CHECK (
    apply_status IS NULL
    OR apply_status IN ('applying', 'applied', 'incomplete', 'failed', 'skipped')
  );
ALTER TABLE access_review_items ADD COLUMN apply_claimed_at TEXT;
-- When applying it first started: the time its audit entries carry, so a retry records the
-- same entries rather than new ones (and the version of an account's suspension).
ALTER TABLE access_review_items ADD COLUMN apply_first_at TEXT;
-- Claims made since applying it started (each completion that took it adds one; a refusal that
-- changed nothing clears both): above one, an earlier attempt may have changed something.
ALTER TABLE access_review_items ADD COLUMN apply_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_review_items ADD COLUMN applied_at TEXT;
ALTER TABLE access_review_items ADD COLUMN apply_error TEXT;

-- One item per entitlement in a review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_review_items_entitlement
  ON access_review_items(review_id, permission_type, entitlement_ref);

ALTER TABLE access_reviews ADD COLUMN created_by TEXT;
ALTER TABLE access_reviews ADD COLUMN completed_by TEXT;
ALTER TABLE access_reviews ADD COLUMN inactive_days INTEGER
  CHECK (inactive_days IS NULL OR (inactive_days >= 1 AND inactive_days <= 3650));
