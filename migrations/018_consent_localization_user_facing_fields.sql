-- Add localized user-facing consent explanation fields.

ALTER TABLE consent_statement_localizations ADD COLUMN processing_purpose TEXT;
ALTER TABLE consent_statement_localizations ADD COLUMN withdrawal_impact TEXT;
