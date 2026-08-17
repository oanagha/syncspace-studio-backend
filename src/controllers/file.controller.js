const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { canEditContent, guestEditMessage } = require('../utils/roles');
const {
  saveFile,
  deleteStoredFile,
  resolveStoredPath,
  isAllowedFile,
  kindFromName,
  colorForKind,
  getMaxUploadBytes,
} = require('../services/storage.service');

function parseOptionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function serializeFile(row) {
  const kind = kindFromName(row.original_name, row.mime_type);
  return {
    id: row.id,
    name: row.original_name,
    size: Number(row.size_bytes) || 0,
    size_bytes: Number(row.size_bytes) || 0,
    mime_type: row.mime_type,
    kind,
    color: colorForKind(kind),
    uploaded_by: row.uploaded_by
      ? {
          id: row.uploaded_by,
          name: row.uploader_name || 'Member',
        }
      : null,
    project_id: row.project_id || null,
    project_title: row.project_title || null,
    task_id: row.task_id || null,
    task_title: row.task_title || null,
    workspace_id: row.workspace_id,
    created_at: row.created_at,
    download_url: `/api/files/${row.id}/download`,
  };
}

async function assertProjectInWorkspace(projectId, workspaceId) {
  if (!projectId) return null;
  const result = await pool.query(
    `SELECT id, title FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspaceId]
  );
  if (result.rows.length === 0) {
    return { error: 'Project not found in this workspace' };
  }
  return { project: result.rows[0] };
}

async function assertTaskInWorkspace(taskId, workspaceId) {
  if (!taskId) return null;
  const result = await pool.query(
    `SELECT t.id, t.title, t.project_id
     FROM tasks t
     INNER JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1 AND p.workspace_id = $2`,
    [taskId, workspaceId]
  );
  if (result.rows.length === 0) {
    return { error: 'Task not found in this workspace' };
  }
  return { task: result.rows[0] };
}

async function listFiles(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.query.workspaceId ?? req.query.workspace_id
    );
    if (!workspaceId) {
      return res.status(400).json({ message: 'Invalid file request' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    const taskId = parseOptionalId(req.query.taskId ?? req.query.task_id);
    if (taskId) {
      const taskCheck = await assertTaskInWorkspace(taskId, workspaceId);
      if (taskCheck?.error) {
        return res.status(404).json({ message: 'Task not found' });
      }
    }

    const params = [workspaceId];
    let taskFilter = '';
    if (taskId) {
      params.push(taskId);
      taskFilter = ` AND f.task_id = $${params.length}`;
    }

    const [filesResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT
           f.id,
           f.workspace_id,
           f.project_id,
           f.task_id,
           f.uploaded_by,
           f.original_name,
           f.mime_type,
           f.size_bytes,
           f.created_at,
           u.full_name AS uploader_name,
           p.title AS project_title,
           t.title AS task_title
         FROM workspace_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN projects p ON p.id = f.project_id
         LEFT JOIN tasks t ON t.id = f.task_id
         WHERE f.workspace_id = $1${taskFilter}
         ORDER BY f.created_at DESC`,
        params
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS file_count,
           COALESCE(SUM(size_bytes), 0)::bigint AS total_size
         FROM workspace_files
         WHERE workspace_id = $1${taskId ? ' AND task_id = $2' : ''}`,
        params
      ),
    ]);

    return res.status(200).json({
      files: filesResult.rows.map(serializeFile),
      file_count: Number(statsResult.rows[0]?.file_count) || 0,
      total_size: Number(statsResult.rows[0]?.total_size) || 0,
    });
  } catch (err) {
    console.error('List files error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  }
}

async function getFile(req, res) {
  try {
    const fileId = parseOptionalId(req.params.id);
    if (!fileId) {
      return res.status(404).json({ message: 'File not found' });
    }

    const result = await pool.query(
      `SELECT
         f.id,
         f.workspace_id,
         f.project_id,
         f.task_id,
         f.uploaded_by,
         f.original_name,
         f.mime_type,
         f.size_bytes,
         f.created_at,
         u.full_name AS uploader_name,
         p.title AS project_title,
         t.title AS task_title
       FROM workspace_files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN projects p ON p.id = f.project_id
       LEFT JOIN tasks t ON t.id = f.task_id
       WHERE f.id = $1`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'File not found' });
    }

    const row = result.rows[0];
    const membership = await getWorkspaceMembership(row.workspace_id, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    return res.status(200).json({ file: serializeFile(row) });
  } catch (err) {
    console.error('Get file error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  }
}

async function uploadFile(req, res) {
  try {
    const workspaceId = parseWorkspaceId(
      req.body?.workspaceId ?? req.body?.workspace_id
    );
    let projectId = parseOptionalId(req.body?.projectId ?? req.body?.project_id);
    let taskId = parseOptionalId(req.body?.taskId ?? req.body?.task_id);

    if (!workspaceId || !req.file) {
      return res.status(400).json({ message: 'Invalid file request' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    if (!canEditContent(membership.role)) {
      return res.status(403).json({ message: guestEditMessage() });
    }

    if (!isAllowedFile(req.file)) {
      return res.status(400).json({ message: 'Invalid file request' });
    }

    if (req.file.size > getMaxUploadBytes()) {
      return res.status(400).json({ message: 'Invalid file request' });
    }

    if (taskId) {
      const taskCheck = await assertTaskInWorkspace(taskId, workspaceId);
      if (taskCheck?.error) {
        return res.status(400).json({ message: taskCheck.error });
      }
      if (!projectId) projectId = taskCheck.task.project_id;
    }

    if (projectId) {
      const projectCheck = await assertProjectInWorkspace(projectId, workspaceId);
      if (projectCheck?.error) {
        return res.status(400).json({ message: projectCheck.error });
      }
    }

    const stored = await saveFile({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      workspaceId,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insert = await client.query(
        `INSERT INTO workspace_files (
           workspace_id, project_id, task_id, uploaded_by,
           original_name, stored_name, mime_type, size_bytes, storage_key
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, workspace_id, project_id, task_id, uploaded_by,
                   original_name, mime_type, size_bytes, created_at`,
        [
          workspaceId,
          projectId,
          taskId,
          req.user.id,
          stored.original_name,
          stored.stored_name,
          stored.mime_type,
          stored.size_bytes,
          stored.storage_key,
        ]
      );

      if (taskId) {
        await client.query(
          `INSERT INTO task_attachments (task_id, uploaded_by, file_name, file_url)
           VALUES ($1, $2, $3, $4)`,
          [
            taskId,
            req.user.id,
            stored.original_name,
            `/api/files/${insert.rows[0].id}/download`,
          ]
        );
      }

      await client.query('COMMIT');

      const full = await pool.query(
        `SELECT
           f.id,
           f.workspace_id,
           f.project_id,
           f.task_id,
           f.uploaded_by,
           f.original_name,
           f.mime_type,
           f.size_bytes,
           f.created_at,
           u.full_name AS uploader_name,
           p.title AS project_title,
           t.title AS task_title
         FROM workspace_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN projects p ON p.id = f.project_id
         LEFT JOIN tasks t ON t.id = f.task_id
         WHERE f.id = $1`,
        [insert.rows[0].id]
      );

      return res.status(201).json({ file: serializeFile(full.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK');
      await deleteStoredFile(stored.storage_key);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Upload file error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  }
}

async function downloadFile(req, res) {
  try {
    const fileId = parseOptionalId(req.params.id);
    if (!fileId) {
      return res.status(404).json({ message: 'File not found' });
    }

    const result = await pool.query(
      `SELECT id, workspace_id, original_name, mime_type, storage_key
       FROM workspace_files
       WHERE id = $1`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'File not found' });
    }

    const row = result.rows[0];
    const membership = await getWorkspaceMembership(row.workspace_id, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    const absolutePath = resolveStoredPath(row.storage_key);
    return res.download(absolutePath, row.original_name, {
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
      },
    });
  } catch (err) {
    console.error('Download file error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  }
}

async function deleteFile(req, res) {
  try {
    const fileId = parseOptionalId(req.params.id);
    if (!fileId) {
      return res.status(404).json({ message: 'File not found' });
    }

    const result = await pool.query(
      `SELECT id, workspace_id, storage_key, task_id, original_name, uploaded_by
       FROM workspace_files
       WHERE id = $1`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'File not found' });
    }

    const row = result.rows[0];
    const membership = await getWorkspaceMembership(row.workspace_id, req.user.id);
    if (!membership) {
      return res.status(403).json({ message: 'You do not have access to this workspace' });
    }

    const canDelete =
      membership.role === 'Owner' ||
      membership.role === 'Admin' ||
      row.uploaded_by === req.user.id;

    if (!canDelete) {
      return res.status(403).json({
        message: 'Only owners, admins, or the uploader can delete this file',
      });
    }

    await pool.query(`DELETE FROM workspace_files WHERE id = $1`, [fileId]);

    if (row.task_id) {
      await pool.query(
        `DELETE FROM task_attachments
         WHERE task_id = $1
           AND (
             file_url = $2
             OR file_url LIKE $3
             OR file_name = $4
           )`,
        [
          row.task_id,
          `/api/files/${fileId}/download`,
          `%/api/files/${fileId}/download%`,
          row.original_name,
        ]
      );
    }

    await deleteStoredFile(row.storage_key);

    return res.status(200).json({ message: 'File deleted' });
  } catch (err) {
    console.error('Delete file error:', err);
    return res.status(500).json({ message: 'Failed to process file' });
  }
}

module.exports = {
  listFiles,
  getFile,
  uploadFile,
  downloadFile,
  deleteFile,
};
