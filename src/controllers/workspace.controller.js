const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { deleteWorkspaceUploadDir } = require('../services/storage.service');

const MIN_NAME_LEN = 3;
const MAX_NAME_LEN = 100;

function serializeWorkspace(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    created_at: row.created_at,
  };
}

function validateName(rawName) {
  const name = String(rawName ?? '').trim();

  if (!name) {
    return { error: 'Workspace name is required' };
  }

  if (name.length < MIN_NAME_LEN || name.length > MAX_NAME_LEN) {
    return {
      error: `Workspace name must be between ${MIN_NAME_LEN} and ${MAX_NAME_LEN} characters`,
    };
  }

  return { name };
}

async function createWorkspace(req, res) {
  const client = await pool.connect();

  try {
    const { name, error } = validateName(req.body?.name);

    if (error) {
      return res.status(400).json({ message: error });
    }

    await client.query('BEGIN');

    const workspaceResult = await client.query(
      `INSERT INTO workspaces (name, created_by)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [name, req.user.id]
    );

    const workspace = workspaceResult.rows[0];

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'Owner')`,
      [workspace.id, req.user.id]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        role: 'Owner',
        created_at: workspace.created_at,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create workspace error:', err);
    return res.status(500).json({ message: 'Failed to create workspace' });
  } finally {
    client.release();
  }
}

async function listWorkspaces(req, res) {
  try {
    const result = await pool.query(
      `SELECT w.id, w.name, wm.role, w.created_at
       FROM workspace_members wm
       INNER JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );

    return res.status(200).json({
      workspaces: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
      })),
    });
  } catch (err) {
    console.error('List workspaces error:', err);
    return res.status(500).json({ message: 'Failed to load workspaces' });
  }
}

async function getWorkspace(req, res) {
  try {
    const workspaceId = parseWorkspaceId(req.params.id);

    if (!workspaceId) {
      return res.status(400).json({ message: 'Invalid workspace id' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);

    if (!membership) {
      // Same status for missing and inaccessible to avoid workspace id oracle.
      return res.status(404).json({ message: 'Workspace not found' });
    }

    return res.status(200).json({
      workspace: serializeWorkspace(membership),
    });
  } catch (err) {
    console.error('Get workspace error:', err);
    return res.status(500).json({ message: 'Failed to load workspace' });
  }
}

async function switchWorkspace(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.body?.workspace_id ?? req.body?.workspaceId
    );

    if (!workspaceId) {
      return res.status(400).json({ message: 'workspace_id is required' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);

    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    return res.status(200).json({
      active_workspace: {
        id: membership.id,
        name: membership.name,
        role: membership.role,
      },
    });
  } catch (err) {
    console.error('Switch workspace error:', err);
    return res.status(500).json({ message: 'Failed to switch workspace' });
  }
}

function canRenameWorkspace(role) {
  return role === 'Owner' || role === 'Admin';
}

function canDeleteWorkspace(role) {
  return role === 'Owner';
}

async function renameWorkspace(req, res) {
  try {
    const workspaceId = parseWorkspaceId(req.params.id);

    if (!workspaceId) {
      return res.status(404).json({ message: 'Workspace not found' });
    }

    const { name, error } = validateName(req.body?.name);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const exists = await pool.query(
      `SELECT id FROM workspaces WHERE id = $1`,
      [workspaceId]
    );

    if (exists.rows.length === 0) {
      return res.status(404).json({ message: 'Workspace not found' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);

    if (!membership || !canRenameWorkspace(membership.role)) {
      return res.status(403).json({
        message: 'You do not have permission to rename this workspace',
      });
    }

    const result = await pool.query(
      `UPDATE workspaces
       SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, name, updated_at`,
      [name, workspaceId]
    );

    const workspace = result.rows[0];

    return res.status(200).json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        role: membership.role,
        updated_at: workspace.updated_at,
      },
    });
  } catch (err) {
    console.error('Rename workspace error:', err);
    return res.status(500).json({ message: 'Failed to rename workspace' });
  }
}

async function deleteWorkspace(req, res) {
  try {
    const workspaceId = parseWorkspaceId(req.params.id);

    if (!workspaceId) {
      return res.status(404).json({ message: 'Workspace not found' });
    }

    const exists = await pool.query(
      `SELECT id, name FROM workspaces WHERE id = $1`,
      [workspaceId]
    );

    if (exists.rows.length === 0) {
      return res.status(404).json({ message: 'Workspace not found' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);

    if (!membership || !canDeleteWorkspace(membership.role)) {
      return res.status(403).json({
        message: 'Only the workspace owner can delete this workspace',
      });
    }

    const membershipCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM workspace_members
       WHERE user_id = $1`,
      [req.user.id]
    );

    if ((membershipCount.rows[0]?.count || 0) <= 1) {
      return res.status(400).json({
        message: 'You cannot delete your only workspace',
      });
    }

    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);

    try {
      await deleteWorkspaceUploadDir(workspaceId);
    } catch (storageErr) {
      console.error('Workspace upload cleanup failed:', storageErr);
    }

    return res.status(200).json({ message: 'Workspace deleted' });
  } catch (err) {
    console.error('Delete workspace error:', err);
    return res.status(500).json({ message: 'Failed to delete workspace' });
  }
}

module.exports = {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  switchWorkspace,
  renameWorkspace,
  deleteWorkspace,
};
