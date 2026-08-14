const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const MIN_TITLE_LEN = 3;
const MAX_TITLE_LEN = 200;
const ALLOWED_COLUMNS = new Set(['Backlog', 'Todo', 'In Progress', 'Review', 'Done']);
const ALLOWED_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Urgent']);

function serializeTask(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? '',
    column: row.column_name,
    priority: row.priority,
    due_date: row.due_date || null,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

async function assertProjectAccess(projectId, userId) {
  const result = await pool.query(
    `SELECT id, workspace_id FROM projects WHERE id = $1`,
    [projectId]
  );

  if (result.rows.length === 0) {
    return { status: 404, message: 'Project not found' };
  }

  const membership = await getWorkspaceMembership(result.rows[0].workspace_id, userId);
  if (!membership) {
    return { status: 403, message: "You don't have access to this project" };
  }

  return { project: result.rows[0], membership };
}

async function refreshProjectTaskCounts(projectId) {
  await pool.query(
    `UPDATE projects
     SET total_tasks = stats.total_count,
         completed_tasks = stats.done_count,
         progress = CASE
           WHEN stats.total_count = 0 THEN 0
           ELSE ROUND(stats.done_count * 100.0 / stats.total_count)
         END,
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE column_name = 'Done')::int AS done_count
       FROM tasks
       WHERE project_id = $1
     ) AS stats
     WHERE projects.id = $1`,
    [projectId]
  );
}

function validateTitle(raw) {
  const title = String(raw ?? '').trim();
  if (!title) return { error: 'title is required' };
  if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) {
    return { error: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters` };
  }
  return { title };
}

async function listTasks(req, res) {
  try {
    const projectId = parseWorkspaceId(req.params.id);
    if (!projectId) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const access = await assertProjectAccess(projectId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const result = await pool.query(
      `SELECT id, project_id, title, description, column_name, priority,
              due_date::text AS due_date, created_by, created_at
       FROM tasks
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );

    return res.status(200).json({ tasks: result.rows.map(serializeTask) });
  } catch (err) {
    console.error('List tasks error:', err);
    return res.status(500).json({ message: 'Failed to load tasks' });
  }
}

async function createTask(req, res) {
  try {
    const projectId = parseWorkspaceId(req.params.id);
    if (!projectId) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const access = await assertProjectAccess(projectId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const { title, error } = validateTitle(req.body?.title);
    if (error) {
      return res.status(400).json({ message: error });
    }

    const column = String(req.body?.column ?? 'Todo').trim();
    if (!ALLOWED_COLUMNS.has(column)) {
      return res.status(400).json({ message: 'Invalid column' });
    }

    const priority = String(req.body?.priority ?? 'Medium').trim();
    if (!ALLOWED_PRIORITIES.has(priority)) {
      return res.status(400).json({ message: 'Invalid priority' });
    }

    let dueDate = null;
    if (req.body?.due_date) {
      const raw = String(req.body.due_date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return res.status(400).json({ message: 'due_date must be YYYY-MM-DD' });
      }
      dueDate = raw;
    }

    const description =
      req.body?.description === undefined || req.body?.description === null
        ? null
        : String(req.body.description).trim() || null;

    const result = await pool.query(
      `INSERT INTO tasks (project_id, title, description, column_name, priority, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, project_id, title, description, column_name, priority,
                 due_date::text AS due_date, created_by, created_at`,
      [projectId, title, description, column, priority, dueDate, req.user.id]
    );

    await refreshProjectTaskCounts(projectId);

    return res.status(201).json({ task: serializeTask(result.rows[0]) });
  } catch (err) {
    console.error('Create task error:', err);
    return res.status(500).json({ message: 'Failed to create task' });
  }
}

function parseOptionalDueDate(raw, fallback) {
  if (raw === undefined) return { dueDate: fallback };
  if (raw === null || String(raw).trim() === '') return { dueDate: null };
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: 'due_date must be YYYY-MM-DD' };
  }
  return { dueDate: value };
}

async function updateTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const existing = await pool.query(
      `SELECT id, project_id, title, description, column_name, priority, due_date::text AS due_date
       FROM tasks
       WHERE id = $1`,
      [taskId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const current = existing.rows[0];
    const access = await assertProjectAccess(current.project_id, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    let title = current.title;
    if (req.body?.title !== undefined) {
      const validated = validateTitle(req.body.title);
      if (validated.error) {
        return res.status(400).json({ message: validated.error });
      }
      title = validated.title;
    }

    let column = current.column_name;
    if (req.body?.column !== undefined) {
      column = String(req.body.column).trim();
      if (!ALLOWED_COLUMNS.has(column)) {
        return res.status(400).json({ message: 'Invalid column' });
      }
    }

    let priority = current.priority;
    if (req.body?.priority !== undefined) {
      priority = String(req.body.priority).trim();
      if (!ALLOWED_PRIORITIES.has(priority)) {
        return res.status(400).json({ message: 'Invalid priority' });
      }
    }

    let description = current.description;
    if (req.body?.description !== undefined) {
      description =
        req.body.description === null ? null : String(req.body.description).trim() || null;
    }

    const due = parseOptionalDueDate(req.body?.due_date, current.due_date || null);
    if (due.error) {
      return res.status(400).json({ message: due.error });
    }

    const result = await pool.query(
      `UPDATE tasks
       SET title = $1,
           description = $2,
           column_name = $3,
           priority = $4,
           due_date = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, project_id, title, description, column_name, priority,
                 due_date::text AS due_date, created_by, created_at`,
      [title, description, column, priority, due.dueDate, taskId]
    );

    await refreshProjectTaskCounts(current.project_id);

    return res.status(200).json({ task: serializeTask(result.rows[0]) });
  } catch (err) {
    console.error('Update task error:', err);
    return res.status(500).json({ message: 'Failed to update task' });
  }
}

module.exports = { listTasks, createTask, updateTask };
