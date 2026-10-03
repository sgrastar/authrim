-- Who revoked a piece of identity assurance evidence, recorded with the revocation, so the audit
-- of a revocation (completed by a retry when it failed) names the one who revoked it.
ALTER TABLE assurance_evidence ADD COLUMN revoked_by TEXT;
