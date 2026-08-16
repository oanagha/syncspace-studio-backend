CREATE TABLE IF NOT EXISTS workspace_files (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id    INTEGER REFERENCES projects (id) ON DELETE SET NULL,
  task_id       INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
  uploaded_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL,
  mime_type     VARCHAR(120) NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  storage_key   TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_id
  ON workspace_files (workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_files_project_id
  ON workspace_files (project_id);

CREATE INDEX IF NOT EXISTS idx_workspace_files_task_id
  ON workspace_files (task_id);

CREATE INDEX IF NOT EXISTS idx_workspace_files_created_at
  ON workspace_files (created_at DESC);
