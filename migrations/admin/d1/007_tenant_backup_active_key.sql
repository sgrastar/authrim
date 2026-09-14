-- Logical key reference: cancellation cleanup may erase the referenced ephemeral key row.
ALTER TABLE tenant_backup_operations ADD COLUMN active_key_challenge_id TEXT;
