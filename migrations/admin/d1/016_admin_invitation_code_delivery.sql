-- How an admin invitation's enrollment code reached the person invited: 'email' (the code is sent
-- to the invited address, the only way before) or 'response' (a trusted machine principal received
-- the code in the API response and hands it on; nothing was e-mailed). An invitation handed over
-- this way does not prove that the invited address is the person's, so accepting it creates the
-- admin with the e-mail unverified. Existing rows were all sent by e-mail.
ALTER TABLE admin_invitations
  ADD COLUMN code_delivery TEXT NOT NULL DEFAULT 'email' CHECK (code_delivery IN ('email', 'response'));
