ALTER TABLE project_columns
  ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT '#14B8A6';

UPDATE project_columns SET color = '#64748B' WHERE name = 'Backlog';
UPDATE project_columns SET color = '#1A4A6E' WHERE name = 'Todo';
UPDATE project_columns SET color = '#2D8A9E' WHERE name = 'In Progress';
UPDATE project_columns SET color = '#D9A441' WHERE name = 'Review';
UPDATE project_columns SET color = '#2F9E7D' WHERE name = 'Done';

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_column_check;
