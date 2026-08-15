CREATE TABLE IF NOT EXISTS notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces (id) ON DELETE CASCADE,
  type         VARCHAR(50) NOT NULL DEFAULT 'mention',
  title        VARCHAR(255) NOT NULL,
  body         TEXT,
  task_id      INTEGER REFERENCES tasks (id) ON DELETE CASCADE,
  comment_id   INTEGER REFERENCES task_comments (id) ON DELETE CASCADE,
  read_at      TIMESTAMP,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_task_id ON notifications (task_id);
