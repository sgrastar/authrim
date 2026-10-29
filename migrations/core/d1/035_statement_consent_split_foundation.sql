-- Statement consent split foundation (additive; nothing is rebuilt, dropped or rewritten).
-- The documents people agree to stay in the tenant metadata database and the record of who
-- agreed moves to the account database, so a record has to describe what was agreed to without
-- the definition tables, and a definition has to carry the generation that closes it to new
-- agreements. The foreign keys on user_consent_records are removed by a later, separate migration.

-- Hash of the document content at the moment of agreement; NULL on rows written before this column.
ALTER TABLE user_consent_records ADD COLUMN content_hash TEXT;
ALTER TABLE consent_item_history ADD COLUMN content_hash_after TEXT;

-- Per-statement generations are the source of truth for the guards projected into each account
-- database: definition_generation moves when a version is activated or the statement is retired,
-- closed_generation moves when the statement stops accepting new agreements.
ALTER TABLE consent_statements ADD COLUMN definition_generation INTEGER NOT NULL DEFAULT 0
  CHECK (definition_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE consent_statements ADD COLUMN closed_generation INTEGER NOT NULL DEFAULT 0
  CHECK (closed_generation BETWEEN 0 AND 9007199254740991);
-- A retired statement keeps its versions, texts and every agreement made to it.
ALTER TABLE consent_statements ADD COLUMN retired_at INTEGER;
