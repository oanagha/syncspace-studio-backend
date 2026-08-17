const crypto = require('crypto');
const pool = require('../config/db');

function sessionTtlMs() {
  const raw = String(process.env.JWT_EXPIRES || '7d').trim();
  const match = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * (multipliers[unit] || multipliers.d);
}

function sessionLabel(userAgent, current) {
  if (current) return 'This browser';
  const ua = String(userAgent || '');
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

  let os = '';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

function serializeSession(row, currentSessionId) {
  const current = Boolean(currentSessionId && row.id === currentSessionId);
  return {
    id: row.id,
    current,
    label: sessionLabel(row.user_agent, current),
    ip: row.ip || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

async function createSession({ userId, userAgent, ip }) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + sessionTtlMs());
  const result = await pool.query(
    `INSERT INTO user_sessions (id, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, created_at, last_seen_at, expires_at, user_agent, ip`,
    [id, userId, userAgent ? String(userAgent).slice(0, 512) : null, ip ? String(ip).slice(0, 64) : null, expiresAt]
  );
  return result.rows[0];
}

async function getActiveSession(sessionId, userId) {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT id, user_id, created_at, last_seen_at, expires_at, user_agent, ip
     FROM user_sessions
     WHERE id = $1
       AND user_id = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function touchSession(sessionId) {
  if (!sessionId) return;
  await pool.query(
    `UPDATE user_sessions
     SET last_seen_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL
       AND last_seen_at < NOW() - INTERVAL '2 minutes'`,
    [sessionId]
  );
}

async function listActiveSessions(userId) {
  const result = await pool.query(
    `SELECT id, user_id, created_at, last_seen_at, expires_at, user_agent, ip
     FROM user_sessions
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY last_seen_at DESC`,
    [userId]
  );
  return result.rows;
}

async function revokeSession(sessionId, userId) {
  const result = await pool.query(
    `UPDATE user_sessions
     SET revoked_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function revokeAllSessions(userId) {
  await pool.query(
    `UPDATE user_sessions
     SET revoked_at = NOW()
     WHERE user_id = $1
       AND revoked_at IS NULL`,
    [userId]
  );
}

async function revokeOtherSessions(userId, currentSessionId) {
  if (!currentSessionId) {
    await revokeAllSessions(userId);
    return;
  }
  await pool.query(
    `UPDATE user_sessions
     SET revoked_at = NOW()
     WHERE user_id = $1
       AND id <> $2
       AND revoked_at IS NULL`,
    [userId, currentSessionId]
  );
}

module.exports = {
  sessionTtlMs,
  sessionLabel,
  serializeSession,
  createSession,
  getActiveSession,
  touchSession,
  listActiveSessions,
  revokeSession,
  revokeAllSessions,
  revokeOtherSessions,
};
