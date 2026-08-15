const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { isWatching, countWatchers } = require('../utils/taskWatchers');

async function loadTaskAccess(taskId, userId) {
  const result = await pool.query(
    `SELECT t.id, t.project_id, t.title, p.workspace_id
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

function serializeWatcherStatus({ watching, taskId, userId, createdAt, watchersCount }) {
  return {
    watching,
    task_id: taskId,
    user_id: userId,
    created_at: createdAt,
    watchers_count: watchersCount,
  };
}

async function watchTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const existing = await isWatching(taskId, req.user.id);
    if (existing) {
      return res.status(200).json(
        serializeWatcherStatus({
          watching: true,
          taskId,
          userId: req.user.id,
          createdAt: existing.created_at,
          watchersCount: await countWatchers(taskId),
        })
      );
    }

    const inserted = await pool.query(
      `INSERT INTO task_watchers (task_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING
       RETURNING created_at`,
      [taskId, req.user.id]
    );
    const createdAt =
      inserted.rows[0]?.created_at ||
      (await isWatching(taskId, req.user.id))?.created_at;

    return res.status(200).json(
      serializeWatcherStatus({
        watching: true,
        taskId,
        userId: req.user.id,
        createdAt,
        watchersCount: await countWatchers(taskId),
      })
    );
  } catch (err) {
    console.error('Watch task error:', err);
    return res.status(500).json({ message: 'Failed to watch task' });
  }
}

async function unwatchTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    await pool.query(
      `DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2`,
      [taskId, req.user.id]
    );

    return res.status(200).json(
      serializeWatcherStatus({
        watching: false,
        taskId,
        userId: req.user.id,
        createdAt: null,
        watchersCount: await countWatchers(taskId),
      })
    );
  } catch (err) {
    console.error('Unwatch task error:', err);
    return res.status(500).json({ message: 'Failed to unwatch task' });
  }
}

module.exports = { watchTask, unwatchTask };
