require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const {
  db,
  DB_PATH,
  DATA_DIR,
  UPLOAD_DIR,
  LOGO_DIR,
  BACKUP_DIR,
  TMP_DIR,
  getSetting,
  setSetting,
  nowIso
} = require('./db');
const { sanitizeEditorHtml, textFromHtml } = require('./sanitize');
const packageInfo = require('../package.json');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_NAME = 'Simple Issue Tracker';
const APP_VERSION = process.env.APP_VERSION || process.env.SIT_VERSION || packageInfo.version;
const APP_BRANCH = process.env.APP_BRANCH || process.env.SIT_BRANCH || 'local';
const APP_COMMIT = process.env.APP_COMMIT || process.env.SIT_COMMIT || '';
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_LOGO_SIZE = 3 * 1024 * 1024;
const MAX_BACKUP_SIZE = 1024 * 1024 * 1024;
const VALID_STATUSES = new Set(['pending', 'resolved']);
const VALID_BACKUP_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const BACKUP_FILENAME_PREFIX = 'simple-issue-tracker-backup-';
const SCHEDULED_BACKUP_CHECK_MS = 60 * 60 * 1000;
const SCHEDULED_BACKUP_RETENTION = 30;
const allowedAttachmentTypes = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['application/pdf', ['.pdf']]
]);
const allowedLogoTypes = new Map([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']]
]);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.set('etag', false);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        scriptSrcAttr: ["'none'"]
      }
    }
  })
);
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(
  cookieSession({
    name: 'sit_session',
    keys: [process.env.SESSION_SECRET || getSetting('session_secret')],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true'
  })
);

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

function normalizeFilename(filename) {
  return path.basename(filename || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extensionForUpload(file, allowedTypes) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const allowedExtensions = allowedTypes.get(file.mimetype);
  if (!allowedExtensions || !allowedExtensions.includes(extension)) {
    return null;
  }
  return extension === '.jpeg' ? '.jpg' : extension;
}

function createStorage(destination, allowedTypes) {
  return multer.diskStorage({
    destination,
    filename(_req, file, cb) {
      const extension = extensionForUpload(file, allowedTypes);
      if (!extension) {
        cb(new Error('That file type is not allowed.'));
        return;
      }
      cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    }
  });
}

function fileFilterFor(allowedTypes) {
  return (_req, file, cb) => {
    if (!extensionForUpload(file, allowedTypes)) {
      cb(new Error('Only jpg, jpeg, png, gif, webp, and pdf files are allowed.'));
      return;
    }
    cb(null, true);
  };
}

const attachmentUpload = multer({
  storage: createStorage(UPLOAD_DIR, allowedAttachmentTypes),
  fileFilter: fileFilterFor(allowedAttachmentTypes),
  limits: { fileSize: MAX_ATTACHMENT_SIZE, files: 12 }
});

const logoUpload = multer({
  storage: createStorage(LOGO_DIR, allowedLogoTypes),
  fileFilter: fileFilterFor(allowedLogoTypes),
  limits: { fileSize: MAX_LOGO_SIZE, files: 1 }
});

const backupUpload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename(_req, file, cb) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomUUID()}${extension || '.zip'}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!['.zip', '.json'].includes(extension)) {
      cb(new Error('Choose a Simple Issue Tracker zip backup file.'));
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_BACKUP_SIZE, files: 1 }
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function pathDepth(requestPath) {
  const pathname = String(requestPath || '/').split('?')[0];
  if (pathname === '/' || pathname === '') {
    return 0;
  }

  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length === 0) {
    return 0;
  }
  return pathname.endsWith('/') ? segments.length : Math.max(0, segments.length - 1);
}

function urlFor(req, target = '/') {
  const value = String(target || '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) {
    return value;
  }

  const prefix = '../'.repeat(pathDepth(req.path));
  if (value === '/' || value === '') {
    return prefix || './';
  }
  return `${prefix}${value.replace(/^\/+/, '')}`;
}

function redirectTo(req, res, target) {
  res.redirect(urlFor(req, target));
}

function consumeFlash(req) {
  const flash = req.session.flash;
  delete req.session.flash;
  return flash || null;
}

function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
    return;
  }
  redirectTo(req, res, '/login');
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function pageSizeFrom(value) {
  const parsed = Number(value);
  return [10, 25, 50].includes(parsed) ? parsed : 10;
}

function safePositiveInt(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : 'pending';
}

function normalizeBackupFrequency(value) {
  return VALID_BACKUP_FREQUENCIES.has(value) ? value : 'weekly';
}

function nextBackupTime(lastRunAt, frequency) {
  const lastRun = lastRunAt ? new Date(lastRunAt) : null;
  if (!lastRun || Number.isNaN(lastRun.getTime())) {
    return new Date(0);
  }

  const nextRun = new Date(lastRun);
  if (frequency === 'daily') {
    nextRun.setDate(nextRun.getDate() + 1);
  } else if (frequency === 'monthly') {
    nextRun.setMonth(nextRun.getMonth() + 1);
  } else {
    nextRun.setDate(nextRun.getDate() + 7);
  }
  return nextRun;
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function selectedIdsFrom(value) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(
    rawValues
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];
}

function validDepartmentIds(ids) {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id FROM departments WHERE id IN (${placeholders}) ORDER BY lower(name)`)
    .all(...ids)
    .map((row) => row.id);
}

function saveIssueDepartments(issueId, departmentIds) {
  const save = db.transaction((id, ids) => {
    db.prepare('DELETE FROM issue_departments WHERE issue_id = ?').run(id);
    const insert = db.prepare('INSERT OR IGNORE INTO issue_departments (issue_id, department_id) VALUES (?, ?)');
    for (const departmentId of ids) {
      insert.run(id, departmentId);
    }
  });

  save(issueId, departmentIds);
}

function getIssueDepartmentIds(issueId) {
  return db
    .prepare('SELECT department_id FROM issue_departments WHERE issue_id = ? ORDER BY department_id')
    .all(issueId)
    .map((row) => row.department_id);
}

function getDepartmentsWithCounts() {
  return db
    .prepare(`
      SELECT
        d.*,
        COUNT(idp.issue_id) AS issue_count
      FROM departments d
      LEFT JOIN issue_departments idp ON idp.department_id = d.id
      GROUP BY d.id
      ORDER BY lower(d.name)
    `)
    .all();
}

function getDepartments() {
  return db.prepare('SELECT * FROM departments ORDER BY lower(name)').all();
}

function getIssue(id) {
  const issue = db
    .prepare(`
      SELECT i.*
      FROM issues i
      WHERE i.id = ?
    `)
    .get(id);

  if (!issue) {
    return null;
  }

  issue.department_ids = getIssueDepartmentIds(issue.id);
  return issue;
}

function getAttachments(issueId) {
  return db
    .prepare('SELECT * FROM attachments WHERE issue_id = ? ORDER BY uploaded_at, id')
    .all(issueId);
}

function getAttachmentsForIssues(issueIds) {
  if (issueIds.length === 0) {
    return new Map();
  }

  const placeholders = issueIds.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT *
      FROM attachments
      WHERE issue_id IN (${placeholders})
      ORDER BY uploaded_at, id
    `)
    .all(...issueIds);

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.issue_id)) {
      grouped.set(row.issue_id, []);
    }
    grouped.get(row.issue_id).push(row);
  }
  return grouped;
}

function insertAttachments(issueId, files) {
  if (!files || files.length === 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO attachments (issue_id, filename, original_filename, mime_type, size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const timestamp = nowIso();
  const save = db.transaction((uploadedFiles) => {
    for (const file of uploadedFiles) {
      insert.run(
        issueId,
        normalizeFilename(file.filename),
        normalizeFilename(file.originalname),
        file.mimetype,
        file.size,
        timestamp
      );
    }
  });

  save(files);
}

function removeUploadedFiles(files) {
  if (!files || files.length === 0) {
    return;
  }

  for (const file of files) {
    if (file.path && file.path.startsWith(UPLOAD_DIR)) {
      fs.rm(file.path, { force: true }, () => {});
    }
  }
}

function deleteAttachmentFiles(issueId, ids) {
  const attachmentIds = Array.isArray(ids) ? ids : ids ? [ids] : [];
  if (attachmentIds.length === 0) {
    return;
  }

  const numericIds = attachmentIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (numericIds.length === 0) {
    return;
  }

  const placeholders = numericIds.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT *
      FROM attachments
      WHERE issue_id = ? AND id IN (${placeholders})
    `)
    .all(issueId, ...numericIds);

  const removeRows = db.transaction((attachments) => {
    const remove = db.prepare('DELETE FROM attachments WHERE id = ? AND issue_id = ?');
    for (const attachment of attachments) {
      remove.run(attachment.id, issueId);
    }
  });

  removeRows(rows);

  for (const attachment of rows) {
    const filePath = path.join(UPLOAD_DIR, attachment.filename);
    if (filePath.startsWith(UPLOAD_DIR)) {
      fs.rm(filePath, { force: true }, () => {});
    }
  }
}

function readFileBase64IfExists(directory, filename) {
  const safeFilename = normalizeFilename(filename);
  if (!safeFilename) {
    return '';
  }

  const filePath = path.join(directory, safeFilename);
  if (!filePath.startsWith(directory) || !fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath).toString('base64');
}

function createBackupData(options = {}) {
  const includeFileData = options.includeFileData !== false;
  const attachments = db.prepare('SELECT * FROM attachments ORDER BY id').all().map((attachment) => (
    includeFileData
      ? {
          ...attachment,
          data_base64: readFileBase64IfExists(UPLOAD_DIR, attachment.filename)
        }
      : { ...attachment }
  ));

  const logoFilename = getSetting('logo_filename');
  const logos = logoFilename
    ? [{
        filename: normalizeFilename(logoFilename),
        ...(includeFileData ? { data_base64: readFileBase64IfExists(LOGO_DIR, logoFilename) } : {})
      }]
    : [];

  return {
    backup_version: 2,
    exported_at: nowIso(),
    app: {
      name: APP_NAME,
      version: APP_VERSION
    },
    settings: db.prepare('SELECT key, value FROM settings ORDER BY key').all(),
    departments: db.prepare('SELECT id, name, created_at, updated_at FROM departments ORDER BY id').all(),
    issues: db.prepare(`
      SELECT id, department_id, poster_name, status, issue_html, resolution_html, created_at, updated_at
      FROM issues
      ORDER BY id
    `).all(),
    issue_departments: db.prepare(`
      SELECT issue_id, department_id
      FROM issue_departments
      ORDER BY issue_id, department_id
    `).all(),
    attachments,
    logos
  };
}

function writeBackupFilesTo(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files || []) {
    const filename = normalizeFilename(file.filename);
    if (!filename || !file.data_base64) {
      continue;
    }
    fs.writeFileSync(path.join(directory, filename), Buffer.from(file.data_base64, 'base64'));
  }
}

function clearDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

function copyDirectoryContents(sourceDirectory, destinationDirectory) {
  clearDirectory(destinationDirectory);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory)) {
    fs.cpSync(path.join(sourceDirectory, entry), path.join(destinationDirectory, entry), { recursive: true });
  }
}

function isPathInside(parentDirectory, targetPath) {
  const relative = path.relative(parentDirectory, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupArchiveFilename(label = 'manual') {
  const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${BACKUP_FILENAME_PREFIX}${timestampForFilename()}-${safeLabel}.zip`;
}

function normalizeBackupArchiveName(filename) {
  const safeFilename = normalizeFilename(filename);
  if (!safeFilename.endsWith('.zip')) {
    return '';
  }
  return safeFilename;
}

function backupArchivePath(filename) {
  const safeFilename = normalizeBackupArchiveName(filename);
  if (!safeFilename) {
    return '';
  }

  const filePath = path.join(BACKUP_DIR, safeFilename);
  return isPathInside(BACKUP_DIR, filePath) ? filePath : '';
}

function addDirectoryToZip(zip, sourceDirectory, archiveDirectory) {
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const archivePath = `${archiveDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, archivePath);
    } else if (entry.isFile()) {
      zip.addLocalFile(sourcePath, path.posix.dirname(archivePath), path.posix.basename(archivePath));
    }
  }
}

async function createFullBackupArchive(destinationPath) {
  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'backup-build-'));
  const dbSnapshotPath = path.join(tmpRoot, 'simple_issue_tracker.sqlite');
  const manifestPath = path.join(tmpRoot, 'manifest.json');
  const recordsPath = path.join(tmpRoot, 'records.json');

  try {
    await db.backup(dbSnapshotPath);
    const manifest = {
      backup_type: 'simple-issue-tracker-full',
      backup_version: 3,
      exported_at: nowIso(),
      app: {
        name: APP_NAME,
        version: APP_VERSION,
        branch: APP_BRANCH,
        commit: APP_COMMIT
      },
      includes: ['database', 'settings', 'departments', 'issues', 'attachments', 'uploads', 'logo']
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(recordsPath, JSON.stringify(createBackupData({ includeFileData: false }), null, 2));

    const zip = new AdmZip();
    zip.addLocalFile(manifestPath, '', 'manifest.json');
    zip.addLocalFile(recordsPath, 'metadata', 'records.json');
    zip.addLocalFile(dbSnapshotPath, 'database', 'simple_issue_tracker.sqlite');
    addDirectoryToZip(zip, UPLOAD_DIR, 'uploads');
    addDirectoryToZip(zip, LOGO_DIR, 'logo');
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    zip.writeZip(destinationPath);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function listBackupArchives() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((filename) => filename.startsWith(BACKUP_FILENAME_PREFIX) && filename.endsWith('.zip'))
    .map((filename) => {
      const filePath = path.join(BACKUP_DIR, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        size: stats.size,
        formattedSize: formatBytes(stats.size),
        createdAt: stats.mtime.toISOString(),
        createdAtLabel: formatDate(stats.mtime)
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneScheduledBackups() {
  const scheduledBackups = listBackupArchives()
    .filter((backup) => backup.filename.endsWith('-scheduled.zip'));

  for (const backup of scheduledBackups.slice(SCHEDULED_BACKUP_RETENTION)) {
    const filePath = backupArchivePath(backup.filename);
    if (filePath) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

async function createStoredBackup(label = 'manual') {
  const filename = backupArchiveFilename(label);
  const filePath = path.join(BACKUP_DIR, filename);
  await createFullBackupArchive(filePath);
  return {
    filename,
    filePath,
    size: fs.statSync(filePath).size
  };
}

function safeZipEntryName(entryName) {
  const rawName = String(entryName || '').replace(/\\/g, '/');
  const segments = rawName.split('/');
  const normalized = path.posix.normalize(rawName);
  if (
    !normalized ||
    normalized === '.' ||
    rawName.startsWith('/') ||
    /^[a-zA-Z]:/.test(rawName) ||
    segments.includes('..') ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return '';
  }
  return normalized;
}

function writeZipEntry(entry, destinationDirectory, relativeName) {
  const safeName = safeZipEntryName(relativeName);
  if (!safeName) {
    return;
  }

  const filePath = path.join(destinationDirectory, ...safeName.split('/'));
  if (!isPathInside(destinationDirectory, filePath)) {
    throw new Error('The backup archive contains an unsafe file path.');
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entry.getData());
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(database, tableName) {
  if (!tableExists(database, tableName)) {
    return new Set();
  }
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function readBackupDatabaseData(databasePath) {
  const backupDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(backupDb, 'departments') || !tableExists(backupDb, 'issues')) {
      throw new Error('The backup database is missing required Simple Issue Tracker tables.');
    }

    const issueColumns = tableColumns(backupDb, 'issues');
    const posterSql = issueColumns.has('poster_name') ? 'poster_name' : "'' AS poster_name";
    const statusSql = issueColumns.has('status') ? 'status' : "'pending' AS status";
    const attachments = tableExists(backupDb, 'attachments')
      ? backupDb.prepare('SELECT id, issue_id, filename, original_filename, mime_type, size, uploaded_at FROM attachments ORDER BY id').all()
      : [];
    const issueDepartments = tableExists(backupDb, 'issue_departments')
      ? backupDb.prepare('SELECT issue_id, department_id FROM issue_departments ORDER BY issue_id, department_id').all()
      : [];

    return {
      backup_version: 3,
      exported_at: nowIso(),
      settings: tableExists(backupDb, 'settings')
        ? backupDb.prepare('SELECT key, value FROM settings ORDER BY key').all()
        : [],
      departments: backupDb.prepare('SELECT id, name, created_at, updated_at FROM departments ORDER BY id').all(),
      issues: backupDb.prepare(`
        SELECT id, department_id, ${posterSql}, ${statusSql}, issue_html, resolution_html, created_at, updated_at
        FROM issues
        ORDER BY id
      `).all(),
      issue_departments: issueDepartments,
      attachments,
      logos: []
    };
  } finally {
    backupDb.close();
  }
}

function extractBackupArchive(archivePath, destinationRoot) {
  const zip = new AdmZip(archivePath);
  const tmpUploadDir = path.join(destinationRoot, 'uploads');
  const tmpLogoDir = path.join(destinationRoot, 'logo');
  const tmpDatabasePath = path.join(destinationRoot, 'simple_issue_tracker.sqlite');
  let manifest = null;

  fs.mkdirSync(tmpUploadDir, { recursive: true });
  fs.mkdirSync(tmpLogoDir, { recursive: true });

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const entryName = safeZipEntryName(entry.entryName);
    if (!entryName) {
      throw new Error('The backup archive contains an unsafe file path.');
    }

    if (entryName === 'manifest.json') {
      manifest = JSON.parse(entry.getData().toString('utf8'));
    } else if (entryName === 'database/simple_issue_tracker.sqlite') {
      fs.writeFileSync(tmpDatabasePath, entry.getData());
    } else if (entryName.startsWith('uploads/')) {
      writeZipEntry(entry, tmpUploadDir, entryName.replace(/^uploads\//, ''));
    } else if (entryName.startsWith('logo/')) {
      writeZipEntry(entry, tmpLogoDir, entryName.replace(/^logo\//, ''));
    }
  }

  if (!fs.existsSync(tmpDatabasePath)) {
    throw new Error('The backup archive does not include the SQLite database snapshot.');
  }

  if (manifest && manifest.backup_type && manifest.backup_type !== 'simple-issue-tracker-full') {
    throw new Error('That zip file is not a Simple Issue Tracker full backup.');
  }

  return {
    databasePath: tmpDatabasePath,
    uploadDir: tmpUploadDir,
    logoDir: tmpLogoDir,
    manifest
  };
}

function restoreBackupArchive(archivePath) {
  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'restore-'));
  try {
    const extracted = extractBackupArchive(archivePath, tmpRoot);
    const backup = readBackupDatabaseData(extracted.databasePath);
    restoreBackupData(backup, {
      uploadDir: extracted.uploadDir,
      logoDir: extracted.logoDir
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

let scheduledBackupRunning = false;

function scheduledBackupIsDue() {
  const frequency = normalizeBackupFrequency(getSetting('backup_frequency', 'weekly'));
  const lastRunAt = getSetting('backup_last_run_at');
  return new Date() >= nextBackupTime(lastRunAt, frequency);
}

async function runScheduledBackupIfDue() {
  if (scheduledBackupRunning || !scheduledBackupIsDue()) {
    return;
  }

  scheduledBackupRunning = true;
  try {
    const backup = await createStoredBackup('scheduled');
    setSetting('backup_last_run_at', nowIso());
    pruneScheduledBackups();
    console.info(`Scheduled backup created: ${backup.filename}`);
  } catch (error) {
    console.error('Scheduled backup failed:', error);
  } finally {
    scheduledBackupRunning = false;
  }
}

function startScheduledBackups() {
  setTimeout(() => {
    runScheduledBackupIfDue();
  }, 5000);
  setInterval(() => {
    runScheduledBackupIfDue();
  }, SCHEDULED_BACKUP_CHECK_MS);
}

function restoreBackupData(backup, fileSource = {}) {
  if (!backup || !Array.isArray(backup.departments) || !Array.isArray(backup.issues)) {
    throw new Error('That backup file does not look like a Simple Issue Tracker backup.');
  }

  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'import-'));
  const tmpUploadDir = fileSource.uploadDir || path.join(tmpRoot, 'uploads');
  const tmpLogoDir = fileSource.logoDir || path.join(tmpRoot, 'logo');

  try {
    if (!fileSource.uploadDir) {
      writeBackupFilesTo(tmpUploadDir, backup.attachments || []);
    }
    if (!fileSource.logoDir) {
      writeBackupFilesTo(tmpLogoDir, backup.logos || []);
    }
    fs.mkdirSync(tmpUploadDir, { recursive: true });
    fs.mkdirSync(tmpLogoDir, { recursive: true });

    const restore = db.transaction(() => {
      db.prepare('DELETE FROM attachments').run();
      db.prepare('DELETE FROM issue_departments').run();
      db.prepare('DELETE FROM issues').run();
      db.prepare('DELETE FROM departments').run();
      db.prepare('DELETE FROM settings').run();

      const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const setting of backup.settings || []) {
        if (setting && setting.key) {
          insertSetting.run(String(setting.key), String(setting.value || ''));
        }
      }

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
        setSetting('display_title', APP_NAME);
      }
      if (!getSetting('backup_frequency')) {
        setSetting('backup_frequency', 'weekly');
      }

      const insertDepartment = db.prepare(`
        INSERT INTO departments (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const restoredDepartmentIds = [];
      for (const department of backup.departments) {
        const departmentId = Number(department.id);
        restoredDepartmentIds.push(departmentId);
        insertDepartment.run(
          departmentId,
          String(department.name || '').slice(0, 80),
          department.created_at || nowIso(),
          department.updated_at || department.created_at || nowIso()
        );
      }

      if (restoredDepartmentIds.length === 0) {
        throw new Error('The backup must include at least one department.');
      }

      const insertIssue = db.prepare(`
        INSERT INTO issues (id, department_id, poster_name, status, issue_html, resolution_html, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of backup.issues) {
        const issueDepartmentId = restoredDepartmentIds.includes(Number(issue.department_id))
          ? Number(issue.department_id)
          : restoredDepartmentIds[0];
        insertIssue.run(
          Number(issue.id),
          issueDepartmentId,
          String(issue.poster_name || '').slice(0, 120),
          normalizeStatus(issue.status),
          String(issue.issue_html || ''),
          String(issue.resolution_html || ''),
          issue.created_at || nowIso(),
          issue.updated_at || issue.created_at || nowIso()
        );
      }

      const issueDepartments = Array.isArray(backup.issue_departments) && backup.issue_departments.length > 0
        ? backup.issue_departments
        : backup.issues.map((issue) => ({ issue_id: issue.id, department_id: issue.department_id }));
      const insertIssueDepartment = db.prepare(`
        INSERT OR IGNORE INTO issue_departments (issue_id, department_id)
        VALUES (?, ?)
      `);
      for (const issueDepartment of issueDepartments) {
        const departmentId = restoredDepartmentIds.includes(Number(issueDepartment.department_id))
          ? Number(issueDepartment.department_id)
          : restoredDepartmentIds[0];
        insertIssueDepartment.run(Number(issueDepartment.issue_id), departmentId);
      }

      const insertAttachment = db.prepare(`
        INSERT INTO attachments (id, issue_id, filename, original_filename, mime_type, size, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const attachment of backup.attachments || []) {
        const filename = normalizeFilename(attachment.filename);
        if (!filename) {
          continue;
        }
        insertAttachment.run(
          Number(attachment.id),
          Number(attachment.issue_id),
          filename,
          normalizeFilename(attachment.original_filename || filename),
          String(attachment.mime_type || 'application/octet-stream'),
          Number(attachment.size || 0),
          attachment.uploaded_at || nowIso()
        );
      }
    });

    restore();
    copyDirectoryContents(tmpUploadDir, UPLOAD_DIR);
    copyDirectoryContents(tmpLogoDir, LOGO_DIR);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function uploadMiddleware(middleware, failureRedirect = 'back') {
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (!error) {
        next();
        return;
      }

      const message =
        error instanceof multer.MulterError
          ? 'The uploaded file is too large or too many files were selected.'
          : error.message || 'The upload could not be processed.';
      setFlash(req, 'error', message);
      res.redirect(failureRedirect === 'back' ? req.get('referer') || urlFor(req, '/') : urlFor(req, failureRedirect));
    });
  };
}

function renderIssueForm(res, options) {
  res.render('issue-form', {
    appName: APP_NAME,
    formatDate,
    ...options
  });
}

app.use((req, res, next) => {
  res.locals.appName = APP_NAME;
  res.locals.displayTitle = getSetting('display_title', APP_NAME);
  res.locals.assetVersion = '20260701-1';
  res.locals.appVersion = APP_VERSION;
  res.locals.appBranch = APP_BRANCH;
  res.locals.appCommit = APP_COMMIT ? APP_COMMIT.slice(0, 7) : '';
  res.locals.urlFor = (target) => urlFor(req, target);
  res.locals.isAuthenticated = Boolean(req.session.authenticated);
  res.locals.currentPath = req.path;
  res.locals.flash = consumeFlash(req);
  res.locals.formatDate = formatDate;
  res.locals.theme = req.session.theme || getSetting('theme', 'dark');
  const logoFilename = getSetting('logo_filename');
  res.locals.logoUrl = logoFilename ? urlFor(req, `/logo/${encodeURIComponent(logoFilename)}`) : '';
  next();
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, database: path.basename(DB_PATH) });
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    redirectTo(req, res, '/');
    return;
  }
  res.render('login', { appName: APP_NAME });
});

app.post('/login', (req, res) => {
  const password = String(req.body.password || '');
  const passwordHash = getSetting('password_hash');

  if (bcrypt.compareSync(password, passwordHash)) {
    console.info(`Shared login succeeded from ${req.ip}`);
    req.session.authenticated = true;
    req.session.theme = getSetting('theme', 'dark');
    setFlash(req, 'success', 'You are logged in.');
    redirectTo(req, res, '/');
    return;
  }

  console.info(`Shared login failed from ${req.ip}`);
  setFlash(req, 'error', 'The password was not correct.');
  redirectTo(req, res, '/login');
});

app.get('/logout', (req, res) => {
  req.session = null;
  redirectTo(req, res, '/login');
});

app.get('/logo/:filename', (req, res) => {
  const configuredLogo = getSetting('logo_filename');
  const filename = normalizeFilename(req.params.filename);
  if (!configuredLogo || configuredLogo !== filename) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(path.join(LOGO_DIR, filename));
});

app.use(requireAuth);

app.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const department = String(req.query.department || '');
  const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';
  const pageSize = pageSizeFrom(req.query.pageSize);
  const page = safePositiveInt(req.query.page, 1);

  const where = [];
  const params = [];

  if (q) {
    where.push(`(
      i.issue_html LIKE ?
      OR i.resolution_html LIKE ?
      OR i.poster_name LIKE ?
      OR EXISTS (
        SELECT 1
        FROM issue_departments sidp
        JOIN departments sd ON sd.id = sidp.department_id
        WHERE sidp.issue_id = i.id AND sd.name LIKE ?
      )
    )`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  if (department && department !== 'all') {
    const departmentId = Number(department);
    if (Number.isInteger(departmentId) && departmentId > 0) {
      where.push('EXISTS (SELECT 1 FROM issue_departments fidp WHERE fidp.issue_id = i.id AND fidp.department_id = ?)');
      params.push(departmentId);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM issues i
      ${whereSql}
    `)
    .get(...params).total;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const orderSql = sort === 'oldest' ? 'i.created_at ASC, i.id ASC' : 'i.created_at DESC, i.id DESC';

  const issues = db
    .prepare(`
      SELECT
        i.*,
        GROUP_CONCAT(d.name, ', ') AS department_names
      FROM issues i
      LEFT JOIN issue_departments idp ON idp.issue_id = i.id
      LEFT JOIN departments d ON d.id = idp.department_id
      ${whereSql}
      GROUP BY i.id
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset);
  const attachmentsByIssue = getAttachmentsForIssues(issues.map((issue) => issue.id));

  const pageUrl = (targetPage) => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (department) query.set('department', department);
    if (sort !== 'newest') query.set('sort', sort);
    if (pageSize !== 10) query.set('pageSize', String(pageSize));
    if (targetPage > 1) query.set('page', String(targetPage));
    const queryString = query.toString();
    return urlFor(req, queryString ? `/?${queryString}` : '/');
  };

  res.render('dashboard', {
    appName: APP_NAME,
    departments: getDepartments(),
    issues,
    attachmentsByIssue,
    filters: {
      q,
      department,
      sort,
      pageSize
    },
    pagination: {
      count,
      currentPage,
      totalPages,
      pageUrl
    }
  });
});

app.get('/issues/new', (_req, res) => {
  renderIssueForm(res, {
    title: 'Add Issue',
    mode: 'create',
    action: '/issues',
    issue: {
      poster_name: '',
      status: 'pending',
      department_ids: [],
      issue_html: '',
      resolution_html: ''
    },
    attachments: [],
    departments: getDepartments()
  });
});

app.post('/issues', uploadMiddleware(attachmentUpload.array('attachments', 12), '/issues/new'), (req, res) => {
  const departmentIds = validDepartmentIds(selectedIdsFrom(req.body.department_ids));
  const posterName = String(req.body.poster_name || '').trim().slice(0, 120);
  const status = normalizeStatus(req.body.status);
  const issueHtml = sanitizeEditorHtml(req.body.issue_html);
  const resolutionHtml = sanitizeEditorHtml(req.body.resolution_html);

  if (!posterName) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add your name before saving.');
    redirectTo(req, res, '/issues/new');
    return;
  }

  if (departmentIds.length === 0) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Choose at least one department before saving.');
    redirectTo(req, res, '/issues/new');
    return;
  }

  if (!textFromHtml(issueHtml)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add the issue details before saving.');
    redirectTo(req, res, '/issues/new');
    return;
  }

  const timestamp = nowIso();
  const createIssue = db.transaction(() => {
    const result = db
      .prepare(`
        INSERT INTO issues (department_id, poster_name, status, issue_html, resolution_html, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(departmentIds[0], posterName, status, issueHtml, resolutionHtml, timestamp, timestamp);

    saveIssueDepartments(result.lastInsertRowid, departmentIds);
    return result.lastInsertRowid;
  });

  const issueId = createIssue();
  insertAttachments(issueId, req.files);
  setFlash(req, 'success', 'Issue added.');
  redirectTo(req, res, '/');
});

app.get('/issues/:id/edit', (req, res) => {
  const issue = getIssue(Number(req.params.id));
  if (!issue) {
    setFlash(req, 'error', 'That issue could not be found.');
    redirectTo(req, res, '/');
    return;
  }

  renderIssueForm(res, {
    title: 'Edit Issue',
    mode: 'edit',
    action: `/issues/${issue.id}`,
    issue,
    attachments: getAttachments(issue.id),
    departments: getDepartments()
  });
});

app.post('/issues/:id', uploadMiddleware(attachmentUpload.array('attachments', 12)), (req, res) => {
  const issueId = Number(req.params.id);
  const existingIssue = getIssue(issueId);

  if (!existingIssue) {
    setFlash(req, 'error', 'That issue could not be found.');
    redirectTo(req, res, '/');
    return;
  }

  const departmentIds = validDepartmentIds(selectedIdsFrom(req.body.department_ids));
  const posterName = String(req.body.poster_name || '').trim().slice(0, 120);
  const status = normalizeStatus(req.body.status);
  const issueHtml = sanitizeEditorHtml(req.body.issue_html);
  const resolutionHtml = sanitizeEditorHtml(req.body.resolution_html);

  if (!posterName) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add the submitter name before saving.');
    redirectTo(req, res, `/issues/${issueId}/edit`);
    return;
  }

  if (departmentIds.length === 0) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Choose at least one department before saving.');
    redirectTo(req, res, `/issues/${issueId}/edit`);
    return;
  }

  if (!textFromHtml(issueHtml)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add the issue details before saving.');
    redirectTo(req, res, `/issues/${issueId}/edit`);
    return;
  }

  deleteAttachmentFiles(issueId, req.body.delete_attachment_ids);
  const updateIssue = db.transaction(() => {
    db.prepare(`
      UPDATE issues
      SET department_id = ?, poster_name = ?, status = ?, issue_html = ?, resolution_html = ?, updated_at = ?
      WHERE id = ?
    `).run(departmentIds[0], posterName, status, issueHtml, resolutionHtml, nowIso(), issueId);
    saveIssueDepartments(issueId, departmentIds);
  });
  updateIssue();
  insertAttachments(issueId, req.files);

  setFlash(req, 'success', 'Issue updated.');
  redirectTo(req, res, '/');
});

app.get('/uploads/:filename', (req, res) => {
  const filename = normalizeFilename(req.params.filename);
  const attachment = db.prepare('SELECT * FROM attachments WHERE filename = ?').get(filename);
  if (!attachment) {
    res.status(404).send('Not found');
    return;
  }

  res.type(attachment.mime_type);
  res.sendFile(path.join(UPLOAD_DIR, filename));
});

app.get('/settings', (_req, res) => {
  const backupFrequency = normalizeBackupFrequency(getSetting('backup_frequency', 'weekly'));
  const backupLastRunAt = getSetting('backup_last_run_at');
  res.render('settings', {
    appName: APP_NAME,
    displayTitle: getSetting('display_title', APP_NAME),
    departments: getDepartmentsWithCounts(),
    currentTheme: getSetting('theme', 'dark'),
    backupFrequency,
    backupLastRunAt,
    backupLastRunLabel: backupLastRunAt ? formatDate(backupLastRunAt) : '',
    nextBackupLabel: backupLastRunAt ? formatDate(nextBackupTime(backupLastRunAt, backupFrequency)) : 'Next backup check',
    backupFiles: listBackupArchives()
  });
});

app.post('/settings/title', (req, res) => {
  const displayTitle = String(req.body.display_title || '').trim().slice(0, 80);
  if (!displayTitle) {
    setFlash(req, 'error', 'Title is required.');
    redirectTo(req, res, '/settings');
    return;
  }

  setSetting('display_title', displayTitle);
  setFlash(req, 'success', 'Title updated.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/logo', uploadMiddleware(logoUpload.single('logo'), '/settings'), (req, res) => {
  if (!req.file) {
    setFlash(req, 'error', 'Choose a logo image to upload.');
    redirectTo(req, res, '/settings');
    return;
  }

  const oldLogo = getSetting('logo_filename');
  setSetting('logo_filename', normalizeFilename(req.file.filename));

  if (oldLogo && oldLogo !== req.file.filename) {
    fs.rm(path.join(LOGO_DIR, oldLogo), { force: true }, () => {});
  }

  setFlash(req, 'success', 'Logo updated.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/theme', (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  setSetting('theme', theme);
  req.session.theme = theme;
  setFlash(req, 'success', 'Theme preference saved.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/backups/schedule', (req, res) => {
  const backupFrequency = normalizeBackupFrequency(req.body.backup_frequency);
  setSetting('backup_frequency', backupFrequency);
  setFlash(req, 'success', 'Backup schedule saved.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/backups/run', async (req, res) => {
  try {
    const backup = await createStoredBackup('manual');
    setFlash(req, 'success', `Backup created: ${backup.filename}`);
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', error.message || 'The backup could not be created.');
  }
  redirectTo(req, res, '/settings');
});

app.get('/settings/backups/:filename', (req, res) => {
  const filePath = backupArchivePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).send('Not found');
    return;
  }
  res.download(filePath, path.basename(filePath));
});

app.get('/settings/export', async (req, res) => {
  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'download-'));
  const filename = backupArchiveFilename('download');
  const filePath = path.join(tmpRoot, filename);

  try {
    await createFullBackupArchive(filePath);
    res.download(filePath, filename, (error) => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      if (error && !res.headersSent) {
        setFlash(req, 'error', 'The backup could not be downloaded.');
        redirectTo(req, res, '/settings');
      }
    });
  } catch (error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.error(error);
    setFlash(req, 'error', error.message || 'The backup could not be created.');
    redirectTo(req, res, '/settings');
  }
});

app.post('/settings/import', uploadMiddleware(backupUpload.single('backup'), '/settings'), (req, res) => {
  if (!req.file) {
    setFlash(req, 'error', 'Choose a backup file to import.');
    redirectTo(req, res, '/settings');
    return;
  }

  try {
    const extension = path.extname(req.file.originalname || req.file.filename || '').toLowerCase();
    if (extension === '.json') {
      const backup = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
      restoreBackupData(backup);
    } else {
      restoreBackupArchive(req.file.path);
    }
    setFlash(req, 'success', 'Backup restored.');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', error.message || 'The backup could not be restored.');
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  redirectTo(req, res, '/settings');
});

app.post('/settings/departments', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    setFlash(req, 'error', 'Department name is required.');
    redirectTo(req, res, '/settings');
    return;
  }

  try {
    const timestamp = nowIso();
    db.prepare('INSERT INTO departments (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, timestamp, timestamp);
    setFlash(req, 'success', 'Department added.');
  } catch (_error) {
    setFlash(req, 'error', 'That department already exists.');
  }
  redirectTo(req, res, '/settings');
});

app.post('/settings/departments/:id', (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    setFlash(req, 'error', 'Department name is required.');
    redirectTo(req, res, '/settings');
    return;
  }

  try {
    db.prepare('UPDATE departments SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), id);
    setFlash(req, 'success', 'Department renamed.');
  } catch (_error) {
    setFlash(req, 'error', 'That department name is already in use.');
  }
  redirectTo(req, res, '/settings');
});

app.post('/settings/departments/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS count FROM issue_departments WHERE department_id = ?').get(id).count;
  if (used > 0) {
    setFlash(req, 'error', 'That department is used by existing issues, so it cannot be deleted.');
    redirectTo(req, res, '/settings');
    return;
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  setFlash(req, 'success', 'Department deleted.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/password', (req, res) => {
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (password.length < 4) {
    setFlash(req, 'error', 'Use at least 4 characters for the shared password.');
    redirectTo(req, res, '/settings');
    return;
  }

  if (password !== confirmPassword) {
    setFlash(req, 'error', 'The new passwords did not match.');
    redirectTo(req, res, '/settings');
    return;
  }

  setSetting('password_hash', bcrypt.hashSync(password, 12));
  setFlash(req, 'success', 'Password updated.');
  redirectTo(req, res, '/settings');
});

app.use((_req, res) => {
  res.status(404).render('not-found', { appName: APP_NAME });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).render('error', { appName: APP_NAME });
});

app.listen(PORT, () => {
  console.log(`${APP_NAME} listening on port ${PORT}`);
  startScheduledBackups();
});
