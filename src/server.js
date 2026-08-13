require('dotenv').config();

const express = require('express');
const cors = require('cors');

require('./config/db');
const { logEnvStatus, getFrontendUrl, isProduction } = require('./config/env');

const authRoutes = require('./routes/auth.routes');
const workspaceRoutes = require('./routes/workspace.routes');

const app = express();

const allowedOrigins = [getFrontendUrl()].filter(Boolean);

app.use(
  cors(
    isProduction()
      ? {
          origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
              return;
            }
            callback(new Error('Not allowed by CORS'));
          },
          credentials: true,
        }
      : undefined
  )
);
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SyncSpace API running 🚀');
});

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);

const PORT = process.env.PORT || 5000;

logEnvStatus();

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});    