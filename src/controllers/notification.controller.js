const pool = require('../config/db');

const RECENT_LIMIT = 50;

function serializeNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? '',
    task_id: row.task_id || null,
    workspace_id: row.workspace_id || null,
    unread: row.read_at == null,
    created_at: row.created_at,
  };
}

async function listNotifications(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, type, title, body, task_id, workspace_id, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.user.id, RECENT_LIMIT]
    );

    const notifications = result.rows.map(serializeNotification);

    return res.status(200).json({
      notifications,
      unread_count: notifications.filter((item) => item.unread).length,
    });
  } catch (err) {
    console.error('List notifications error:', err);
    return res.status(500).json({ message: 'Failed to load notifications' });
  }
}

module.exports = { listNotifications };
