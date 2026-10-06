-- A user's withdrawals of a client's consent, kept with the user's consents. Every withdrawal
-- increments generation; authorization codes, device and CIBA approvals and refresh-token families
-- record the generation they were granted under and are refused once it has moved on. revoked_at
-- (ms, only ever moving later) refuses what was issued before a withdrawal without recording a
-- generation, and consents a cache still holds from before it.
CREATE TABLE oauth_client_consent_revocations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, client_id)
);

-- The generation a consent was given under. A consent recorded while a withdrawal moved the
-- generation on (an approval racing the withdrawal) carries an earlier one and counts as absent.
ALTER TABLE oauth_client_consents ADD COLUMN consent_generation INTEGER NOT NULL DEFAULT 0;
