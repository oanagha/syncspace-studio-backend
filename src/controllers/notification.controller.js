const pool = require('../config/db');

const RECENT_LIMIT = 50;

function serializeNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? '',
    task_id: row.task_id || null,
    project_id: row.project_id || null,
    workspace_id: row.workspace_id || null,
    unread: row.read_at == null,
    read_at: row.read_at || null,
    created_at: row.created_at,
  };
}

function parseNotificationId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function listNotifications(req, res) {
  try {
    const result = await pool.query(
      `SELECT
         n.id,
         n.type,
         n.title,
         n.body,
         n.task_id,
         n.workspace_id,
         n.read_at,
         n.created_at,
         t.project_id
       FROM notifications n
       LEFT JOIN tasks t ON t.id = n.task_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
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

async function markNotificationRead(req, res) {
  try {
    const notificationId = parseNotificationId(req.params.id);
    if (!notificationId) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    const existing = await pool.query(
      `SELECT id, user_id, read_at
       FROM notifications
       WHERE id = $1`,
      [notificationId]
    );

    if (existing.rows.length === 0 || existing.rows[0].user_id !== req.user.id) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    if (existing.rows[0].read_at) {
      return res.status(200).json({
        notification: {
          id: existing.rows[0].id,
          read_at: existing.rows[0].read_at,
        },
      });
    }

    const result = await pool.query(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING id, read_at`,
      [notificationId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    return res.status(200).json({
      notification: {
        id: result.rows[0].id,
        read_at: result.rows[0].read_at,
      },
    });
  } catch (err) {
    console.error('Mark notification read error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
}

async function markAllNotificationsRead(req, res) {
  try {
    await pool.query(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );

    return res.status(200).json({
      message: 'All notifications marked as read',
    });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
