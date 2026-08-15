const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = new Set(['Admin', 'Member', 'Guest']);

function serializeInvitation(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by: row.invited_by,
    created_at: row.created_at,
  };
}

function canInvite(role) {
  return role === 'Owner' || role === 'Admin';
}

async function inviteMember(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.body?.workspaceId ?? req.body?.workspace_id
    );
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = String(req.body?.role ?? '').trim();

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    if (!ALLOWED_ROLES.has(role)) {
      return res.status(400).json({ message: 'role must be Admin, Member, or Guest' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canInvite(membership.role)) {
      return res.status(403).json({ message: 'Only owners and admins can invite members' });
    }

    const existingMember = await pool.query(
      `SELECT wm.id
       FROM workspace_members wm
       INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND lower(u.workspace_email) = $2`,
      [workspaceId, email]
    );

    if (existingMember.rows.length > 0) {
      return res.status(409).json({ message: 'This user is already a workspace member' });
    }

    const pending = await pool.query(
      `SELECT id FROM workspace_invitations
       WHERE workspace_id = $1 AND lower(email) = $2 AND status = 'pending'`,
      [workspaceId, email]
    );

    if (pending.rows.length > 0) {
      return res.status(409).json({ message: 'An invitation has already been sent to this email' });
    }

    const result = await pool.query(
      `INSERT INTO workspace_invitations (workspace_id, email, role, invited_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, workspace_id, email, role, status, invited_by, created_at`,
      [workspaceId, email, role, req.user.id]
    );

    return res.status(201).json({
      invitation: serializeInvitation(result.rows[0]),
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'An invitation has already been sent to this email' });
    }

    console.error('Invite member error:', err);
    return res.status(500).json({ message: 'Failed to send invitation' });
  }
}

async function listInvitations(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.query.workspaceId ?? req.query.workspace_id
    );

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    const result = await pool.query(
      `SELECT id, workspace_id, email, role, status, invited_by, created_at
       FROM workspace_invitations
       WHERE workspace_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [workspaceId]
    );

    return res.status(200).json({
      invitations: result.rows.map(serializeInvitation),
    });
  } catch (err) {
    console.error('List invitations error:', err);
    return res.status(500).json({ message: 'Failed to load invitations' });
  }
}

function serializeMember(row) {
  const name = row.full_name || row.workspace_email || 'Member';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return {
    id: row.id,
    name,
    email: row.workspace_email,
    role: row.role,
    initials: initials || '?',
    tasks: Number(row.tasks) || 0,
    activity: Number(row.activity) || 0,
    joined_at: row.joined_at,
  };
}

async function listMembers(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.query.workspaceId ?? req.query.workspace_id
    );

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    const result = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.workspace_email,
         wm.role,
         wm.joined_at,
         COUNT(DISTINCT t.id)::int AS tasks,
         LEAST(
           100,
           GREATEST(
             0,
             COUNT(DISTINCT t.id) FILTER (
               WHERE COALESCE(t.updated_at, t.created_at) >= NOW() - INTERVAL '14 days'
             ) * 20
             + COUNT(DISTINCT c.id) FILTER (
               WHERE c.created_at >= NOW() - INTERVAL '14 days'
             ) * 10
           )
         )::int AS activity
       FROM workspace_members wm
       INNER JOIN users u ON u.id = wm.user_id
       LEFT JOIN projects p ON p.workspace_id = wm.workspace_id
       LEFT JOIN tasks t
         ON t.project_id = p.id
        AND (t.assignee_id = u.id OR t.created_by = u.id)
       LEFT JOIN task_comments c
         ON c.user_id = u.id
        AND c.created_at >= NOW() - INTERVAL '14 days'
       WHERE wm.workspace_id = $1
       GROUP BY u.id, u.full_name, u.workspace_email, wm.role, wm.joined_at
       ORDER BY
         CASE wm.role
           WHEN 'Owner' THEN 0
           WHEN 'Admin' THEN 1
           WHEN 'Member' THEN 2
           ELSE 3
         END,
         u.full_name ASC`,
      [workspaceId]
    );

    return res.status(200).json({
      members: result.rows.map(serializeMember),
    });
  } catch (err) {
    console.error('List members error:', err);
    return res.status(500).json({ message: 'Failed to load members' });
  }
}

module.exports = { inviteMember, listInvitations, listMembers };
