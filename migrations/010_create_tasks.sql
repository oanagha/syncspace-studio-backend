CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT,
  column_name VARCHAR(50) NOT NULL DEFAULT 'Todo',
  priority    VARCHAR(20) NOT NULL DEFAULT 'Medium',
  due_date    DATE,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_column_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_column_check
      CHECK (column_name IN ('Backlog', 'Todo', 'In Progress', 'Review', 'Done'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_priority_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_priority_check
      CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_column_name ON tasks (column_name);
