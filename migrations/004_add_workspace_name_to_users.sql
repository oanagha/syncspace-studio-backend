ALTER TABLE users
  ADD COLUMN IF NOT EXISTS workspace_name VARCHAR(255);

-- Backfill from workspaces for existing accounts
UPDATE users u
SET workspace_name = w.workspace_name
FROM workspaces w
WHERE w.owner_id = u.id
  AND (u.workspace_name IS NULL OR u.workspace_name = '');

ALTER TABLE users
  ALTER COLUMN workspace_name SET NOT NULL;
