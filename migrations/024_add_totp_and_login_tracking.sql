-- TOTP 2FA + login alert device fingerprinting
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_login_fingerprint VARCHAR(128),
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64),
  ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT;

-- Preference flag should not imply 2FA is active until enrolled
UPDATE user_preferences
SET two_factor = FALSE
WHERE two_factor IS TRUE
  AND user_id IN (
    SELECT id FROM users WHERE totp_enabled IS NOT TRUE
  );
