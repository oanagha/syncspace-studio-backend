const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { canEditContent, guestEditMessage } = require('../utils/roles');

const MIN_TITLE_LEN = 1;
const MAX_TITLE_LEN = 50;
const DEFAULT_COLOR = '#14B8A6';
const COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

const DEFAULT_COLUMNS = [
  ['Backlog', 0, '#64748B'],
  ['Todo', 1, '#1A4A6E'],
  ['In Progress', 2, '#2D8A9E'],
  ['Review', 3, '#D9A441'],
  ['Done', 4, '#2F9E7D'],
];

function serializeColumn(row) {
  const title = row.name;
  return {
    id: row.id,
    project_id: row.project_id,
    title,
    name: title,
    color: row.color || DEFAULT_COLOR,
    position: Number(row.position) || 0,
  };
}

function validateTitle(rawTitle) {
  const title = String(rawTitle ?? '').trim();
  if (!title) {
    return { error: 'title is required' };
  }
  if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) {
    return { error: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters` };
  }
  return { title };
}

function validateColor(rawColor) {
  if (rawColor === undefined || rawColor === null || rawColor === '') {
    return { color: DEFAULT_COLOR };
  }
  const color = String(rawColor).trim();
  if (!COLOR_RE.test(color)) {
    return { error: 'color must be a valid hex value' };
  }
  return { color };
}

async function ensureDefaultColumns(client, projectId) {
  const db = client || pool;
  await db.query(
    `INSERT INTO project_columns (project_id, name, position, color)
     SELECT $1, c.name, c.position, c.color
     FROM (
       VALUES
         ('Backlog', 0, '#64748B'),
         ('Todo', 1, '#1A4A6E'),
         ('In Progress', 2, '#2D8A9E'),
         ('Review', 3, '#D9A441'),
         ('Done', 4, '#2F9E7D')
     ) AS c(name, position, color)
     WHERE NOT EXISTS (
       SELECT 1 FROM project_columns WHERE project_id = $1
     )`,
    [projectId]
  );
}

async function findProjectColumn(projectId, name) {
  const result = await pool.query(
    `SELECT id, project_id, name, color, position
     FROM project_columns
     WHERE project_id = $1 AND name = $2`,
    [projectId, name]
  );
  return result.rows[0] || null;
}

async function assertProjectAccess(projectId, userId, { write = false } = {}) {
  const project = await pool.query(
    `SELECT id, workspace_id FROM projects WHERE id = $1`,
    [projectId]
  );

  if (project.rows.length === 0) {
    return { status: 404, message: 'Project not found' };
  }

  const membership = await getWorkspaceMembership(project.rows[0].workspace_id, userId);
  if (!membership) {
    return { status: 403, message: "You don't have access to this project" };
  }

  if (write && !canEditContent(membership.role)) {
    return { status: 403, message: guestEditMessage() };
  }

  return { project: project.rows[0], membership };
}

async function listColumns(req, res) {
  try {
    const projectId = parseWorkspaceId(
      req.query.projectId ?? req.query.project_id
    );

    if (!projectId) {
      return res.status(400).json({ message: 'projectId is required' });
    }

    const access = await assertProjectAccess(projectId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    await ensureDefaultColumns(pool, projectId);

    const result = await pool.query(
      `SELECT id, project_id, name, color, position
       FROM project_columns
       WHERE project_id = $1
       ORDER BY position ASC, id ASC`,
      [projectId]
    );

    return res.status(200).json({
      columns: result.rows.map(serializeColumn),
    });
  } catch (err) {
    console.error('List columns error:', err);
    return res.status(500).json({ message: 'Failed to load columns' });
  }
}

async function createColumn(req, res) {
  try {
    const projectId = parseWorkspaceId(
      req.body?.projectId ?? req.body?.project_id
    );

    if (!projectId) {
      return res.status(400).json({ message: 'projectId is required' });
    }

    const { title, error: titleError } = validateTitle(
      req.body?.title ?? req.body?.name
    );
    if (titleError) {
      return res.status(400).json({ message: titleError });
    }

    const { color, error: colorError } = validateColor(req.body?.color);
    if (colorError) {
      return res.status(400).json({ message: colorError });
    }

    const access = await assertProjectAccess(projectId, req.user.id, { write: true });
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    await ensureDefaultColumns(pool, projectId);

    const next = await pool.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position
       FROM project_columns
       WHERE project_id = $1`,
      [projectId]
    );

    const result = await pool.query(
      `INSERT INTO project_columns (project_id, name, position, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, name, color, position`,
      [projectId, title, next.rows[0].position, color]
    );

    return res.status(201).json({
      column: serializeColumn(result.rows[0]),
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A column with this title already exists' });
    }

    console.error('Create column error:', err);
    return res.status(500).json({ message: 'Failed to create column' });
  }
}

function hasField(body, ...keys) {
  return keys.some((key) => body?.[key] !== undefined);
}

async function updateColumn(req, res) {
  const client = await pool.connect();

  try {
    const columnId = parseWorkspaceId(req.params.id);
    if (!columnId) {
      return res.status(404).json({ message: 'Column not found' });
    }

    const body = req.body ?? {};
    if (!hasField(body, 'title', 'name', 'color', 'position')) {
      return res.status(400).json({ message: 'Provide title, color, or position' });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, project_id, name, color, position
       FROM project_columns
       WHERE id = $1
       FOR UPDATE`,
      [columnId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Column not found' });
    }

    const current = existing.rows[0];
    const access = await assertProjectAccess(current.project_id, req.user.id, { write: true });
    if (access.status) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }

    let title = current.name;
    if (hasField(body, 'title', 'name')) {
      const raw = String(body.title ?? body.name ?? '').trim();
      if (!raw) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Title cannot be empty' });
      }
      if (raw.length > MAX_TITLE_LEN) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters`,
        });
      }
      title = raw;
    }

    let color = current.color || DEFAULT_COLOR;
    if (hasField(body, 'color') && body.color !== null && body.color !== '') {
      const validated = validateColor(body.color);
      if (validated.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: validated.error });
      }
      color = validated.color;
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS n FROM project_columns WHERE project_id = $1`,
      [current.project_id]
    );
    const maxPosition = Math.max(countResult.rows[0].n - 1, 0);
    const fromPosition = Number(current.position) || 0;
    let position = fromPosition;

    if (hasField(body, 'position')) {
      const nextPosition = Number(body.position);
      if (!Number.isInteger(nextPosition) || nextPosition < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'position must be a non-negative integer' });
      }
      position = Math.min(nextPosition, maxPosition);

      if (fromPosition < position) {
        await client.query(
          `UPDATE project_columns
           SET position = position - 1
           WHERE project_id = $1 AND id <> $2
             AND position > $3 AND position <= $4`,
          [current.project_id, columnId, fromPosition, position]
        );
      } else if (fromPosition > position) {
        await client.query(
          `UPDATE project_columns
           SET position = position + 1
           WHERE project_id = $1 AND id <> $2
             AND position >= $3 AND position < $4`,
          [current.project_id, columnId, position, fromPosition]
        );
      }
    }

    if (title !== current.name) {
      await client.query(
        `UPDATE tasks
         SET column_name = $1, updated_at = CURRENT_TIMESTAMP
         WHERE project_id = $2 AND column_name = $3`,
        [title, current.project_id, current.name]
      );
    }

    const result = await client.query(
      `UPDATE project_columns
       SET name = $1, color = $2, position = $3
       WHERE id = $4
       RETURNING id, project_id, name, color, position`,
      [title, color, position, columnId]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      column: serializeColumn(result.rows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A column with this title already exists' });
    }

    console.error('Update column error:', err);
    return res.status(500).json({ message: 'Failed to update column' });
  } finally {
    client.release();
  }
}

async function reorderColumns(req, res) {
  const client = await pool.connect();

  try {
    const items = req.body?.columns;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'columns array is required' });
    }

    const parsed = [];
    const seenIds = new Set();
    const seenPositions = new Set();

    for (const item of items) {
      const id = parseWorkspaceId(item?.id);
      const position = Number(item?.position);

      if (!id || !Number.isInteger(position) || position < 0) {
        return res.status(400).json({ message: 'All column IDs must be valid' });
      }

      if (seenIds.has(id) || seenPositions.has(position)) {
        return res.status(400).json({ message: 'All column IDs must be valid' });
      }

      seenIds.add(id);
      seenPositions.add(position);
      parsed.push({ id, position });
    }

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, project_id
       FROM project_columns
       WHERE id = ANY($1::int[])
       FOR UPDATE`,
      [parsed.map((item) => item.id)]
    );

    if (existing.rows.length !== parsed.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'All column IDs must be valid' });
    }

    const projectIds = new Set(existing.rows.map((row) => row.project_id));
    if (projectIds.size !== 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'All column IDs must be valid' });
    }

    const projectId = existing.rows[0].project_id;
    const access = await assertProjectAccess(projectId, req.user.id, { write: true });
    if (access.status) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }

    await client.query(
      `UPDATE project_columns
       SET position = -id
       WHERE id = ANY($1::int[])`,
      [parsed.map((item) => item.id)]
    );

    for (const item of parsed) {
      await client.query(
        `UPDATE project_columns
         SET position = $1
         WHERE id = $2 AND project_id = $3`,
        [item.position, item.id, projectId]
      );
    }

    const result = await client.query(
      `SELECT id, project_id, name, color, position
       FROM project_columns
       WHERE project_id = $1
       ORDER BY position ASC, id ASC`,
      [projectId]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      columns: result.rows.map(serializeColumn),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reorder columns error:', err);
    return res.status(500).json({ message: 'Failed to reorder columns' });
  } finally {
    client.release();
  }
}

async function refreshProjectTaskCounts(client, projectId) {
  await client.query(
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

async function deleteColumn(req, res) {
  const client = await pool.connect();

  try {
    const columnId = parseWorkspaceId(req.params.id);
    if (!columnId) {
      return res.status(404).json({ message: 'Column not found' });
    }

    const moveToColumnId = parseWorkspaceId(
      req.body?.moveToColumnId ?? req.body?.move_to_column_id
    );

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, project_id, name, position
       FROM project_columns
       WHERE id = $1
       FOR UPDATE`,
      [columnId]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Column not found' });
    }

    const current = existing.rows[0];
    const access = await assertProjectAccess(current.project_id, req.user.id, { write: true });
    if (access.status) {
      await client.query('ROLLBACK');
      return res.status(access.status).json({ message: access.message });
    }

    const siblings = await client.query(
      `SELECT id, name
       FROM project_columns
       WHERE project_id = $1
       FOR UPDATE`,
      [current.project_id]
    );

    if (siblings.rows.length <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Cannot delete the last remaining column' });
    }

    const taskCountResult = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM tasks
       WHERE project_id = $1 AND column_name = $2`,
      [current.project_id, current.name]
    );
    const taskCount = taskCountResult.rows[0].n;

    let destination = null;
    if (taskCount > 0) {
      if (!moveToColumnId || moveToColumnId === columnId) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: 'moveToColumnId is required to preserve tasks in this column',
        });
      }

      destination = siblings.rows.find((row) => row.id === moveToColumnId);
      if (!destination) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'moveToColumnId is invalid' });
      }

      const nextOrder = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM tasks
         WHERE project_id = $1 AND column_name = $2`,
        [current.project_id, destination.name]
      );

      await client.query(
        `UPDATE tasks AS t
         SET column_name = $1,
             sort_order = $2 + ranked.rn - 1,
             updated_at = CURRENT_TIMESTAMP
         FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, id ASC) AS rn
           FROM tasks
           WHERE project_id = $3 AND column_name = $4
         ) AS ranked
         WHERE t.id = ranked.id`,
        [destination.name, nextOrder.rows[0].next_order, current.project_id, current.name]
      );
    }

    await client.query(`DELETE FROM project_columns WHERE id = $1`, [columnId]);
    await client.query(
      `UPDATE project_columns
       SET position = position - 1
       WHERE project_id = $1 AND position > $2`,
      [current.project_id, current.position]
    );

    await refreshProjectTaskCounts(client, current.project_id);

    const remaining = await client.query(
      `SELECT id, project_id, name, color, position
       FROM project_columns
       WHERE project_id = $1
       ORDER BY position ASC, id ASC`,
      [current.project_id]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Column deleted',
      deleted_column_id: columnId,
      moved_task_count: taskCount,
      move_to_column_id: destination ? destination.id : null,
      columns: remaining.rows.map(serializeColumn),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete column error:', err);
    return res.status(500).json({ message: 'Failed to delete column' });
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_COLUMNS,
  serializeColumn,
  ensureDefaultColumns,
  findProjectColumn,
  listColumns,
  createColumn,
  updateColumn,
  reorderColumns,
  deleteColumn,
};
