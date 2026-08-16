const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const MIN_TITLE_LEN = 1;
const MAX_TITLE_LEN = 200;

function serializeSubtask(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    title: row.title,
    completed: Boolean(row.completed),
    position: Number(row.position) || 0,
    created_at: row.created_at,
  };
}

async function loadTaskAccess(taskId, userId) {
  const result = await pool.query(
    `SELECT t.id, t.project_id, p.workspace_id
     FROM tasks t
     INNER JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1`,
    [taskId]
  );

  if (result.rows.length === 0) {
    return { status: 404, message: 'Task not found' };
  }

  const task = result.rows[0];
  const membership = await getWorkspaceMembership(task.workspace_id, userId);
  if (!membership) {
    return { status: 403, message: "You don't have access to this project" };
  }

  return { task };
}

async function countSubtasks(taskId) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE completed)::int AS done
     FROM task_subtasks
     WHERE task_id = $1`,
    [taskId]
  );
  return {
    subtasks_total: result.rows[0]?.total || 0,
    subtasks_done: result.rows[0]?.done || 0,
  };
}

async function listSubtasks(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const result = await pool.query(
      `SELECT id, task_id, title, completed, position, created_at
       FROM task_subtasks
       WHERE task_id = $1
       ORDER BY position ASC, id ASC`,
      [taskId]
    );

    return res.status(200).json({
      subtasks: result.rows.map(serializeSubtask),
      ...(await countSubtasks(taskId)),
    });
  } catch (err) {
    console.error('List subtasks error:', err);
    return res.status(500).json({ message: 'Failed to load subtasks' });
  }
}

async function createSubtask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const title = String(req.body?.title ?? '').trim();
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }
    if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) {
      return res.status(400).json({
        message: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters`,
      });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const next = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position
       FROM task_subtasks
       WHERE task_id = $1`,
      [taskId]
    );

    const result = await pool.query(
      `INSERT INTO task_subtasks (task_id, title, position)
       VALUES ($1, $2, $3)
       RETURNING id, task_id, title, completed, position, created_at`,
      [taskId, title, next.rows[0].position]
    );

    return res.status(201).json({
      subtask: serializeSubtask(result.rows[0]),
      ...(await countSubtasks(taskId)),
    });
  } catch (err) {
    console.error('Create subtask error:', err);
    return res.status(500).json({ message: 'Failed to create subtask' });
  }
}

function hasField(body, ...keys) {
  return Boolean(body && keys.some((key) => Object.prototype.hasOwnProperty.call(body, key)));
}

async function loadSubtask(taskId, subtaskId) {
  const result = await pool.query(
    `SELECT id, task_id, title, completed, position, created_at
     FROM task_subtasks
     WHERE id = $1 AND task_id = $2`,
    [subtaskId, taskId]
  );
  return result.rows[0] || null;
}

async function updateSubtask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    const subtaskId = parseWorkspaceId(req.params.subtaskId);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (!subtaskId) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    const body = req.body ?? {};
    if (!hasField(body, 'completed', 'title')) {
      return res.status(400).json({ message: 'Provide completed or title' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const current = await loadSubtask(taskId, subtaskId);
    if (!current) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    let title = current.title;
    if (hasField(body, 'title')) {
      title = String(body.title ?? '').trim();
      if (!title) {
        return res.status(400).json({ message: 'title is required' });
      }
      if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) {
        return res.status(400).json({
          message: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters`,
        });
      }
    }

    let completed = Boolean(current.completed);
    if (hasField(body, 'completed')) {
      if (typeof body.completed !== 'boolean') {
        return res.status(400).json({ message: 'completed must be true or false' });
      }
      completed = body.completed;
    }

    const result = await pool.query(
      `UPDATE task_subtasks
       SET title = $1, completed = $2
       WHERE id = $3 AND task_id = $4
       RETURNING id, task_id, title, completed, position, created_at`,
      [title, completed, subtaskId, taskId]
    );

    return res.status(200).json({
      subtask: serializeSubtask(result.rows[0]),
      ...(await countSubtasks(taskId)),
    });
  } catch (err) {
    console.error('Update subtask error:', err);
    return res.status(500).json({ message: 'Failed to update subtask' });
  }
}

async function deleteSubtask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    const subtaskId = parseWorkspaceId(req.params.subtaskId);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (!subtaskId) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const current = await loadSubtask(taskId, subtaskId);
    if (!current) {
      return res.status(404).json({ message: 'Subtask not found' });
    }

    await pool.query(
      `DELETE FROM task_subtasks WHERE id = $1 AND task_id = $2`,
      [subtaskId, taskId]
    );
    await pool.query(
      `UPDATE task_subtasks
       SET position = position - 1
       WHERE task_id = $1 AND position > $2`,
      [taskId, current.position]
    );

    return res.status(200).json({
      message: 'Subtask deleted',
      deleted_subtask_id: subtaskId,
      ...(await countSubtasks(taskId)),
    });
  } catch (err) {
    console.error('Delete subtask error:', err);
    return res.status(500).json({ message: 'Failed to delete subtask' });
  }
}

module.exports = { listSubtasks, createSubtask, updateSubtask, deleteSubtask };
