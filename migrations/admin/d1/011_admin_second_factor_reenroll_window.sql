-- A short window, opened by the last-resort recovery (Cloudflare authority through the setup
-- tool), in which an admin whose second factors were all revoked may register a first factor
-- again with a fresh passkey alone. Epoch milliseconds; NULL means no window. It is cleared when a
-- factor is registered through it, so it serves one registration. Revoked factors stay as rows.
ALTER TABLE admin_users ADD COLUMN second_factor_reenroll_until INTEGER;
