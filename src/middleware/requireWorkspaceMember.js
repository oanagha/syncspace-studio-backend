const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('./workspace.middleware');

function pickWorkspaceId(req) {
  return (
    req.body?.workspaceId ??
    req.query?.workspaceId ??
    req.body?.workspace_id ??
    req.query?.workspace_id ??
    req.params.workspaceId
  );
}

async function requireWorkspaceMember(req, res, next) {
  try {
    const workspaceId = parseWorkspaceId(pickWorkspaceId(req));

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspaceId is required' });
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

module.exports = { requireWorkspaceMember, pickWorkspaceId };
