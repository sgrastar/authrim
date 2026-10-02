-- Identity assurance evidence (the IAL a subject was proofed at), as in the D1 core schema.
-- PostgreSQL's baseline lacks the table, so a tenant whose people live in PostgreSQL could not
-- record or read their IAL. Same columns and index as D1; times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS assurance_evidence (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL DEFAULT 'default',
 subject_id TEXT,
 binding_id TEXT,
 evidence_type TEXT NOT NULL,
 issuer_ref TEXT,
 assurance_framework TEXT,
 assurance_level TEXT,
 evidence_hash TEXT,
 evidence_storage_ref TEXT,
 verified_at BIGINT,
 expires_at BIGINT,
 revoked_at BIGINT,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assurance_evidence_subject
 ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at);
