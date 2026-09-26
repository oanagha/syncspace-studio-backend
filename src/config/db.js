require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const useSsl =
  (process.env.DB_HOST && process.env.DB_HOST !== 'localhost') ||
  (connectionString && !connectionString.includes('localhost'));

const poolConfig = connectionString
  ? {
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    };

const pool = new Pool({
  ...poolConfig,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

pool
  .query('SELECT 1')
  .then(() => console.log('✅ PostgreSQL connected'))
  .catch((err) => console.error('❌ DB connection error:', err.message));

module.exports = pool;
