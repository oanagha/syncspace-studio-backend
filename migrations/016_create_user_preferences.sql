CREATE TABLE IF NOT EXISTS user_preferences (
  user_id       INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme         VARCHAR(16) NOT NULL DEFAULT 'system',
  language      VARCHAR(8)  NOT NULL DEFAULT 'en',
  notifications BOOLEAN     NOT NULL DEFAULT TRUE,
  sidebar       VARCHAR(16) NOT NULL DEFAULT 'expanded',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_preferences_theme_check
    CHECK (theme IN ('light', 'dark', 'system')),
  CONSTRAINT user_preferences_language_check
    CHECK (language IN ('en', 'es', 'fr', 'de', 'pt')),
  CONSTRAINT user_preferences_sidebar_check
    CHECK (sidebar IN ('expanded', 'collapsed'))
);
