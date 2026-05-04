-- =============================================================================
-- Migration: Approval Notification State
-- =============================================================================
-- Created: 2026-05-02
-- Description:
--   Adds reminder/resend notification summary fields to approval steps so the
--   operator surface can enforce cooldowns and show notification progress.
-- =============================================================================

ALTER TABLE approval_request_approvals
  ADD COLUMN last_notification_action TEXT
    CHECK (last_notification_action IN ('initial', 'resend', 'remind'));

ALTER TABLE approval_request_approvals
  ADD COLUMN last_notified_at INTEGER;

ALTER TABLE approval_request_approvals
  ADD COLUMN notification_count INTEGER NOT NULL DEFAULT 1;

UPDATE approval_request_approvals
   SET last_notification_action = COALESCE(last_notification_action, 'initial'),
       last_notified_at = COALESCE(last_notified_at, requested_at),
       notification_count = COALESCE(notification_count, 1)
 WHERE last_notification_action IS NULL
    OR last_notified_at IS NULL
    OR notification_count IS NULL;
