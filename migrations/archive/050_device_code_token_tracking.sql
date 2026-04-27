ALTER TABLE device_codes ADD COLUMN token_issued INTEGER DEFAULT 0;
ALTER TABLE device_codes ADD COLUMN token_issued_at INTEGER;
