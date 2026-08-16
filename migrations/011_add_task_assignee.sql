ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assignee_id INTEGER REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks (assignee_id);
