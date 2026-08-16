const pool = require('../config/db');

async function isWatching(taskId, userId, client = pool) {
  const result = await client.query(
    `SELECT created_at
     FROM task_watchers
     WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return result.rows[0] || null;
}

async function countWatchers(taskId, client = pool) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total FROM task_watchers WHERE task_id = $1`,
    [taskId]
  );
  return result.rows[0]?.total || 0;
}

async function getActorName(userId, client = pool) {
  const result = await client.query(
    `SELECT full_name FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.full_name || 'Someone';
}

async function notifyTaskWatchers({
  taskId,
  workspaceId,
  actorId,
  type,
  title,
  body,
  commentId = null,
  excludeUserIds = [],
  client = pool,
}) {
  const excluded = new Set(
    [actorId, ...excludeUserIds].filter((id) => Number.isInteger(id) && id > 0)
  );

  const watchers = await client.query(
    `SELECT tw.user_id
     FROM task_watchers tw
     LEFT JOIN user_preferences up ON up.user_id = tw.user_id
     WHERE tw.task_id = $1
       AND COALESCE(up.notifications, TRUE) = TRUE`,
    [taskId]
  );

  for (const row of watchers.rows) {
    if (excluded.has(row.user_id)) continue;
    await client.query(
      `INSERT INTO notifications (
         user_id, workspace_id, type, title, body, task_id, comment_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.user_id, workspaceId, type, title, body, taskId, commentId]
    );
  }
}

module.exports = {
  isWatching,
  countWatchers,
  getActorName,
  notifyTaskWatchers,
};
