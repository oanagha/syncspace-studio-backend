const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { notifyTaskWatchers } = require('../utils/taskWatchers');

const MAX_CONTENT_LEN = 2000;

function serializeComment(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    content: row.body,
    user: {
      id: row.user_id,
      name: row.user_name || '',
    },
    created_at: row.created_at,
  };
}

async function loadTaskAccess(taskId, userId) {
  const result = await pool.query(
    `SELECT t.id, t.project_id, t.title, p.workspace_id
     FROM tasks t
     INNER JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1`,
    [taskId]
  );

  if (result.rows.length === 0) {
    return { status: 404, message: 'Task not found' };
  }

  const task = result.rows[0];
  const membership = await getWorkspaceMembership(task.workspace_id, userId);
  if (!membership) {
    return { status: 403, message: "You don't have access to this project" };
  }

  return { task };
}

function extractMentionTokens(content) {
  return [...content.matchAll(/@([\w.-]+)/g)].map((match) => match[1].toLowerCase());
}

function userMatchesMention(user, token) {
  const name = String(user.full_name || '').toLowerCase();
  const first = name.split(/\s+/)[0] || '';
  const email = String(user.workspace_email || '').toLowerCase();
  const local = email.split('@')[0] || '';
  return first === token || name.replace(/\s+/g, '') === token || local === token;
}

async function createMentionNotifications({
  client,
  content,
  authorId,
  authorName,
  workspaceId,
  taskId,
  commentId,
}) {
  const tokens = [...new Set(extractMentionTokens(content))];
  if (tokens.length === 0) return [];

  const members = await client.query(
    `SELECT u.id, u.full_name, u.workspace_email
     FROM workspace_members wm
     INNER JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1`,
    [workspaceId]
  );

  const mentioned = members.rows.filter(
    (user) => user.id !== authorId && tokens.some((token) => userMatchesMention(user, token))
  );
  const mentionedIds = [];

  for (const user of mentioned) {
    mentionedIds.push(user.id);
    await client.query(
      `INSERT INTO notifications (
         user_id, workspace_id, type, title, body, task_id, comment_id
       )
       VALUES ($1, $2, 'mention', $3, $4, $5, $6)`,
      [
        user.id,
        workspaceId,
        `${authorName} mentioned you`,
        content.slice(0, 280),
        taskId,
        commentId,
      ]
    );
  }

  return mentionedIds;
}

async function listComments(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const result = await pool.query(
      `SELECT c.id, c.task_id, c.body, c.user_id, c.created_at, u.full_name AS user_name
       FROM task_comments c
       INNER JOIN users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [taskId]
    );

    return res.status(200).json({ comments: result.rows.map(serializeComment) });
  } catch (err) {
    console.error('List comments error:', err);
    return res.status(500).json({ message: 'Failed to load comments' });
  }
}

async function createComment(req, res) {
  try {
    const taskId = parseWorkspaceId(req.params.id);
    if (!taskId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const content = String(req.body?.content ?? req.body?.body ?? '').trim();
    if (!content) {
      return res.status(400).json({ message: 'Comment cannot be empty' });
    }
    if (content.length > MAX_CONTENT_LEN) {
      return res.status(400).json({
        message: `Comment must be at most ${MAX_CONTENT_LEN} characters`,
      });
    }

    const access = await loadTaskAccess(taskId, req.user.id);
    if (access.status) {
      return res.status(access.status).json({ message: access.message });
    }

    const author = await pool.query(
      `SELECT id, full_name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const authorName = author.rows[0]?.full_name || 'Someone';

    const inserted = await pool.query(
      `INSERT INTO task_comments (task_id, user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, task_id, body, user_id, created_at`,
      [taskId, req.user.id, content]
    );

    const row = inserted.rows[0];

    try {
      const mentionedIds = await createMentionNotifications({
        client: pool,
        content,
        authorId: req.user.id,
        authorName,
        workspaceId: access.task.workspace_id,
        taskId,
        commentId: row.id,
      });
      await notifyTaskWatchers({
        taskId,
        workspaceId: access.task.workspace_id,
        actorId: req.user.id,
        type: 'comment',
        title: `${authorName} commented on ${access.task.title}`,
        body: content.slice(0, 280),
        commentId: row.id,
        excludeUserIds: mentionedIds || [],
      });
    } catch (notifyErr) {
      console.error('Comment notification error:', notifyErr.message);
    }

    return res.status(201).json({
      comment: serializeComment({ ...row, user_name: authorName }),
    });
  } catch (err) {
    console.error('Create comment error:', err);
    return res.status(500).json({ message: 'Failed to add comment' });
  }
}

module.exports = { listComments, createComment };
