-- The lowest identity assurance level (IAL) a person must have been proofed at to be authorized by
-- or issued tokens for this client (NIST SP 800-63A). NULL: no minimum of the client's own. A
-- client's minimum applies whether or not tenant-wide assurance is on; existing clients keep NULL,
-- so nothing changes for them.
ALTER TABLE oauth_clients ADD COLUMN minimum_ial TEXT
  CHECK (minimum_ial IS NULL OR minimum_ial IN ('IAL1', 'IAL2', 'IAL3'));
