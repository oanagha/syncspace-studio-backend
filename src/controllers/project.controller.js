const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { ensureDefaultColumns } = require('./column.controller');

const MIN_TITLE_LEN = 3;
const MAX_TITLE_LEN = 150;
const DEFAULT_COLOR = '#14B8A6';
const COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const ALLOWED_STATUSES = new Set(['On Track', 'At Risk', 'Completed']);
const ALLOWED_SORTS = new Set(['progress', 'name', 'deadline', 'recent']);

const MEMBER_SELECT = `
  COALESCE(
    json_agg(
      json_build_object(
        'id', u.id,
        'name', split_part(u.full_name, ' ', 1),
        'avatar', NULL
      )
      ORDER BY pm.id
    ) FILTER (WHERE u.id IS NOT NULL),
    '[]'::json
  ) AS members
`;

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function serializeMember(member) {
  return {
    id: member.id,
    name: member.name,
    avatar: member.avatar ?? null,
  };
}

function serializeProject(row) {
  const members = Array.isArray(row.members)
    ? row.members.map(serializeMember)
    : [];

  const project = {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    color: row.color || DEFAULT_COLOR,
    status: row.status,
    progress: Number(row.progress) || 0,
    completed_tasks: Number(row.completed_tasks) || 0,
    total_tasks: Number(row.total_tasks) || 0,
    deadline: row.deadline || null,
    member_count: Number(row.member_count) || members.length,
    members,
  };

  if (row.created_at) {
    project.created_at = row.created_at;
  }

  if (row.updated_at) {
    project.updated_at = row.updated_at;
  }

  if (row.workspace_id) {
    project.workspace_id = row.workspace_id;
  }

  if (row.role) {
    project.role = row.role;
  }

  return project;
}

function canManageProject(role) {
  return role === 'Owner' || role === 'Admin';
}

async function loadProjectWithMembers(projectId) {
  const result = await pool.query(
    `SELECT
       p.id,
       p.workspace_id,
       p.title,
       p.description,
       p.color,
       p.status,
       p.progress,
       p.completed_tasks,
       p.total_tasks,
       p.deadline::text AS deadline,
       p.created_at,
       p.updated_at,
       COUNT(pm.user_id)::int AS member_count,
       ${MEMBER_SELECT}
     FROM projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id
     LEFT JOIN users u ON u.id = pm.user_id
     WHERE p.id = $1
     GROUP BY p.id`,
    [projectId]
  );

  return result.rows[0] || null;
}

function validateTitle(rawTitle) {
  const title = String(rawTitle ?? '').trim();

  if (!title) {
    return { error: 'title is required' };
  }

  if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) {
    return {
      error: `title must be between ${MIN_TITLE_LEN} and ${MAX_TITLE_LEN} characters`,
    };
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

function validateDeadline(rawDeadline) {
  if (rawDeadline === undefined || rawDeadline === null || rawDeadline === '') {
    return { deadline: null };
  }

  const deadline = String(rawDeadline).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline))) {
    return { error: 'deadline must be a valid date (YYYY-MM-DD)' };
  }

  return { deadline };
}

function sortClause(sort) {
  switch (sort) {
    case 'progress':
      return 'p.progress DESC, p.created_at DESC';
    case 'name':
      return 'LOWER(p.title) ASC';
    case 'deadline':
      return 'p.deadline ASC NULLS LAST, p.created_at DESC';
    case 'recent':
    default:
      return 'p.created_at DESC';
  }
}

async function createProject(req, res) {
  const client = await pool.connect();

  try {
    const { title, error: titleError } = validateTitle(req.body?.title);
    if (titleError) {
      return res.status(400).json({ message: titleError });
    }

    const { color, error: colorError } = validateColor(req.body?.color);
    if (colorError) {
      return res.status(400).json({ message: colorError });
    }

    const { deadline, error: deadlineError } = validateDeadline(req.body?.deadline);
    if (deadlineError) {
      return res.status(400).json({ message: deadlineError });
    }

    const description =
      req.body?.description === undefined || req.body?.description === null
        ? null
        : String(req.body.description).trim() || null;

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO projects (
         workspace_id, title, description, color, deadline, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, status, progress`,
      [req.workspace.id, title, description, color, deadline, req.user.id]
    );

    const project = result.rows[0];

    await client.query(
      `INSERT INTO project_members (project_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [project.id, req.user.id]
    );

    await ensureDefaultColumns(client, project.id);

    await client.query('COMMIT');

    return res.status(201).json({
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        progress: project.progress,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create project error:', err);
    return res.status(500).json({ message: 'Failed to create project' });
  } finally {
    client.release();
  }
}

async function listProjects(req, res) {
  try {
    const search = String(firstValue(req.query.search) ?? '').trim();
    const statusRaw = String(firstValue(req.query.status) ?? 'all').trim();
    const sortRaw = String(firstValue(req.query.sort) ?? 'recent').trim();

    if (statusRaw && statusRaw !== 'all' && !ALLOWED_STATUSES.has(statusRaw)) {
      return res.status(400).json({ message: 'Invalid status filter' });
    }

    if (sortRaw && !ALLOWED_SORTS.has(sortRaw)) {
      return res.status(400).json({ message: 'Invalid sort option' });
    }

    const params = [req.workspace.id];
    const filters = ['p.workspace_id = $1'];

    if (search) {
      params.push(`%${search}%`);
      filters.push(`p.title ILIKE $${params.length}`);
    }

    if (statusRaw && statusRaw !== 'all') {
      params.push(statusRaw);
      filters.push(`p.status = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT
         p.id,
         p.title,
         p.description,
         p.color,
         p.status,
         p.progress,
         p.completed_tasks,
         p.total_tasks,
         p.deadline::text AS deadline,
         COUNT(pm.user_id)::int AS member_count,
         ${MEMBER_SELECT}
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id
       LEFT JOIN users u ON u.id = pm.user_id
       WHERE ${filters.join(' AND ')}
       GROUP BY p.id
       ORDER BY ${sortClause(sortRaw)}`,
      params
    );

    return res.status(200).json({
      projects: result.rows.map((row) => serializeProject(row)),
    });
  } catch (err) {
    console.error('List projects error:', err);
    return res.status(500).json({ message: 'Failed to load projects' });
  }
}

async function getProject(req, res) {
  try {
    const projectId = parseWorkspaceId(req.params.id);

    if (!projectId) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const row = await loadProjectWithMembers(projectId);

    if (!row) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const membership = await getWorkspaceMembership(row.workspace_id, req.user.id);

    if (!membership) {
      return res.status(403).json({ message: "You don't have access to this project" });
    }

    return res.status(200).json({
      project: serializeProject({ ...row, role: membership.role }),
    });
  } catch (err) {
    console.error('Get project error:', err);
    return res.status(500).json({ message: 'Failed to load project' });
  }
}

async function updateProject(req, res) {
  try {
    const projectId = parseWorkspaceId(req.params.id);

    if (!projectId) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const existing = await pool.query(
      `SELECT id, workspace_id, title, description, color, status, deadline
       FROM projects
       WHERE id = $1`,
      [projectId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const current = existing.rows[0];
    const membership = await getWorkspaceMembership(current.workspace_id, req.user.id);

    if (!membership) {
      return res.status(403).json({ message: "You don't have access to this project" });
    }

    if (!canManageProject(membership.role)) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    const { title, error: titleError } = validateTitle(req.body?.title);
    if (titleError) {
      return res.status(400).json({ message: titleError });
    }

    let status = current.status;
    if (req.body?.status !== undefined && req.body?.status !== null && req.body.status !== '') {
      const nextStatus = String(req.body.status).trim();
      if (!ALLOWED_STATUSES.has(nextStatus)) {
        return res.status(400).json({ message: 'Invalid payload' });
      }
      status = nextStatus;
    }

    let color = current.color;
    if (req.body?.color !== undefined && req.body?.color !== null && req.body.color !== '') {
      const { color: nextColor, error: colorError } = validateColor(req.body.color);
      if (colorError) {
        return res.status(400).json({ message: colorError });
      }
      color = nextColor;
    }

    let description = current.description;
    if (req.body?.description !== undefined) {
      description = String(req.body.description ?? '').trim() || null;
    }

    let deadline = current.deadline;
    if (req.body?.deadline !== undefined) {
      const { deadline: nextDeadline, error: deadlineError } = validateDeadline(req.body.deadline);
      if (deadlineError) {
        return res.status(400).json({ message: 'Invalid payload' });
      }
      deadline = nextDeadline;
    }

    await pool.query(
      `UPDATE projects
       SET title = $1,
           description = $2,
           color = $3,
           status = $4,
           deadline = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [title, description, color, status, deadline, projectId]
    );

    const row = await loadProjectWithMembers(projectId);

    return res.status(200).json({
      project: serializeProject({ ...row, role: membership.role }),
    });
  } catch (err) {
    console.error('Update project error:', err);
    return res.status(500).json({ message: 'Failed to update project' });
  }
}

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
};
