-- Align workspaces with multi-workspace management and add membership isolation.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'workspace_name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'name'
  ) THEN
    ALTER TABLE workspaces RENAME COLUMN workspace_name TO name;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'owner_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE workspaces RENAME COLUMN owner_id TO created_by;
  END IF;
END $$;

UPDATE workspaces
SET name = LEFT(name, 100)
WHERE LENGTH(name) > 100;

ALTER TABLE workspaces
  ALTER COLUMN name TYPE VARCHAR(100);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'idx_workspaces_owner_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'idx_workspaces_created_by'
  ) THEN
    ALTER INDEX idx_workspaces_owner_id RENAME TO idx_workspaces_created_by;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_created_by ON workspaces (created_by);

CREATE TABLE IF NOT EXISTS workspace_members (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL DEFAULT 'Member',
  joined_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_members_role_check'
  ) THEN
    ALTER TABLE workspace_members
      ADD CONSTRAINT workspace_members_role_check
      CHECK (role IN ('Owner', 'Admin', 'Member'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON workspace_members (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id
  ON workspace_members (workspace_id);

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, w.created_by, 'Owner'
FROM workspaces w
WHERE w.created_by IS NOT NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;
