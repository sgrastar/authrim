-- The uses of a tenant invitation that sign-ups hold. A sign-up reserves one use when it starts
-- (counted in tenant_invitations.use_count at once, so its completion cannot lose the last use to
-- another sign-up) and applies it to the account it created when it completes. One sign-up, named
-- by holder (its email, the account it creates, or the external sign-in before the account
-- exists), holds at most one use of an invitation however often it restarts. A reservation not
-- applied by expires_at (seconds) is released and its use returned to the invitation.
-- status: 'pending' only inside the batch that writes a reservation and counts its use (so a
-- replayed batch counts nothing again), then 'reserved', then 'applied'.
-- user_id: the account the use is bound to (once the sign-up created it) or was applied to.
CREATE TABLE tenant_invitation_redemptions (
  id            TEXT PRIMARY KEY NOT NULL,
  tenant_id     TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  holder        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'applied')),
  user_id       TEXT,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE UNIQUE INDEX idx_tenant_invitation_redemptions_holder
  ON tenant_invitation_redemptions(tenant_id, invitation_id, holder);
CREATE INDEX idx_tenant_invitation_redemptions_tenant
  ON tenant_invitation_redemptions(tenant_id, id);
CREATE INDEX idx_tenant_invitation_redemptions_expiry
  ON tenant_invitation_redemptions(tenant_id, invitation_id, status, expires_at);
