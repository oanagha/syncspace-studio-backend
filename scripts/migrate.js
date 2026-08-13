require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function tableExists(name) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return rows[0].exists;
}

async function columnExists(table, column) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column]
  );
  return rows[0].exists;
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function filePrefix(filename) {
  return filename.slice(0, 3);
}

async function inferAlreadyApplied(files) {
  const milestones = [
    { prefix: '007', check: () => tableExists('workspace_members') },
    { prefix: '006', check: () => tableExists('password_reset_otps') },
    { prefix: '005', check: () => tableExists('password_reset_tokens') },
    { prefix: '004', check: () => columnExists('users', 'workspace_name') },
    { prefix: '003', check: () => columnExists('users', 'workspace_email') },
    { prefix: '002', check: () => columnExists('users', 'updated_at') },
    { prefix: '001', check: () => tableExists('users') },
  ];

  for (const milestone of milestones) {
    if (await milestone.check()) {
      const index = files.findIndex((file) => filePrefix(file) === milestone.prefix);
      return index >= 0 ? files.slice(0, index + 1) : [];
    }
  }

  return [];
}

async function bootstrapExistingDatabase(files) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  if (rows[0].n > 0) return;

  const applied = await inferAlreadyApplied(files);
  if (applied.length === 0) return;

  for (const file of applied) {
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [file]
    );
  }

  console.log(
    `Recorded ${applied.length} already-applied migration(s) for this existing database.`
  );
}

async function migrate() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  await ensureMigrationsTable();
  await bootstrapExistingDatabase(files);

  const { rows: appliedRows } = await pool.query(
    'SELECT filename FROM schema_migrations'
  );
  const applied = new Set(appliedRows.map((row) => row.filename));

  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`Running ${file}...`);
    await pool.query(sql);
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [file]
    );
    console.log(`✅ ${file} applied`);
    ran += 1;
  }

  await pool.end();

  if (ran === 0) {
    console.log('All migrations already applied.');
  } else {
    console.log('All migrations complete.');
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
