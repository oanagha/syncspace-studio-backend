const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const MIN_TITLE_LEN = 3;
const MAX_TITLE_LEN = 200;
const PRIORITY_MAP = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
const {
  ensureDefaultColumns,
  findProjectColumn,
} = require('./column.controller');
const {
  getActorName,
  isWatching,
  notifyTaskWatchers,
} = require('../utils/taskWatchers');

function pickField(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] !== undefined && body?.[key] !== null) {
      return body[key];
    }
  }
  return undefined;
}

const TASK_SELECT = `
  t.id, t.project_id, t.title, t.description, t.column_name, t.priority,
  t.due_date::text AS due_date, t.assignee_id, t.sort_order, t.created_by, t.created_at,
  u.full_name AS assignee_name,
  COALESCE(s.subtask_total, 0)::int AS subtask_total,
  COALESCE(s.subtask_done, 0)::int AS subtask_done
`;

const SUBTASK_COUNTS = `
  LEFT JOIN (
    SELECT
      task_id,
      COUNT(*)::int AS subtask_total,
      COUNT(*) FILTER (WHERE completed)::int AS subtask_done
    FROM task_subtasks
    GROUP BY task_id
  ) s ON s.task_id = t.id
`;

function serializeTask(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? '',
    column: row.column_name,
    priority: row.priority,
    due_date: row.due_date || null,
    assignee_id: row.assignee_id || null,
    assignee: row.assignee_id
      ? { id: row.assignee_id, name: row.assignee_name || '' }
      : null,
    order: Number(row.sort_order) || 0,
    created_by: row.created_by,
    created_at: row.created_at,
    subtasks_done: Number(row.subtask_done) || 0,
    subtasks_total: Number(row.subtask_total) || 0,
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
      `SELECT ${TASK_SELECT}
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       ${SUBTASK_COUNTS}
       WHERE t.project_id = $1
       ORDER BY t.sort_order ASC, t.created_at ASC`,
      [projectId]
    );

    return res.status(200).json({ tasks: result.rows.map(serializeTask) });
  } catch (err) {
    console.error('List tasks error:', err);
    return res.status(500).json({ message: 'Failed to load tasks' });
  }
}

async function resolveAssignee(raw, workspaceId) {
  if (raw === undefined || raw === null || raw === '') {
    return { assigneeId: null };
  }

  const assigneeId = parseWorkspaceId(raw);
  if (!assigneeId) {
    return { error: 'Invalid assigneeId' };
  }

  const membership = await getWorkspaceMembership(workspaceId, assigneeId);
  if (!membership) {
    return { error: 'Assignee must be a workspace member' };
  }

  return { assigneeId };
}

async function createTask(req, res) {
  try {
    const projectId = parseWorkspaceId(
      pickField(req.body, 'projectId', 'project_id') ?? req.params.id
    );
    if (!projectId) {
      return res.status(400).json({ message: 'projectId is required' });
    }

    const access = await assertProjectAccess(projectId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const { title, error } = validateTitle(req.body?.title);
    if (error) {
      return res.status(400).json({ message: error });
    }

    const column = String(
      pickField(req.body, 'columnId', 'column_id', 'column') ?? 'Todo'
    ).trim();
    await ensureDefaultColumns(pool, projectId);
    if (!(await findProjectColumn(projectId, column))) {
      return res.status(400).json({ message: 'Invalid columnId' });
    }

    const priorityResult = normalizePriority(req.body?.priority ?? 'Medium');
    if (priorityResult.error) {
      return res.status(400).json({ message: priorityResult.error });
    }
    const priority = priorityResult.priority;

    const dueRaw = pickField(req.body, 'dueDate', 'due_date');
    let dueDate = null;
    if (dueRaw) {
      const raw = String(dueRaw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return res.status(400).json({ message: 'dueDate must be YYYY-MM-DD' });
      }
      dueDate = raw;
    }

    const description =
      req.body?.description === undefined || req.body?.description === null
        ? null
        : String(req.body.description).trim() || null;

    const assignee = await resolveAssignee(
      pickField(req.body, 'assigneeId', 'assignee_id'),
      access.project.workspace_id
    );
    if (assignee.error) {
      return res.status(400).json({ message: assignee.error });
    }

    const nextOrder = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM tasks
       WHERE project_id = $1 AND column_name = $2`,
      [projectId, column]
    );

    const result = await pool.query(
      `INSERT INTO tasks (
         project_id, title, description, column_name, priority, due_date,
         assignee_id, sort_order, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        projectId,
        title,
        description,
        column,
        priority,
        dueDate,
        assignee.assigneeId,
        nextOrder.rows[0].next_order,
        req.user.id,
      ]
    );

    const created = await pool.query(
      `SELECT ${TASK_SELECT}
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       ${SUBTASK_COUNTS}
       WHERE t.id = $1`,
      [result.rows[0].id]
    );

    await refreshProjectTaskCounts(projectId);

    return res.status(201).json({ task: serializeTask(created.rows[0]) });
  } catch (err) {
    console.error('Create task error:', err);
    return res.status(500).json({ message: 'Failed to create task' });
  }
}

function hasField(body, ...keys) {
  return Boolean(body && keys.some((key) => Object.prototype.hasOwnProperty.call(body, key)));
}

function parseOptionalDueDate(raw, fallback) {
  if (raw === undefined) return { dueDate: fallback };
  return parseDueDate(raw, { allowPast: true, allowEmpty: true });
}

function normalizePriority(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: 'priority is required' };
  }

  const priority = PRIORITY_MAP[String(raw).trim().toLowerCase()];
  if (!priority) {
    return { error: 'priority must be low, medium, high, or urgent' };
  }

  return { priority };
}

function todayLocalDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function parseDueDate(raw, { allowPast = true, allowEmpty = true } = {}) {
  if (raw === null || String(raw).trim() === '') {
    if (!allowEmpty) {
      return { error: 'dueDate is required' };
    }
    return { dueDate: null };
  }

  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: 'dueDate must be a valid date (YYYY-MM-DD)' };
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return { error: 'dueDate must be a valid date (YYYY-MM-DD)' };
  }

  if (!allowPast && value < todayLocalDate()) {
    return { error: 'dueDate cannot be in the past' };
  }

  return { dueDate: value };
}

async function getTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const task = await loadSerializedTask(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await assertProjectAccess(task.project_id, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const watching = Boolean(await isWatching(taskId, req.user.id));
    return res.status(200).json({ task: { ...task, watching } });
  } catch (err) {
    console.error('Get task error:', err);
    return res.status(500).json({ message: 'Failed to load task' });
  }
}

async function loadSerializedTask(taskId) {
  const result = await pool.query(
    `SELECT ${TASK_SELECT}
     FROM tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
     ${SUBTASK_COUNTS}
     WHERE t.id = $1`,
    [taskId]
  );
  return result.rows[0] ? serializeTask(result.rows[0]) : null;
}

async function updateTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const existing = await pool.query(
      `SELECT id, project_id, title, description, column_name, priority,
              due_date::text AS due_date, assignee_id, sort_order
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
    let sortOrder = current.sort_order ?? 0;
    if (hasField(req.body, 'columnId', 'column_id', 'column')) {
      column = String(
        pickField(req.body, 'columnId', 'column_id', 'column') ?? ''
      ).trim();
      await ensureDefaultColumns(pool, current.project_id);
      if (!(await findProjectColumn(current.project_id, column))) {
        return res.status(400).json({ message: 'Invalid columnId' });
      }
      if (column !== current.column_name) {
        const nextOrder = await pool.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
           FROM tasks
           WHERE project_id = $1 AND column_name = $2 AND id <> $3`,
          [current.project_id, column, taskId]
        );
        sortOrder = nextOrder.rows[0].next_order;
      }
    }

    let priority = current.priority;
    if (req.body?.priority !== undefined) {
      const priorityResult = normalizePriority(req.body.priority);
      if (priorityResult.error) {
        return res.status(400).json({ message: priorityResult.error });
      }
      priority = priorityResult.priority;
    }

    let description = current.description;
    if (req.body?.description !== undefined) {
      description =
        req.body.description === null ? null : String(req.body.description).trim() || null;
    }

    const due = parseOptionalDueDate(
      hasField(req.body, 'dueDate', 'due_date')
        ? pickField(req.body, 'dueDate', 'due_date') ?? null
        : undefined,
      current.due_date || null
    );
    if (due.error) {
      return res.status(400).json({ message: due.error });
    }

    let assigneeId = current.assignee_id || null;
    if (hasField(req.body, 'assigneeId', 'assignee_id')) {
      const assignee = await resolveAssignee(
        pickField(req.body, 'assigneeId', 'assignee_id') ?? null,
        access.project.workspace_id
      );
      if (assignee.error) {
        return res.status(400).json({ message: assignee.error });
      }
      assigneeId = assignee.assigneeId;
    }

    await pool.query(
      `UPDATE tasks
       SET title = $1,
           description = $2,
           column_name = $3,
           priority = $4,
           due_date = $5,
           assignee_id = $6,
           sort_order = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [title, description, column, priority, due.dueDate, assigneeId, sortOrder, taskId]
    );

    await refreshProjectTaskCounts(current.project_id);

    return res.status(200).json({ task: await loadSerializedTask(taskId) });
  } catch (err) {
    console.error('Update task error:', err);
    return res.status(500).json({ message: 'Failed to update task' });
  }
}

async function assignTask(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!hasField(req.body, 'assigneeId', 'assignee_id')) {
      return res.status(400).json({ message: 'assigneeId is required' });
    }

    const existing = await pool.query(
      `SELECT id, project_id FROM tasks WHERE id = $1`,
      [taskId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await assertProjectAccess(existing.rows[0].project_id, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const assignee = await resolveAssignee(
      pickField(req.body, 'assigneeId', 'assignee_id') ?? null,
      access.project.workspace_id
    );
    if (assignee.error) {
      return res.status(400).json({ message: assignee.error });
    }

    await pool.query(
      `UPDATE tasks
       SET assignee_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [assignee.assigneeId, taskId]
    );

    const task = await loadSerializedTask(taskId);
    try {
      const actorName = await getActorName(req.user.id);
      await notifyTaskWatchers({
        taskId,
        workspaceId: access.project.workspace_id,
        actorId: req.user.id,
        type: 'assignment',
        title: task.assignee
          ? `${actorName} assigned ${task.title}`
          : `${actorName} unassigned ${task.title}`,
        body: task.assignee ? `Assigned to ${task.assignee.name}` : 'Unassigned',
      });
    } catch (notifyErr) {
      console.error('Assign notification error:', notifyErr.message);
    }

    return res.status(200).json({ task });
  } catch (err) {
    console.error('Assign task error:', err);
    return res.status(500).json({ message: 'Failed to assign task' });
  }
}

async function loadTaskForUpdate(taskId, userId) {
  const existing = await pool.query(
    `SELECT id, project_id FROM tasks WHERE id = $1`,
    [taskId]
  );
  if (existing.rows.length === 0) {
    return { status: 404, message: 'Task not found' };
  }

  const access = await assertProjectAccess(existing.rows[0].project_id, userId);
  if (access.status) {
    return access;
  }

  return { task: existing.rows[0] };
}

async function updateTaskPriority(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const priorityResult = normalizePriority(req.body?.priority);
    if (priorityResult.error) {
      return res.status(400).json({ message: priorityResult.error });
    }

    const loaded = await loadTaskForUpdate(taskId, req.user.id);
    if (loaded.status) {
      return res.status(loaded.status).json({ message: loaded.message });
    }

    await pool.query(
      `UPDATE tasks
       SET priority = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [priorityResult.priority, taskId]
    );

    const task = await loadSerializedTask(taskId);
    return res.status(200).json({
      task,
      priority: task.priority,
    });
  } catch (err) {
    console.error('Update task priority error:', err);
    return res.status(500).json({ message: 'Failed to update priority' });
  }
}

async function updateTaskDueDate(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!hasField(req.body, 'dueDate', 'due_date')) {
      return res.status(400).json({ message: 'dueDate is required' });
    }

    const restrictPast = req.body?.restrictPast !== false;
    const due = parseDueDate(pickField(req.body, 'dueDate', 'due_date') ?? null, {
      allowPast: !restrictPast,
      allowEmpty: true,
    });
    if (due.error) {
      return res.status(400).json({ message: due.error });
    }

    const loaded = await loadTaskForUpdate(taskId, req.user.id);
    if (loaded.status) {
      return res.status(loaded.status).json({ message: loaded.message });
    }

    await pool.query(
      `UPDATE tasks
       SET due_date = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [due.dueDate, taskId]
    );

    return res.status(200).json({ task: await loadSerializedTask(taskId) });
  } catch (err) {
    console.error('Update task due date error:', err);
    return res.status(500).json({ message: 'Failed to update due date' });
  }
}

async function updateTaskStatus(req, res) {
  const client = await pool.connect();

  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const column = String(
      pickField(req.body, 'columnId', 'column_id', 'column') ?? ''
    ).trim();
    if (!column) {
      return res.status(400).json({ message: 'Valid target column is required' });
    }

    const rawOrder = pickField(req.body, 'order');
    let requestedOrder = null;
    if (rawOrder !== undefined) {
      requestedOrder = Number(rawOrder);
      if (!Number.isInteger(requestedOrder) || requestedOrder < 0) {
        return res.status(400).json({ message: 'order must be a non-negative integer' });
      }
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, project_id, column_name, sort_order
       FROM tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Task not found' });
    }

    const current = existing.rows[0];
    const access = await assertProjectAccess(current.project_id, req.user.id);
    if (access.status) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }

    await ensureDefaultColumns(client, current.project_id);
    if (!(await findProjectColumn(current.project_id, column))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Valid target column is required' });
    }

    const targetCount = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM tasks
       WHERE project_id = $1 AND column_name = $2 AND id <> $3`,
      [current.project_id, column, taskId]
    );
    const maxOrder = targetCount.rows[0].n;
    const order = requestedOrder === null ? maxOrder : Math.min(requestedOrder, maxOrder);
    const sourceColumn = current.column_name;
    const fromOrder = Number(current.sort_order) || 0;

    if (sourceColumn === column) {
      if (fromOrder < order) {
        await client.query(
          `UPDATE tasks
           SET sort_order = sort_order - 1
           WHERE project_id = $1 AND column_name = $2 AND id <> $3
             AND sort_order > $4 AND sort_order <= $5`,
          [current.project_id, column, taskId, fromOrder, order]
        );
      } else if (fromOrder > order) {
        await client.query(
          `UPDATE tasks
           SET sort_order = sort_order + 1
           WHERE project_id = $1 AND column_name = $2 AND id <> $3
             AND sort_order >= $4 AND sort_order < $5`,
          [current.project_id, column, taskId, order, fromOrder]
        );
      }
    } else {
      await client.query(
        `UPDATE tasks
         SET sort_order = sort_order - 1
         WHERE project_id = $1 AND column_name = $2 AND sort_order > $3`,
        [current.project_id, sourceColumn, fromOrder]
      );
      await client.query(
        `UPDATE tasks
         SET sort_order = sort_order + 1
         WHERE project_id = $1 AND column_name = $2 AND sort_order >= $3`,
        [current.project_id, column, order]
      );
    }

    await client.query(
      `UPDATE tasks
       SET column_name = $1,
           sort_order = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [column, order, taskId]
    );

    await client.query('COMMIT');
    await refreshProjectTaskCounts(current.project_id);

    const task = await loadSerializedTask(taskId);
    if (sourceColumn !== column) {
      try {
        const actorName = await getActorName(req.user.id);
        await notifyTaskWatchers({
          taskId,
          workspaceId: access.project.workspace_id,
          actorId: req.user.id,
          type: 'status',
          title: `${actorName} moved ${task.title}`,
          body: `${sourceColumn} → ${column}`,
        });
      } catch (notifyErr) {
        console.error('Status notification error:', notifyErr.message);
      }
    }

    return res.status(200).json({
      task,
      status: { columnId: task.column, order: task.order },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update task status error:', err);
    return res.status(500).json({ message: 'Failed to move task' });
  } finally {
    client.release();
  }
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function deleteTask(req, res) {
  const client = await pool.connect();

  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, project_id, column_name, sort_order, title
       FROM tasks
       WHERE id = $1
       FOR UPDATE`,
      [taskId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Task not found' });
    }

    const current = existing.rows[0];
    const access = await assertProjectAccess(current.project_id, req.user.id);
    if (access.status) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }

    if (await tableExists(client, 'task_comments')) {
      await client.query(`DELETE FROM task_comments WHERE task_id = $1`, [taskId]);
    }

    if (await tableExists(client, 'task_attachments')) {
      await client.query(`DELETE FROM task_attachments WHERE task_id = $1`, [taskId]);
    }

    await client.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);

    await client.query(
      `UPDATE tasks
       SET sort_order = sort_order - 1
       WHERE project_id = $1 AND column_name = $2 AND sort_order > $3`,
      [current.project_id, current.column_name, current.sort_order]
    );

    await client.query('COMMIT');
    await refreshProjectTaskCounts(current.project_id);

    return res.status(200).json({
      message: 'Task deleted',
      id: taskId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete task error:', err);
    return res.status(500).json({ message: 'Failed to delete task' });
  } finally {
    client.release();
  }
}

module.exports = {
  TASK_SELECT,
  SUBTASK_COUNTS,
  serializeTask,
  listTasks,
  getTask,
  createTask,
  updateTask,
  assignTask,
  updateTaskPriority,
  updateTaskDueDate,
  updateTaskStatus,
  deleteTask,
};
