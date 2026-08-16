require('dotenv').config();

const express = require('express');

require('./config/db');
const { logEnvStatus, getFrontendUrl } = require('./config/env');

const authRoutes = require('./routes/auth.routes');
const workspaceRoutes = require('./routes/workspace.routes');
const projectRoutes = require('./routes/project.routes');
const taskRoutes = require('./routes/task.routes');
const notificationRoutes = require('./routes/notification.routes');
const teamRoutes = require('./routes/team.routes');
const settingsRoutes = require('./routes/settings.routes');
const columnRoutes = require('./routes/column.routes');
const boardRoutes = require('./routes/board.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const fileRoutes = require('./routes/file.routes');
const contactRoutes = require('./routes/contact.routes');
const { ensureUploadRoot, UPLOAD_ROOT } = require('./services/storage.service');

const app = express();

const allowedOrigins = [
  getFrontendUrl(),
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].filter(Boolean);

const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, Accept';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Always allowlist — never reflect arbitrary Origin (even in non-production).
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', '0');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});
app.use(express.json());
ensureUploadRoot();
// Only avatars are public (non-guessable paths under /uploads/avatars/{userId}/).
// Workspace files must go through GET /api/files/:id/download (JWT + membership).
app.use(
  '/uploads/avatars',
  express.static(require('path').join(UPLOAD_ROOT, 'avatars'), {
    fallthrough: false,
    index: false,
  })
);

app.get('/', (req, res) => {
  res.send('SyncSpace API running 🚀');
});

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/columns', columnRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/contact', contactRoutes);

const PORT = process.env.PORT || 5000;

logEnvStatus();

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});    