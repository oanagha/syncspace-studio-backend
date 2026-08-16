CREATE TABLE IF NOT EXISTS task_watchers (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_watchers_task_id ON task_watchers (task_id);
CREATE INDEX IF NOT EXISTS idx_task_watchers_user_id ON task_watchers (user_id);
