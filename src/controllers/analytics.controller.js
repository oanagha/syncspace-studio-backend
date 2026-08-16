const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');

const ALLOWED_RANGES = new Set(['7d', '30d', 'quarter', 'year']);
const AVATAR_COLORS = ['#1A4A6E', '#2D8A9E', '#5CBDB9', '#2F9E7D', '#D9A441', '#E07A5F'];
const STATUS_COLORS = {
  Done: '#2F9E7D',
  Completed: '#2F9E7D',
  'In Progress': '#1A4A6E',
  Review: '#D9A441',
  Todo: '#2D8A9E',
  Backlog: '#5CBDB9',
};

function avatarColor(id) {
  return AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length];
}

function initials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?';
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function startOfRange(range) {
  const now = new Date();
  if (range === '7d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (range === '30d') {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (range === 'quarter') {
    const quarter = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), quarter, 1);
  }
  return new Date(now.getFullYear(), 0, 1);
}

function previousPeriod(start, range) {
  const prevEnd = new Date(start);
  prevEnd.setMilliseconds(prevEnd.getMilliseconds() - 1);
  const prevStart = new Date(start);
  if (range === '7d') prevStart.setDate(prevStart.getDate() - 7);
  else if (range === '30d') prevStart.setDate(prevStart.getDate() - 30);
  else if (range === 'quarter') prevStart.setMonth(prevStart.getMonth() - 3);
  else prevStart.setFullYear(prevStart.getFullYear() - 1);
  return { prevStart, prevEnd };
}

function daysInRange(start) {
  const ms = Date.now() - start.getTime();
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

function formatDeltaPercent(current, previous) {
  if (previous === 0) {
    if (current === 0) return '0%';
    return `+${current}`;
  }
  const delta = Math.round(((current - previous) / previous) * 100);
  return `${delta > 0 ? '+' : ''}${delta}%`;
}

function formatDeltaNumber(current, previous, suffix = '') {
  const delta = current - previous;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Number.isInteger(delta) ? delta : delta.toFixed(1)}${suffix}`;
}

function serializeUser(row) {
  const name = row.full_name || row.workspace_email || 'Member';
  return {
    id: row.id,
    name,
    initials: initials(name),
    color: avatarColor(row.id),
  };
}

function relativeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDue(value) {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function getDashboard(req, res) {
  try {
    const workspaceId = parseWorkspaceId(req.query.workspaceId ?? req.query.workspace_id);
    const rangeRaw = String(req.query.range ?? '7d').trim().toLowerCase() || '7d';

    if (!workspaceId || !ALLOWED_RANGES.has(rangeRaw)) {
      return res.status(400).json({ message: 'Invalid workspace or range' });
    }

    const membership = await getWorkspaceMembership(workspaceId, req.user.id);
    if (!membership) {
      // Same status for missing and inaccessible to avoid workspace id oracle.
      return res.status(404).json({ message: 'Workspace not found' });
    }

    const range = rangeRaw;
    const start = startOfRange(range);
    const { prevStart, prevEnd } = previousPeriod(start, range);
    const days = daysInRange(start);
    const startIso = start.toISOString();
    const prevStartIso = prevStart.toISOString();
    const prevEndIso = prevEnd.toISOString();

    const userResult = await pool.query(
      `SELECT id, full_name, workspace_email FROM users WHERE id = $1`,
      [req.user.id]
    );
    const userRow = userResult.rows[0] || { id: req.user.id, full_name: 'Member' };

    const [
      totals,
      dueToday,
      activityTasks,
      activityComments,
      activityProjects,
      throughputRows,
      statusRows,
      workloadRows,
      projectRows,
      periodStats,
      prevPeriodStats,
    ] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(t.id)::int AS total_tasks,
           COUNT(t.id) FILTER (WHERE t.column_name = 'Done')::int AS completed_tasks,
           COUNT(t.id) FILTER (WHERE t.column_name = 'Review')::int AS reviews_waiting,
           COUNT(DISTINCT p.id)::int AS project_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         WHERE p.workspace_id = $1`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           t.id,
           t.title,
           t.column_name,
           t.due_date::text AS due_date,
           u.id AS assignee_id,
           u.full_name AS assignee_name
         FROM tasks t
         INNER JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE p.workspace_id = $1
           AND t.due_date = CURRENT_DATE
           AND t.column_name <> 'Done'
         ORDER BY t.priority DESC, t.title ASC
         LIMIT 8`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           t.id,
           t.title,
           t.created_at,
           u.id AS user_id,
           u.full_name AS user_name
         FROM tasks t
         INNER JOIN projects p ON p.id = t.project_id
         INNER JOIN users u ON u.id = t.created_by
         WHERE p.workspace_id = $1
         ORDER BY t.created_at DESC
         LIMIT 8`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           c.id,
           t.title,
           c.created_at,
           u.id AS user_id,
           u.full_name AS user_name
         FROM task_comments c
         INNER JOIN tasks t ON t.id = c.task_id
         INNER JOIN projects p ON p.id = t.project_id
         INNER JOIN users u ON u.id = c.user_id
         WHERE p.workspace_id = $1
         ORDER BY c.created_at DESC
         LIMIT 8`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           p.id,
           p.title,
           p.created_at,
           u.id AS user_id,
           u.full_name AS user_name
         FROM projects p
         INNER JOIN users u ON u.id = p.created_by
         WHERE p.workspace_id = $1
         ORDER BY p.created_at DESC
         LIMIT 5`,
        [workspaceId]
      ),
      pool.query(
        range === 'year'
          ? `SELECT
               date_trunc('month', gs)::date AS bucket,
               to_char(gs, 'Mon') AS label,
               COUNT(t.id) FILTER (
                 WHERE t.created_at >= date_trunc('month', gs)
                   AND t.created_at < date_trunc('month', gs) + INTERVAL '1 month'
               )::int AS created,
               COUNT(t.id) FILTER (
                 WHERE t.column_name = 'Done'
                   AND COALESCE(t.updated_at, t.created_at) >= date_trunc('month', gs)
                   AND COALESCE(t.updated_at, t.created_at) < date_trunc('month', gs) + INTERVAL '1 month'
               )::int AS completed
             FROM generate_series($2::timestamp, CURRENT_TIMESTAMP, INTERVAL '1 month') gs
             LEFT JOIN projects p ON p.workspace_id = $1
             LEFT JOIN tasks t ON t.project_id = p.id
             GROUP BY gs
             ORDER BY gs`
          : range === 'quarter'
            ? `SELECT
                 date_trunc('week', gs)::date AS bucket,
                 'W' || to_char(gs, 'IW') AS label,
                 COUNT(t.id) FILTER (
                   WHERE t.created_at >= date_trunc('week', gs)
                     AND t.created_at < date_trunc('week', gs) + INTERVAL '7 days'
                 )::int AS created,
                 COUNT(t.id) FILTER (
                   WHERE t.column_name = 'Done'
                     AND COALESCE(t.updated_at, t.created_at) >= date_trunc('week', gs)
                     AND COALESCE(t.updated_at, t.created_at) < date_trunc('week', gs) + INTERVAL '7 days'
                 )::int AS completed
               FROM generate_series($2::timestamp, CURRENT_TIMESTAMP, INTERVAL '7 days') gs
               LEFT JOIN projects p ON p.workspace_id = $1
               LEFT JOIN tasks t ON t.project_id = p.id
               GROUP BY gs
               ORDER BY gs`
            : `SELECT
                 gs::date AS bucket,
                 to_char(gs, 'Dy') AS label,
                 COUNT(t.id) FILTER (WHERE t.created_at::date = gs::date)::int AS created,
                 COUNT(t.id) FILTER (
                   WHERE t.column_name = 'Done'
                     AND COALESCE(t.updated_at, t.created_at)::date = gs::date
                 )::int AS completed
               FROM generate_series($2::date, CURRENT_DATE, INTERVAL '1 day') gs
               LEFT JOIN projects p ON p.workspace_id = $1
               LEFT JOIN tasks t ON t.project_id = p.id
               GROUP BY gs
               ORDER BY gs`,
        [workspaceId, startIso]
      ),
      pool.query(
        `SELECT
           COALESCE(t.column_name, 'Todo') AS name,
           COUNT(t.id)::int AS value
         FROM projects p
         INNER JOIN tasks t ON t.project_id = p.id
         WHERE p.workspace_id = $1
         GROUP BY t.column_name
         ORDER BY value DESC`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           u.id,
           u.full_name,
           COUNT(t.id)::int AS value
         FROM workspace_members wm
         INNER JOIN users u ON u.id = wm.user_id
         LEFT JOIN projects p ON p.workspace_id = wm.workspace_id
         LEFT JOIN tasks t ON t.project_id = p.id AND t.assignee_id = u.id
         WHERE wm.workspace_id = $1
         GROUP BY u.id, u.full_name
         HAVING COUNT(t.id) > 0
         ORDER BY value DESC, u.full_name ASC
         LIMIT 8`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           id, title, color, status, progress, total_tasks, completed_tasks,
           deadline::text AS deadline
         FROM projects
         WHERE workspace_id = $1
         ORDER BY
           CASE status WHEN 'At Risk' THEN 0 WHEN 'On Track' THEN 1 ELSE 2 END,
           updated_at DESC
         LIMIT 8`,
        [workspaceId]
      ),
      pool.query(
        `SELECT
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND COALESCE(t.updated_at, t.created_at) >= $2
           )::int AS completed,
           COUNT(DISTINCT t.assignee_id) FILTER (
             WHERE t.assignee_id IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
           )::int AS collaborators,
           COALESCE(AVG(EXTRACT(EPOCH FROM (
             COALESCE(t.updated_at, t.created_at) - t.created_at
           )) / 86400) FILTER (
             WHERE t.column_name = 'Done'
               AND COALESCE(t.updated_at, t.created_at) >= $2
           ), 0) AS avg_cycle_days,
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND t.due_date IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
           )::int AS dated_done,
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND t.due_date IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at)::date <= t.due_date
           )::int AS on_time
         FROM tasks t
         INNER JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = $1`,
        [workspaceId, startIso]
      ),
      pool.query(
        `SELECT
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at) <= $3
           )::int AS completed,
           COUNT(DISTINCT t.assignee_id) FILTER (
             WHERE t.assignee_id IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at) <= $3
           )::int AS collaborators,
           COALESCE(AVG(EXTRACT(EPOCH FROM (
             COALESCE(t.updated_at, t.created_at) - t.created_at
           )) / 86400) FILTER (
             WHERE t.column_name = 'Done'
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at) <= $3
           ), 0) AS avg_cycle_days,
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND t.due_date IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at) <= $3
           )::int AS dated_done,
           COUNT(t.id) FILTER (
             WHERE t.column_name = 'Done'
               AND t.due_date IS NOT NULL
               AND COALESCE(t.updated_at, t.created_at) >= $2
               AND COALESCE(t.updated_at, t.created_at) <= $3
               AND COALESCE(t.updated_at, t.created_at)::date <= t.due_date
           )::int AS on_time
         FROM tasks t
         INNER JOIN projects p ON p.id = t.project_id
         WHERE p.workspace_id = $1`,
        [workspaceId, prevStartIso, prevEndIso]
      ),
    ]);

    const totalTasks = Number(totals.rows[0]?.total_tasks) || 0;
    const completedTasks = Number(totals.rows[0]?.completed_tasks) || 0;
    const reviewsWaiting = Number(totals.rows[0]?.reviews_waiting) || 0;
    const productivityScore =
      totalTasks === 0 ? 0 : Math.round((completedTasks * 100) / totalTasks);

    const period = periodStats.rows[0] || {};
    const prev = prevPeriodStats.rows[0] || {};
    const completedInRange = Number(period.completed) || 0;
    const prevCompleted = Number(prev.completed) || 0;
    const avgCycle = Number(period.avg_cycle_days) || 0;
    const prevCycle = Number(prev.avg_cycle_days) || 0;
    const datedDone = Number(period.dated_done) || 0;
    const onTimeCount = Number(period.on_time) || 0;
    const prevDated = Number(prev.dated_done) || 0;
    const prevOnTimeCount = Number(prev.on_time) || 0;
    const onTimePct = datedDone === 0 ? 0 : Math.round((onTimeCount * 100) / datedDone);
    const prevOnTimePct = prevDated === 0 ? 0 : Math.round((prevOnTimeCount * 100) / prevDated);
    const collaborators = Number(period.collaborators) || 0;
    const prevCollaborators = Number(prev.collaborators) || 0;
    const velocity = Number((completedInRange / days).toFixed(1));
    const hoursSaved = completedInRange;

    const activity = [
      ...activityComments.rows.map((row) => ({
        id: `comment-${row.id}`,
        created_at: row.created_at,
        action: 'commented on',
        target: row.title,
        user: serializeUser({ id: row.user_id, full_name: row.user_name }),
      })),
      ...activityTasks.rows.map((row) => ({
        id: `task-${row.id}`,
        created_at: row.created_at,
        action: 'created',
        target: row.title,
        user: serializeUser({ id: row.user_id, full_name: row.user_name }),
      })),
      ...activityProjects.rows.map((row) => ({
        id: `project-${row.id}`,
        created_at: row.created_at,
        action: 'created project',
        target: row.title,
        user: serializeUser({ id: row.user_id, full_name: row.user_name }),
      })),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        action: item.action,
        target: item.target,
        time: relativeTime(item.created_at),
        user: item.user,
      }));

    const throughput = throughputRows.rows.map((row) => ({
      day: row.label,
      week: row.label,
      created: Number(row.created) || 0,
      completed: Number(row.completed) || 0,
      target: Number(row.created) || 0,
    }));

    const groupedStatus = new Map();
    for (const row of statusRows.rows) {
      const raw = row.name;
      const name =
        raw === 'Done' ? 'Completed' : raw === 'Todo' ? 'Backlog' : raw;
      const current = groupedStatus.get(name) || { name, value: 0, color: STATUS_COLORS[name] || STATUS_COLORS[raw] || '#5CBDB9' };
      current.value += Number(row.value) || 0;
      groupedStatus.set(name, current);
    }
    const status_breakdown = Array.from(groupedStatus.values());

    const workload = workloadRows.rows.map((row) => ({
      name: firstName(row.full_name),
      value: Number(row.value) || 0,
      color: avatarColor(row.id),
    }));

    const project_health = projectRows.rows.map((row) => ({
      id: row.id,
      name: row.title,
      progress: Number(row.progress) || 0,
      accent: row.color || '#1A4A6E',
      status: row.status,
      tasks: Number(row.total_tasks) || 0,
      done: Number(row.completed_tasks) || 0,
      due: formatDue(row.deadline),
    }));

    const due_today = dueToday.rows.map((row) => ({
      id: row.id,
      title: row.title,
      due: formatDue(row.due_date) || 'Today',
      column: row.column_name,
      assignee: row.assignee_name
        ? serializeUser({ id: row.assignee_id, full_name: row.assignee_name })
        : { id: 0, name: 'Unassigned', initials: '—', color: '#94A3B8' },
    }));

    return res.status(200).json({
      user: {
        id: userRow.id,
        name: userRow.full_name || 'Member',
        first_name: firstName(userRow.full_name),
      },
      productivity_score: productivityScore,
      due_today,
      activity,
      throughput,
      status_breakdown,
      workload,
      project_health,
      kpis: {
        total_tasks: totalTasks,
        completion: productivityScore,
        velocity,
        hours_saved: hoursSaved,
        reviews_waiting: reviewsWaiting,
        due_today_count: due_today.length,
      },
      stats: {
        tasks_completed: completedInRange,
        avg_cycle_time: Number(avgCycle.toFixed(1)),
        on_time_delivery: onTimePct,
        active_collaborators: collaborators,
        tasks_completed_delta: formatDeltaPercent(completedInRange, prevCompleted),
        cycle_time_delta: formatDeltaNumber(Number(avgCycle.toFixed(1)), Number(prevCycle.toFixed(1)), 'd'),
        on_time_delta: formatDeltaPercent(onTimePct, prevOnTimePct),
        collaborators_delta: formatDeltaNumber(collaborators, prevCollaborators),
      },
      range,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Analytics dashboard error:', err);
    return res.status(500).json({ message: 'Failed to load analytics' });
  }
}

module.exports = { getDashboard };
