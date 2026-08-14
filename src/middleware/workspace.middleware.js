const pool = require('../config/db');

function parseWorkspaceId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

async function getWorkspaceMembership(workspaceId, userId) {
  const result = await pool.query(
    `SELECT
       w.id,
       w.name,
       w.created_by,
       w.created_at,
       wm.role
     FROM workspace_members wm
     INNER JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
    [workspaceId, userId]
  );

  return result.rows[0] || null;
}

async function requireWorkspaceMember(req, res, next) {
  try {
    const raw =
      req.body?.workspaceId ||
      req.query?.workspaceId ||
      req.body?.workspace_id ||
      req.query?.workspace_id ||
      req.params.workspaceId ||
      req.params.id;

    const workspaceId = parseWorkspaceId(raw);

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspace_id is required' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);

    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    req.workspace = membership;
    return next();
  } catch (err) {
    console.error('Workspace membership check failed:', err);
    return res.status(500).json({ message: 'Failed to verify workspace access' });
  }
}

module.exports = {
  parseWorkspaceId,
  getWorkspaceMembership,
  requireWorkspaceMember,
};
