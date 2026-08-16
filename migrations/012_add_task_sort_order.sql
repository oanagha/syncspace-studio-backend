ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY project_id, column_name
      ORDER BY created_at ASC, id ASC
    ) - 1 AS rn
  FROM tasks
)
UPDATE tasks
SET sort_order = ranked.rn
FROM ranked
WHERE tasks.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_tasks_project_column_order
  ON tasks (project_id, column_name, sort_order);
