const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_DIR = path.join(DATA_DIR, 'db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LOGO_DIR = path.join(DATA_DIR, 'logo');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'simple_issue_tracker.sqlite');

for (const dir of [DB_DIR, UPLOAD_DIR, LOGO_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

function nowIso() {
  return new Date().toISOString();
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.join(ROOT_DIR, 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const recordMigration = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  const applyMigration = db.transaction((file) => {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
    recordMigration.run(file, nowIso());
  });

  for (const file of migrationFiles) {
    if (!hasMigration.get(file)) {
      applyMigration(file);
    }
  }
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function seedDefaults() {
  if (!getSetting('password_hash')) {
    setSetting('password_hash', bcrypt.hashSync('admin', 12));
  }

  if (!getSetting('session_secret')) {
    setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  }

  if (!getSetting('theme')) {
    setSetting('theme', 'dark');
  }

  if (!getSetting('display_title')) {
    setSetting('display_title', 'Simple Issue Tracker');
  }

  const count = db.prepare('SELECT COUNT(*) AS count FROM departments').get().count;
  if (count === 0) {
    const timestamp = nowIso();
    const insertDepartment = db.prepare(`
      INSERT INTO departments (name, created_at, updated_at)
      VALUES (?, ?, ?)
    `);

    for (const name of ['Audio', 'Visuals', 'Lighting', 'Streaming', 'Stage', 'Other']) {
      insertDepartment.run(name, timestamp, timestamp);
    }
  }
}

runMigrations();
seedDefaults();

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  DB_DIR,
  UPLOAD_DIR,
  LOGO_DIR,
  getSetting,
  setSetting,
  nowIso
};
