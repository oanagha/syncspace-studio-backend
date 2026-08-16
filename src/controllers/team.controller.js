const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_ROLES = new Set(['Admin', 'Member']);
const MEMBER_ROLES = new Set(['Owner', 'Admin', 'Member']);
const ASSIGNABLE_ROLES = new Set(['Admin', 'Member']);

function serializeInvitation(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name || null,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by: row.invited_by,
    created_at: row.created_at,
  };
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

function canManageTeam(role) {
  return role === 'Owner' || role === 'Admin';
}

function canInvite(role) {
  return role === 'Owner' || role === 'Admin';
}

function parseUserId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function membershipRoleToInsert(inviteRole) {
  if (inviteRole === 'Admin') return 'Admin';
  return 'Member';
}

async function getUserEmail(userId) {
  const result = await pool.query(
    `SELECT workspace_email FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.workspace_email
    ? String(result.rows[0].workspace_email).toLowerCase()
    : null;
}

async function loadMemberRow(workspaceId, userId) {
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
     WHERE wm.workspace_id = $1 AND wm.user_id = $2
     GROUP BY u.id, u.full_name, u.workspace_email, wm.role, wm.joined_at`,
    [workspaceId, userId]
  );
  return result.rows[0] || null;
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

    if (!INVITE_ROLES.has(role)) {
      return res.status(400).json({
        message: 'role must be Admin or Member (Guest invites are not supported yet)',
      });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canInvite(membership.role)) {
      return res.status(403).json({ message: 'Only owners and admins can invite members' });
    }

    if (role === 'Admin' && membership.role !== 'Owner') {
      return res.status(403).json({ message: 'Only the owner can invite admins' });
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

    if (!canManageTeam(membership.role)) {
      return res.status(403).json({ message: 'Only owners and admins can view invitations' });
    }

    const result = await pool.query(
      `SELECT wi.id, wi.workspace_id, w.name AS workspace_name, wi.email, wi.role,
              wi.status, wi.invited_by, wi.created_at
       FROM workspace_invitations wi
       INNER JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.workspace_id = $1 AND wi.status = 'pending'
       ORDER BY wi.created_at DESC`,
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

async function listMyInvitations(req, res) {
  try {
    const email = await getUserEmail(req.user.id);
    if (!email) {
      return res.status(200).json({ invitations: [] });
    }

    const result = await pool.query(
      `SELECT wi.id, wi.workspace_id, w.name AS workspace_name, wi.email, wi.role,
              wi.status, wi.invited_by, wi.created_at
       FROM workspace_invitations wi
       INNER JOIN workspaces w ON w.id = wi.workspace_id
       WHERE lower(wi.email) = $1 AND wi.status = 'pending'
       ORDER BY wi.created_at DESC`,
      [email]
    );

    return res.status(200).json({
      invitations: result.rows.map(serializeInvitation),
    });
  } catch (err) {
    console.error('List my invitations error:', err);
    return res.status(500).json({ message: 'Failed to load invitations' });
  }
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

async function updateMemberRole(req, res) {
  try {
    const targetUserId = parseUserId(req.params.userId);
    const workspaceId = parseWorkspaceId(
      req.body?.workspaceId ?? req.body?.workspace_id
    );
    const role = String(req.body?.role ?? '').trim();

    if (!targetUserId || !workspaceId || !role) {
      return res.status(400).json({ message: 'workspaceId, userId, and role are required' });
    }

    if (!MEMBER_ROLES.has(role)) {
      return res.status(400).json({ message: 'role must be Owner, Admin, or Member' });
    }

    if (!ASSIGNABLE_ROLES.has(role)) {
      return res.status(400).json({
        message: 'Cannot assign Owner role this way. Ownership transfer is not supported.',
      });
    }

    const actor = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!actor) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canManageTeam(actor.role)) {
      return res.status(403).json({ message: 'Only owners and admins can change member roles' });
    }

    const target = await pool.query(
      `SELECT user_id, role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId]
    );

    if (target.rows.length === 0) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const targetRole = target.rows[0].role;
    if (targetRole === 'Owner') {
      return res.status(403).json({ message: 'Cannot change the workspace owner role' });
    }

    if (actor.role === 'Admin' && targetRole === 'Admin') {
      return res.status(403).json({ message: 'Admins cannot change other admins' });
    }

    if (actor.role === 'Admin' && role === 'Admin') {
      return res.status(403).json({ message: 'Only the owner can promote members to admin' });
    }

    await pool.query(
      `UPDATE workspace_members
       SET role = $1
       WHERE workspace_id = $2 AND user_id = $3`,
      [role, workspaceId, targetUserId]
    );

    const member = await loadMemberRow(workspaceId, targetUserId);
    return res.status(200).json({ member: serializeMember(member) });
  } catch (err) {
    console.error('Update member role error:', err);
    return res.status(500).json({ message: 'Failed to update member role' });
  }
}

async function removeMember(req, res) {
  try {
    const targetUserId = parseUserId(req.params.userId);
    const workspaceId = parseWorkspaceId(
      req.body?.workspaceId ?? req.body?.workspace_id ?? req.query?.workspaceId
    );

    if (!targetUserId || !workspaceId) {
      return res.status(400).json({ message: 'workspaceId and userId are required' });
    }

    const actor = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!actor) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canManageTeam(actor.role)) {
      return res.status(403).json({ message: 'Only owners and admins can remove members' });
    }

    if (targetUserId === req.user.id) {
      return res.status(400).json({ message: 'You cannot remove yourself from the workspace' });
    }

    const target = await pool.query(
      `SELECT user_id, role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId]
    );

    if (target.rows.length === 0) {
      return res.status(404).json({ message: 'Member not found' });
    }

    if (target.rows[0].role === 'Owner') {
      return res.status(403).json({ message: 'Cannot remove the workspace owner' });
    }

    if (actor.role === 'Admin' && target.rows[0].role === 'Admin') {
      return res.status(403).json({ message: 'Admins cannot remove other admins' });
    }

    await pool.query(
      `DELETE FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId]
    );

    return res.status(200).json({ message: 'Member removed from workspace' });
  } catch (err) {
    console.error('Remove member error:', err);
    return res.status(500).json({ message: 'Failed to remove member' });
  }
}

async function acceptInvitation(req, res) {
  const client = await pool.connect();
  try {
    const invitationId = parseUserId(req.params.id);
    if (!invitationId) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    const email = await getUserEmail(req.user.id);
    if (!email) {
      return res.status(403).json({ message: 'You do not have access to this invitation' });
    }

    await client.query('BEGIN');

    const inviteResult = await client.query(
      `SELECT wi.id, wi.workspace_id, wi.email, wi.role, wi.status, w.name AS workspace_name
       FROM workspace_invitations wi
       INNER JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.id = $1
       FOR UPDATE OF wi`,
      [invitationId]
    );

    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invitation not found' });
    }

    const invite = inviteResult.rows[0];
    if (String(invite.email).toLowerCase() !== email) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You do not have access to this invitation' });
    }

    if (invite.status === 'accepted') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invitation has already been accepted' });
    }

    if (invite.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invitation is no longer pending' });
    }

    const memberRole = membershipRoleToInsert(invite.role);

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [invite.workspace_id, req.user.id, memberRole]
    );

    await client.query(
      `UPDATE workspace_invitations
       SET status = 'accepted'
       WHERE id = $1`,
      [invitationId]
    );

    const membership = await client.query(
      `SELECT wm.role, w.id, w.name
       FROM workspace_members wm
       INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
      [invite.workspace_id, req.user.id]
    );

    await client.query('COMMIT');

    const workspace = membership.rows[0];
    return res.status(200).json({
      message: 'Invitation accepted',
      workspace: {
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
      },
      invitation: {
        id: invite.id,
        status: 'accepted',
      },
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Accept invitation error:', err);
    return res.status(500).json({ message: 'Failed to accept invitation' });
  } finally {
    client.release();
  }
}

async function cancelInvitation(req, res) {
  try {
    const invitationId = parseUserId(req.params.id);
    if (!invitationId) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    const inviteResult = await pool.query(
      `SELECT id, workspace_id, email, status
       FROM workspace_invitations
       WHERE id = $1`,
      [invitationId]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    const invite = inviteResult.rows[0];
    const actor = await getWorkspaceMembership(invite.workspace_id, req.user.id);
    if (!actor) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canManageTeam(actor.role)) {
      return res.status(403).json({ message: 'Only owners and admins can cancel invitations' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending invitations can be cancelled' });
    }

    await pool.query(
      `UPDATE workspace_invitations
       SET status = 'revoked'
       WHERE id = $1`,
      [invitationId]
    );

    return res.status(200).json({ message: 'Invitation cancelled' });
  } catch (err) {
    console.error('Cancel invitation error:', err);
    return res.status(500).json({ message: 'Failed to cancel invitation' });
  }
}

module.exports = {
  inviteMember,
  listInvitations,
  listMyInvitations,
  listMembers,
  updateMemberRole,
  removeMember,
  acceptInvitation,
  cancelInvitation,
};
