const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const {
  ensureDefaultColumns,
  serializeColumn,
} = require('./column.controller');
const {
  TASK_SELECT,
  SUBTASK_COUNTS,
  serializeTask,
} = require('./task.controller');

const RECENT_ACTIVITY_LIMIT = 8;

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

function serializeAssignee(row) {
  return {
    id: row.id,
    name: row.full_name || row.name || '',
  };
}

async function assertProjectAccess(projectId, userId) {
  const result = await pool.query(
    `SELECT id, workspace_id, title, description, color, status,
            progress, completed_tasks, total_tasks, deadline::text AS deadline
     FROM projects
     WHERE id = $1`,
    [projectId]
  );

  if (result.rows.length === 0) {
    return { status: 404, message: 'Project not found' };
  }

  const project = result.rows[0];
  const membership = await getWorkspaceMembership(project.workspace_id, userId);
  if (!membership) {
    return { status: 403, message: "You don't have access to this project" };
  }

  return { project, membership };
}

async function getBoard(req, res) {
  try {
    const projectId = parseWorkspaceId(req.params.projectId);
    if (!projectId) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const access = await assertProjectAccess(projectId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    await ensureDefaultColumns(pool, projectId);

    const [
      columnsResult,
      tasksResult,
      subtasksResult,
      membersResult,
      extrasResult,
      recentResult,
      commentCounts,
      watcherCounts,
      watchedRows,
    ] = await Promise.all([
      pool.query(
        `SELECT id, project_id, name, color, position
         FROM project_columns
         WHERE project_id = $1
         ORDER BY position ASC, id ASC`,
        [projectId]
      ),
      pool.query(
        `SELECT ${TASK_SELECT}
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         ${SUBTASK_COUNTS}
         WHERE t.project_id = $1
         ORDER BY t.sort_order ASC, t.created_at ASC`,
        [projectId]
      ),
      pool.query(
        `SELECT ts.id, ts.task_id, ts.title, ts.completed, ts.position, ts.created_at
         FROM task_subtasks ts
         INNER JOIN tasks t ON t.id = ts.task_id
         WHERE t.project_id = $1
         ORDER BY ts.position ASC, ts.id ASC`,
        [projectId]
      ),
      pool.query(
        `SELECT u.id, u.full_name
         FROM workspace_members wm
         INNER JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1
         ORDER BY u.full_name ASC`,
        [access.project.workspace_id]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM tasks WHERE project_id = $1) AS total_tasks,
           (SELECT COUNT(*)::int FROM tasks WHERE project_id = $1 AND column_name = 'Done') AS completed_tasks,
           (SELECT COUNT(*)::int FROM tasks WHERE project_id = $1 AND column_name = 'In Progress') AS in_progress_tasks,
           (SELECT COUNT(*)::int
              FROM tasks
             WHERE project_id = $1
               AND due_date IS NOT NULL
               AND due_date < CURRENT_DATE
               AND column_name <> 'Done') AS overdue_tasks,
           (SELECT COUNT(*)::int
              FROM task_comments c
              INNER JOIN tasks t ON t.id = c.task_id
             WHERE t.project_id = $1) AS comments_count,
           (SELECT COUNT(*)::int
              FROM task_watchers w
              INNER JOIN tasks t ON t.id = w.task_id
             WHERE t.project_id = $1) AS watchers_count,
           (SELECT COUNT(*)::int
              FROM task_subtasks s
              INNER JOIN tasks t ON t.id = s.task_id
             WHERE t.project_id = $1) AS subtasks_total,
           (SELECT COUNT(*)::int
              FROM task_subtasks s
              INNER JOIN tasks t ON t.id = s.task_id
             WHERE t.project_id = $1 AND s.completed) AS subtasks_done`,
        [projectId]
      ),
      pool.query(
        `SELECT c.id, c.task_id, c.body, c.created_at, c.user_id,
                u.full_name AS user_name, t.title AS task_title
         FROM task_comments c
         INNER JOIN tasks t ON t.id = c.task_id
         INNER JOIN users u ON u.id = c.user_id
         WHERE t.project_id = $1
         ORDER BY c.created_at DESC
         LIMIT $2`,
        [projectId, RECENT_ACTIVITY_LIMIT]
      ),
      pool.query(
        `SELECT c.task_id, COUNT(*)::int AS total
         FROM task_comments c
         INNER JOIN tasks t ON t.id = c.task_id
         WHERE t.project_id = $1
         GROUP BY c.task_id`,
        [projectId]
      ),
      pool.query(
        `SELECT w.task_id, COUNT(*)::int AS total
         FROM task_watchers w
         INNER JOIN tasks t ON t.id = w.task_id
         WHERE t.project_id = $1
         GROUP BY w.task_id`,
        [projectId]
      ),
      pool.query(
        `SELECT w.task_id
         FROM task_watchers w
         INNER JOIN tasks t ON t.id = w.task_id
         WHERE t.project_id = $1 AND w.user_id = $2`,
        [projectId, req.user.id]
      ),
    ]);

    const subtasksByTask = new Map();
    for (const row of subtasksResult.rows) {
      const list = subtasksByTask.get(row.task_id) || [];
      list.push(serializeSubtask(row));
      subtasksByTask.set(row.task_id, list);
    }

    const commentsByTask = new Map(
      commentCounts.rows.map((row) => [row.task_id, row.total])
    );
    const watchersByTask = new Map(
      watcherCounts.rows.map((row) => [row.task_id, row.total])
    );
    const watchingIds = new Set(watchedRows.rows.map((row) => row.task_id));

    const columns = columnsResult.rows.map((row) => {
      const column = serializeColumn(row);
      return {
        ...column,
        task_count: tasksResult.rows.filter((task) => task.column_name === column.title)
          .length,
      };
    });

    const tasks = tasksResult.rows.map((row) => {
      const task = serializeTask(row);
      const subtasks = subtasksByTask.get(task.id) || [];
      return {
        ...task,
        subtasks,
        comments_count: commentsByTask.get(task.id) || 0,
        watchers_count: watchersByTask.get(task.id) || 0,
        watching: watchingIds.has(task.id),
      };
    });

    const extras = extrasResult.rows[0] || {};
    const activity = {
      total_tasks: extras.total_tasks || 0,
      completed_tasks: extras.completed_tasks || 0,
      in_progress_tasks: extras.in_progress_tasks || 0,
      overdue_tasks: extras.overdue_tasks || 0,
      comments_count: extras.comments_count || 0,
      watchers_count: extras.watchers_count || 0,
      subtasks_done: extras.subtasks_done || 0,
      subtasks_total: extras.subtasks_total || 0,
      recent: recentResult.rows.map((row) => ({
        id: row.id,
        type: 'comment',
        task_id: row.task_id,
        task_title: row.task_title,
        title: `${row.user_name || 'Someone'} commented on ${row.task_title}`,
        body: String(row.body || '').slice(0, 280),
        user: { id: row.user_id, name: row.user_name || '' },
        created_at: row.created_at,
      })),
    };

    return res.status(200).json({
      project_id: projectId,
      columns,
      tasks,
      assignees: membersResult.rows.map(serializeAssignee),
      activity,
    });
  } catch (err) {
    console.error('Get board error:', err);
    return res.status(500).json({ message: 'Failed to load board' });
  }
}

module.exports = { getBoard };
