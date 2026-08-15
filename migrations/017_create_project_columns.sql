CREATE TABLE IF NOT EXISTS project_columns (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name       VARCHAR(50) NOT NULL,
  position   INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_columns_project_position
  ON project_columns (project_id, position);

INSERT INTO project_columns (project_id, name, position)
SELECT p.id, c.name, c.position
FROM projects p
CROSS JOIN (
  VALUES
    ('Backlog', 0),
    ('Todo', 1),
    ('In Progress', 2),
    ('Review', 3),
    ('Done', 4)
) AS c(name, position)
WHERE NOT EXISTS (
  SELECT 1 FROM project_columns pc WHERE pc.project_id = p.id
);
