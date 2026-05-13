-- Migration: 086_add_oauth_client_description.sql
-- Description: Add optional admin memo/description to OAuth clients.

ALTER TABLE oauth_clients ADD COLUMN description TEXT;
