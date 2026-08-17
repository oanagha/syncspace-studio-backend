const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const {
  parseWorkspaceId,
  getWorkspaceMembership,
} = require('../middleware/workspace.middleware');
const { revokeOtherSessions } = require('../utils/sessions');

const THEMES = new Set(['light', 'dark', 'system']);
const LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'pt']);
const SIDEBARS = new Set(['expanded', 'collapsed']);
const DENSITIES = new Set(['comfortable', 'compact']);
const ACCENTS = new Set(['ocean', 'teal', 'aqua', 'emerald', 'amber']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 6;
const MIN_NAME_LEN = 3;
const MAX_NAME_LEN = 100;

const DEFAULTS = {
  theme: 'system',
  language: 'en',
  notifications: true,
  sidebar: 'expanded',
  density: 'comfortable',
  accent: 'ocean',
  reduceMotion: true,
  notifyMentions: true,
  notifyAssignments: true,
  notifyDueDates: true,
  notifyFiles: false,
  notifyDigest: true,
  twoFactor: false,
  loginAlerts: true,
  slack: true,
  github: true,
  figma: false,
  googleDrive: false,
  jobTitle: '',
  timezone: '',
  bio: '',
  fullName: '',
  email: '',
  avatarUrl: null,
  guestAccess: true,
  require2fa: false,
  publicTemplates: true,
  workspaceName: '',
  workspaceId: null,
};

const PREF_COLUMNS = `
  theme, language, notifications, sidebar, density, accent, reduce_motion,
  notify_mentions, notify_assignments, notify_due_dates, notify_files, notify_digest,
  two_factor, login_alerts, slack, github, figma, google_drive
`;

function hasField(body, ...keys) {
  return keys.some((key) => body?.[key] !== undefined);
}

function pick(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] !== undefined) return body[key];
  }
  return undefined;
}

function asBoolean(value, field) {
  if (typeof value === 'boolean') return { value };
  if (value === 'true' || value === 'false') return { value: value === 'true' };
  return { error: `${field} must be true or false` };
}

function asEnum(value, allowed, field, labels) {
  const next = String(value ?? '').trim();
  if (!allowed.has(next)) {
    return { error: `${field} must be ${labels}` };
  }
  return { value: next };
}

function serializePreferences(pref, user, workspace) {
  const row = pref || {};
  return {
    theme: row.theme || DEFAULTS.theme,
    language: row.language || DEFAULTS.language,
    notifications: row.notifications ?? DEFAULTS.notifications,
    sidebar: row.sidebar || DEFAULTS.sidebar,
    density: row.density || DEFAULTS.density,
    accent: row.accent || DEFAULTS.accent,
    reduceMotion: row.reduce_motion ?? DEFAULTS.reduceMotion,
    notifyMentions: row.notify_mentions ?? DEFAULTS.notifyMentions,
    notifyAssignments: row.notify_assignments ?? DEFAULTS.notifyAssignments,
    notifyDueDates: row.notify_due_dates ?? DEFAULTS.notifyDueDates,
    notifyFiles: row.notify_files ?? DEFAULTS.notifyFiles,
    notifyDigest: row.notify_digest ?? DEFAULTS.notifyDigest,
    twoFactor: Boolean(user?.totp_enabled),
    loginAlerts: row.login_alerts ?? DEFAULTS.loginAlerts,
    slack: row.slack ?? DEFAULTS.slack,
    github: row.github ?? DEFAULTS.github,
    figma: row.figma ?? DEFAULTS.figma,
    googleDrive: row.google_drive ?? DEFAULTS.googleDrive,
    fullName: user?.full_name || DEFAULTS.fullName,
    email: user?.workspace_email || DEFAULTS.email,
    jobTitle: user?.job_title || DEFAULTS.jobTitle,
    timezone: user?.timezone || DEFAULTS.timezone,
    bio: user?.bio || DEFAULTS.bio,
    avatarUrl: user?.avatar_url || null,
    workspaceId: workspace?.id || null,
    workspaceName: workspace?.name || DEFAULTS.workspaceName,
    guestAccess: workspace?.guest_access ?? DEFAULTS.guestAccess,
    require2fa: workspace?.require_2fa ?? DEFAULTS.require2fa,
    publicTemplates: workspace?.public_templates ?? DEFAULTS.publicTemplates,
  };
}

async function loadUser(userId) {
  const result = await pool.query(
    `SELECT id, full_name, workspace_email, job_title, timezone, bio, avatar_url,
            password_hash, totp_enabled
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.full_name,
    email: user.workspace_email,
    avatarUrl: user.avatar_url || null,
  };
}

function publicPathToStorageKey(avatarUrl) {
  if (!avatarUrl) return null;
  const value = String(avatarUrl);
  if (value.startsWith('/uploads/')) {
    return value.slice('/uploads/'.length);
  }
  return value.replace(/^\/+/, '');
}

async function loadPreferences(userId) {
  const result = await pool.query(
    `SELECT ${PREF_COLUMNS}
     FROM user_preferences
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function loadWorkspaceSettings(workspaceId, userId) {
  if (!workspaceId) return null;
  const membership = await getWorkspaceMembership(workspaceId, userId);
  if (!membership) return { error: { status: 403, message: "You don't have access to this workspace" } };

  const result = await pool.query(
    `SELECT id, name, guest_access, require_2fa, public_templates
     FROM workspaces
     WHERE id = $1`,
    [workspaceId]
  );
  const row = result.rows[0];
  if (!row) return { error: { status: 404, message: 'Workspace not found' } };
  return { workspace: row, role: membership.role };
}

async function getPreferences(req, res) {
  try {
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const workspaceId = parseWorkspaceId(
      req.query.workspaceId ?? req.query.workspace_id
    );
    let workspace = null;
    if (workspaceId) {
      const loaded = await loadWorkspaceSettings(workspaceId, req.user.id);
      if (loaded.error) {
        return res.status(loaded.error.status).json({ message: loaded.error.message });
      }
      workspace = loaded.workspace;
    }

    return res.status(200).json({
      preferences: serializePreferences(await loadPreferences(req.user.id), user, workspace),
      user: serializeUser(user),
    });
  } catch (err) {
    console.error('Get preferences error:', err);
    return res.status(500).json({ message: 'Failed to load preferences' });
  }
}

async function updatePreferences(req, res) {
  const client = await pool.connect();

  try {
    const body = req.body ?? {};
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const prefPatch = {};
    const userPatch = {};
    let workspacePatch = null;
    let workspaceId = parseWorkspaceId(pick(body, 'workspaceId', 'workspace_id'));

    const setEnum = (keys, allowed, field, labels, column) => {
      if (!hasField(body, ...keys)) return null;
      const parsed = asEnum(pick(body, ...keys), allowed, field, labels);
      if (parsed.error) return parsed.error;
      prefPatch[column] = parsed.value;
      return null;
    };

    const setBool = (keys, field, column) => {
      if (!hasField(body, ...keys)) return null;
      const parsed = asBoolean(pick(body, ...keys), field);
      if (parsed.error) return parsed.error;
      prefPatch[column] = parsed.value;
      return null;
    };

    const enumError =
      setEnum(['theme'], THEMES, 'theme', 'light, dark, or system', 'theme') ||
      setEnum(['language'], LANGUAGES, 'language', 'en, es, fr, de, or pt', 'language') ||
      setEnum(['sidebar'], SIDEBARS, 'sidebar', 'expanded or collapsed', 'sidebar') ||
      setEnum(['density'], DENSITIES, 'density', 'comfortable or compact', 'density') ||
      setEnum(['accent'], ACCENTS, 'accent', 'ocean, teal, aqua, emerald, or amber', 'accent');
    if (enumError) {
      return res.status(400).json({ message: enumError });
    }

    const boolError =
      setBool(['notifications'], 'notifications', 'notifications') ||
      setBool(['reduceMotion', 'reduce_motion'], 'reduceMotion', 'reduce_motion') ||
      setBool(['notifyMentions', 'notify_mentions'], 'notifyMentions', 'notify_mentions') ||
      setBool(['notifyAssignments', 'notify_assignments'], 'notifyAssignments', 'notify_assignments') ||
      setBool(['notifyDueDates', 'notify_due_dates'], 'notifyDueDates', 'notify_due_dates') ||
      setBool(['notifyFiles', 'notify_files'], 'notifyFiles', 'notify_files') ||
      setBool(['notifyDigest', 'notify_digest'], 'notifyDigest', 'notify_digest') ||
      setBool(['loginAlerts', 'login_alerts'], 'loginAlerts', 'login_alerts') ||
      setBool(['slack'], 'slack', 'slack') ||
      setBool(['github'], 'github', 'github') ||
      setBool(['figma'], 'figma', 'figma') ||
      setBool(['googleDrive', 'google_drive'], 'googleDrive', 'google_drive');
    if (boolError) {
      return res.status(400).json({ message: boolError });
    }

    // twoFactor is controlled by /api/auth/2fa/* — keep preference in sync with enrollment.
    prefPatch.two_factor = Boolean(user.totp_enabled);

    if (hasField(body, 'fullName', 'full_name')) {
      const fullName = String(pick(body, 'fullName', 'full_name') ?? '').trim();
      if (!fullName) {
        return res.status(400).json({ message: 'fullName is required' });
      }
      if (fullName.length > 255) {
        return res.status(400).json({ message: 'fullName must be at most 255 characters' });
      }
      userPatch.full_name = fullName;
    }

    if (hasField(body, 'email', 'workspace_email')) {
      const email = String(pick(body, 'email', 'workspace_email') ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ message: 'Valid email is required' });
      }
      const taken = await pool.query(
        `SELECT id FROM users WHERE lower(workspace_email) = $1 AND id <> $2`,
        [email, req.user.id]
      );
      if (taken.rows.length) {
        return res.status(409).json({ message: 'That email is already in use' });
      }
      userPatch.workspace_email = email;
    }

    if (hasField(body, 'jobTitle', 'job_title')) {
      userPatch.job_title = String(pick(body, 'jobTitle', 'job_title') ?? '').trim().slice(0, 120) || null;
    }
    if (hasField(body, 'timezone')) {
      userPatch.timezone = String(body.timezone ?? '').trim().slice(0, 80) || null;
    }
    if (hasField(body, 'bio')) {
      const bio = String(body.bio ?? '').trim();
      if (bio.length > 1000) {
        return res.status(400).json({ message: 'bio must be at most 1000 characters' });
      }
      userPatch.bio = bio || null;
    }

    const newPassword = pick(body, 'newPassword', 'new_password');
    const currentPassword = pick(body, 'currentPassword', 'current_password');
    if (newPassword !== undefined || currentPassword !== undefined) {
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'currentPassword and newPassword are required together' });
      }
      if (String(newPassword).length < MIN_PASSWORD_LEN) {
        return res.status(400).json({
          message: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
        });
      }
      const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
      if (!ok) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }
      userPatch.password_hash = await bcrypt.hash(String(newPassword), 12);
    }

    const passwordChanged = Boolean(userPatch.password_hash);

    const workspaceFields = hasField(
      body,
      'workspaceName',
      'workspace_name',
      'guestAccess',
      'guest_access',
      'require2fa',
      'require_2fa',
      'publicTemplates',
      'public_templates'
    );
    if (workspaceFields) {
      if (!workspaceId) {
        return res.status(400).json({ message: 'workspaceId is required to update workspace settings' });
      }
      workspacePatch = {};
      if (hasField(body, 'workspaceName', 'workspace_name')) {
        const name = String(pick(body, 'workspaceName', 'workspace_name') ?? '').trim();
        if (name.length < MIN_NAME_LEN || name.length > MAX_NAME_LEN) {
          return res.status(400).json({
            message: `Workspace name must be between ${MIN_NAME_LEN} and ${MAX_NAME_LEN} characters`,
          });
        }
        workspacePatch.name = name;
      }
      if (hasField(body, 'guestAccess', 'guest_access')) {
        const parsed = asBoolean(pick(body, 'guestAccess', 'guest_access'), 'guestAccess');
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        workspacePatch.guest_access = parsed.value;
      }
      if (hasField(body, 'require2fa', 'require_2fa')) {
        const parsed = asBoolean(pick(body, 'require2fa', 'require_2fa'), 'require2fa');
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        workspacePatch.require_2fa = parsed.value;
      }
      if (hasField(body, 'publicTemplates', 'public_templates')) {
        const parsed = asBoolean(pick(body, 'publicTemplates', 'public_templates'), 'publicTemplates');
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        workspacePatch.public_templates = parsed.value;
      }
    }

    if (
      Object.keys(prefPatch).length === 0 &&
      Object.keys(userPatch).length === 0 &&
      !workspacePatch
    ) {
      return res.status(400).json({ message: 'Provide at least one settings field' });
    }

    await client.query('BEGIN');

    if (Object.keys(prefPatch).length) {
      const current = await loadPreferences(req.user.id);
      const merged = {
        theme: prefPatch.theme ?? current?.theme ?? DEFAULTS.theme,
        language: prefPatch.language ?? current?.language ?? DEFAULTS.language,
        notifications: prefPatch.notifications ?? current?.notifications ?? DEFAULTS.notifications,
        sidebar: prefPatch.sidebar ?? current?.sidebar ?? DEFAULTS.sidebar,
        density: prefPatch.density ?? current?.density ?? DEFAULTS.density,
        accent: prefPatch.accent ?? current?.accent ?? DEFAULTS.accent,
        reduce_motion: prefPatch.reduce_motion ?? current?.reduce_motion ?? DEFAULTS.reduceMotion,
        notify_mentions: prefPatch.notify_mentions ?? current?.notify_mentions ?? DEFAULTS.notifyMentions,
        notify_assignments:
          prefPatch.notify_assignments ?? current?.notify_assignments ?? DEFAULTS.notifyAssignments,
        notify_due_dates: prefPatch.notify_due_dates ?? current?.notify_due_dates ?? DEFAULTS.notifyDueDates,
        notify_files: prefPatch.notify_files ?? current?.notify_files ?? DEFAULTS.notifyFiles,
        notify_digest: prefPatch.notify_digest ?? current?.notify_digest ?? DEFAULTS.notifyDigest,
        two_factor: prefPatch.two_factor ?? current?.two_factor ?? DEFAULTS.twoFactor,
        login_alerts: prefPatch.login_alerts ?? current?.login_alerts ?? DEFAULTS.loginAlerts,
        slack: prefPatch.slack ?? current?.slack ?? DEFAULTS.slack,
        github: prefPatch.github ?? current?.github ?? DEFAULTS.github,
        figma: prefPatch.figma ?? current?.figma ?? DEFAULTS.figma,
        google_drive: prefPatch.google_drive ?? current?.google_drive ?? DEFAULTS.googleDrive,
      };

      await client.query(
        `INSERT INTO user_preferences (
           user_id, theme, language, notifications, sidebar, density, accent, reduce_motion,
           notify_mentions, notify_assignments, notify_due_dates, notify_files, notify_digest,
           two_factor, login_alerts, slack, github, figma, google_drive
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
         )
         ON CONFLICT (user_id) DO UPDATE SET
           theme = EXCLUDED.theme,
           language = EXCLUDED.language,
           notifications = EXCLUDED.notifications,
           sidebar = EXCLUDED.sidebar,
           density = EXCLUDED.density,
           accent = EXCLUDED.accent,
           reduce_motion = EXCLUDED.reduce_motion,
           notify_mentions = EXCLUDED.notify_mentions,
           notify_assignments = EXCLUDED.notify_assignments,
           notify_due_dates = EXCLUDED.notify_due_dates,
           notify_files = EXCLUDED.notify_files,
           notify_digest = EXCLUDED.notify_digest,
           two_factor = EXCLUDED.two_factor,
           login_alerts = EXCLUDED.login_alerts,
           slack = EXCLUDED.slack,
           github = EXCLUDED.github,
           figma = EXCLUDED.figma,
           google_drive = EXCLUDED.google_drive,
           updated_at = NOW()`,
        [
          req.user.id,
          merged.theme,
          merged.language,
          merged.notifications,
          merged.sidebar,
          merged.density,
          merged.accent,
          merged.reduce_motion,
          merged.notify_mentions,
          merged.notify_assignments,
          merged.notify_due_dates,
          merged.notify_files,
          merged.notify_digest,
          merged.two_factor,
          merged.login_alerts,
          merged.slack,
          merged.github,
          merged.figma,
          merged.google_drive,
        ]
      );
    }

    if (Object.keys(userPatch).length) {
      const fields = [];
      const values = [];
      let idx = 1;
      for (const [column, value] of Object.entries(userPatch)) {
        fields.push(`${column} = $${idx}`);
        values.push(value);
        idx += 1;
      }
      values.push(req.user.id);
      await client.query(
        `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
        values
      );
    }

    if (workspacePatch) {
      const loaded = await loadWorkspaceSettings(workspaceId, req.user.id);
      if (loaded.error) {
        await client.query('ROLLBACK');
        return res.status(loaded.error.status).json({ message: loaded.error.message });
      }
      if (loaded.role !== 'Owner' && loaded.role !== 'Admin') {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'Only owners and admins can update workspace settings' });
      }

      const fields = [];
      const values = [];
      let idx = 1;
      for (const [column, value] of Object.entries(workspacePatch)) {
        fields.push(`${column} = $${idx}`);
        values.push(value);
        idx += 1;
      }
      values.push(workspaceId);
      await client.query(
        `UPDATE workspaces SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
        values
      );
    }

    await client.query('COMMIT');

    if (passwordChanged) {
      await revokeOtherSessions(req.user.id, req.user.sessionId || null);
    }

    const nextUser = await loadUser(req.user.id);
    let workspace = null;
    if (workspaceId) {
      const loaded = await loadWorkspaceSettings(workspaceId, req.user.id);
      workspace = loaded.workspace || null;
    }

    return res.status(200).json({
      preferences: serializePreferences(await loadPreferences(req.user.id), nextUser, workspace),
      user: serializeUser(nextUser),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23514') {
      return res.status(400).json({ message: 'One or more preference values are not supported' });
    }
    console.error('Update preferences error:', err);
    return res.status(500).json({ message: 'Failed to save preferences' });
  } finally {
    client.release();
  }
}

async function uploadAvatar(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'avatar file is required' });
    }

    const {
      saveAvatarFile,
      deleteStoredFile,
      isAllowedAvatar,
      getAvatarMaxBytes,
    } = require('../services/storage.service');

    if (!isAllowedAvatar(req.file)) {
      return res.status(400).json({ message: 'Avatar must be a PNG, JPEG, or WebP image' });
    }

    if (req.file.size > getAvatarMaxBytes()) {
      return res.status(400).json({ message: 'Avatar must be 2 MB or smaller' });
    }

    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const saved = await saveAvatarFile({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      userId: req.user.id,
    });

    const previousKey = publicPathToStorageKey(user.avatar_url);

    await pool.query(
      `UPDATE users
       SET avatar_url = $1, updated_at = NOW()
       WHERE id = $2`,
      [saved.public_path, req.user.id]
    );

    if (previousKey && previousKey !== saved.storage_key) {
      try {
        await deleteStoredFile(previousKey);
      } catch (cleanupErr) {
        console.error('Previous avatar cleanup failed:', cleanupErr);
      }
    }

    const nextUser = await loadUser(req.user.id);
    return res.status(200).json({
      message: 'Avatar updated',
      preferences: serializePreferences(await loadPreferences(req.user.id), nextUser, null),
      user: serializeUser(nextUser),
    });
  } catch (err) {
    console.error('Upload avatar error:', err);
    return res.status(500).json({ message: 'Failed to upload avatar' });
  }
}

async function removeAvatar(req, res) {
  try {
    const { deleteStoredFile } = require('../services/storage.service');
    const user = await loadUser(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const previousKey = publicPathToStorageKey(user.avatar_url);

    await pool.query(
      `UPDATE users
       SET avatar_url = NULL, updated_at = NOW()
       WHERE id = $1`,
      [req.user.id]
    );

    if (previousKey) {
      try {
        await deleteStoredFile(previousKey);
      } catch (cleanupErr) {
        console.error('Avatar file cleanup failed:', cleanupErr);
      }
    }

    const nextUser = await loadUser(req.user.id);
    return res.status(200).json({
      message: 'Avatar removed',
      preferences: serializePreferences(await loadPreferences(req.user.id), nextUser, null),
      user: serializeUser(nextUser),
    });
  } catch (err) {
    console.error('Remove avatar error:', err);
    return res.status(500).json({ message: 'Failed to remove avatar' });
  }
}

module.exports = {
  getPreferences,
  updatePreferences,
  uploadAvatar,
  removeAvatar,
};
