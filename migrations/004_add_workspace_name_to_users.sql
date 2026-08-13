ALTER TABLE users
  ADD COLUMN IF NOT EXISTS workspace_name VARCHAR(255);

-- Backfill from workspaces for existing accounts (supports pre- and post-007 column names)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'workspace_name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'owner_id'
  ) THEN
    UPDATE users u
    SET workspace_name = w.workspace_name
    FROM workspaces w
    WHERE w.owner_id = u.id
      AND (u.workspace_name IS NULL OR u.workspace_name = '');
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'created_by'
  ) THEN
    UPDATE users u
    SET workspace_name = w.name
    FROM workspaces w
    WHERE w.created_by = u.id
      AND (u.workspace_name IS NULL OR u.workspace_name = '');
  END IF;
END $$;

ALTER TABLE users
  ALTER COLUMN workspace_name SET NOT NULL;
