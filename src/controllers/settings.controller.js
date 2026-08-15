const pool = require('../config/db');

const THEMES = new Set(['light', 'dark', 'system']);
const LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'pt']);
const SIDEBARS = new Set(['expanded', 'collapsed']);
const ALLOWED_KEYS = new Set(['theme', 'language', 'notifications', 'sidebar']);

const DEFAULTS = {
  theme: 'system',
  language: 'en',
  notifications: true,
  sidebar: 'expanded',
};

function serialize(row) {
  return {
    theme: row.theme,
    language: row.language,
    notifications: row.notifications,
    sidebar: row.sidebar,
  };
}

async function getPreferences(req, res) {
  try {
    const result = await pool.query(
      `SELECT theme, language, notifications, sidebar
       FROM user_preferences
       WHERE user_id = $1`,
      [req.user.id]
    );

    return res.status(200).json({
      preferences: result.rows[0] ? serialize(result.rows[0]) : { ...DEFAULTS },
    });
  } catch (err) {
    console.error('Get preferences error:', err);
    return res.status(500).json({ message: 'Failed to load preferences' });
  }
}

async function updatePreferences(req, res) {
  try {
    const body = req.body ?? {};
    const extra = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
    if (extra.length) {
      return res.status(400).json({ message: `Unsupported field: ${extra[0]}` });
    }

    const patch = {};

    if (body.theme !== undefined) {
      const theme = String(body.theme).trim();
      if (!THEMES.has(theme)) {
        return res.status(400).json({ message: 'theme must be light, dark, or system' });
      }
      patch.theme = theme;
    }

    if (body.language !== undefined) {
      const language = String(body.language).trim();
      if (!LANGUAGES.has(language)) {
        return res.status(400).json({ message: 'language must be en, es, fr, de, or pt' });
      }
      patch.language = language;
    }

    if (body.notifications !== undefined) {
      if (typeof body.notifications !== 'boolean') {
        return res.status(400).json({ message: 'notifications must be true or false' });
      }
      patch.notifications = body.notifications;
    }

    if (body.sidebar !== undefined) {
      const sidebar = String(body.sidebar).trim();
      if (!SIDEBARS.has(sidebar)) {
        return res.status(400).json({ message: 'sidebar must be expanded or collapsed' });
      }
      patch.sidebar = sidebar;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ message: 'Provide theme, language, notifications, or sidebar' });
    }

    const result = await pool.query(
      `INSERT INTO user_preferences (user_id, theme, language, notifications, sidebar)
       VALUES ($1, COALESCE($2, 'system'), COALESCE($3, 'en'), COALESCE($4, TRUE), COALESCE($5, 'expanded'))
       ON CONFLICT (user_id) DO UPDATE SET
         theme = COALESCE($2, user_preferences.theme),
         language = COALESCE($3, user_preferences.language),
         notifications = COALESCE($4, user_preferences.notifications),
         sidebar = COALESCE($5, user_preferences.sidebar),
         updated_at = NOW()
       RETURNING theme, language, notifications, sidebar`,
      [
        req.user.id,
        patch.theme ?? null,
        patch.language ?? null,
        patch.notifications ?? null,
        patch.sidebar ?? null,
      ]
    );

    return res.status(200).json({ preferences: serialize(result.rows[0]) });
  } catch (err) {
    if (err.code === '23514') {
      return res.status(400).json({ message: 'One or more preference values are not supported' });
    }

    console.error('Update preferences error:', err);
    return res.status(500).json({ message: 'Failed to save preferences' });
  }
}

module.exports = { getPreferences, updatePreferences };
