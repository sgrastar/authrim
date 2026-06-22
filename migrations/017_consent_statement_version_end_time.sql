-- Add optional end time for consent statement versions.

ALTER TABLE consent_statement_versions ADD COLUMN effective_until INTEGER;
