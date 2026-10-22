-- A sign-in at an external IdP started from an invitation: the invitation, and the use its start
-- reserved (tenant_invitation_redemptions.id). The callback applies the use to the account it
-- creates, or gives it back when the sign-in finds an existing account.
ALTER TABLE external_idp_auth_states ADD COLUMN invite_id TEXT;
ALTER TABLE external_idp_auth_states ADD COLUMN invite_reservation_id TEXT;
