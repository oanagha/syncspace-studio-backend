CREATE TABLE IF NOT EXISTS workspace_invitations (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email        VARCHAR(255) NOT NULL,
  role         VARCHAR(20) NOT NULL,
  invited_by   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invitations_role_check'
  ) THEN
    ALTER TABLE workspace_invitations
      ADD CONSTRAINT workspace_invitations_role_check
      CHECK (role IN ('Admin', 'Member', 'Guest'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invitations_status_check'
  ) THEN
    ALTER TABLE workspace_invitations
      ADD CONSTRAINT workspace_invitations_status_check
      CHECK (status IN ('pending', 'accepted', 'revoked'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_pending_unique
  ON workspace_invitations (workspace_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace_id
  ON workspace_invitations (workspace_id);
