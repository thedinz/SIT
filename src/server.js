require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const yazl = require('yazl');
const yauzl = require('yauzl');

const {
  db,
  UPLOAD_DIR,
  LOGO_DIR,
  BACKUP_DIR,
  TMP_DIR,
  DEFAULT_PASSWORD,
  getSetting,
  setSetting,
  nowIso,
  issueSearchText,
  refreshDefaultPasswordFlag
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
const MAX_ATTACHMENT_FILES = 12;
const MAX_FIELD_SIZE = 2 * 1024 * 1024;
const MAX_LOGO_SIZE = 3 * 1024 * 1024;
const MAX_BACKUP_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_RESTORE_UNCOMPRESSED_SIZE = 20 * 1024 * 1024 * 1024;
const MAX_RESTORE_ENTRIES = 200000;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const VALID_STATUSES = new Set(['pending', 'resolved']);
const VALID_BACKUP_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const BACKUP_FILENAME_PREFIX = 'simple-issue-tracker-backup-';
const SCHEDULED_BACKUP_CHECK_MS = 60 * 60 * 1000;
const SCHEDULED_BACKUP_RETENTION = 30;
const PRE_RESTORE_BACKUP_RETENTION = 5;
const ASSET_VERSION = '20260928-1';
const THEME_COOKIE = 'sit_theme';
const DEPARTMENT_SEPARATOR = '\u001f';
// Settings that belong to this server rather than to the data, so they are never exported or restored.
const INSTANCE_SETTING_KEYS = new Set(['session_secret', 'session_version']);
// Multipart routes verify the CSRF token themselves once multer has parsed the body.
const MULTIPART_ROUTES = [/^\/issues$/, /^\/issues\/\d+$/, /^\/settings\/logo$/, /^\/settings\/import$/];
// While the default password is in use, only these routes are reachable.
const DEFAULT_PASSWORD_ALLOWED_PATHS = new Set(['/settings', '/settings/password', '/settings/import', '/logout']);
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

function parseTrustProxy(value) {
  if (!value) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.set('etag', false);

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  app.set('trust proxy', trustProxy);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch (_error) {
        return '';
      }
    }
  }
  return '';
}

function isAllowedLogoFilename(filename) {
  const extension = path.extname(filename || '').toLowerCase();
  return [...allowedLogoTypes.values()].some((extensions) => extensions.includes(extension));
}

function configuredLogoFilename() {
  const filename = normalizeFilename(getSetting('logo_filename'));
  return filename && isAllowedLogoFilename(filename) ? filename : '';
}

function mimeTypeForAttachmentFilename(filename) {
  const extension = path.extname(filename || '').toLowerCase();
  for (const [mimeType, extensions] of allowedAttachmentTypes) {
    if (extensions.includes(extension)) {
      return mimeType;
    }
  }
  return '';
}

function defaultSiteIconSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#101827"/>
      <path d="M16 20h32v6H16zM16 30h24v6H16zM16 40h30v6H16z" fill="#7dd3fc"/>
      <circle cx="47" cy="23" r="5" fill="#a7f3d0"/>
    </svg>
  `.trim();
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
  limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENT_FILES, fieldSize: MAX_FIELD_SIZE }
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

function isAuthenticated(req) {
  return Boolean(req.session.authenticated) && req.session.sessionVersion === getSetting('session_version');
}

function signIn(req) {
  req.session.authenticated = true;
  req.session.sessionVersion = getSetting('session_version');
  req.session.csrfToken = crypto.randomBytes(24).toString('hex');
}

function signOutOtherSessions(req) {
  const nextVersion = String(Number(getSetting('session_version', '1')) + 1);
  setSetting('session_version', nextVersion);
  if (req.session.authenticated) {
    req.session.sessionVersion = nextVersion;
  }
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  if (req.session.authenticated) {
    delete req.session.authenticated;
    delete req.session.sessionVersion;
  }
  redirectTo(req, res, '/login');
}

function csrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function hasValidCsrfToken(req) {
  const expected = String(req.session.csrfToken || '');
  const provided = String((req.body && req.body._csrf) || '');
  if (!expected || provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function rejectCsrf(req, res) {
  removeUploadedFiles(req.files);
  if (req.file && req.file.path) {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  setFlash(req, 'error', 'That form was out of date. Please try again.');
  res.redirect(303, req.get('referer') || urlFor(req, '/'));
}

function requireCsrf(req, res, next) {
  if (hasValidCsrfToken(req)) {
    next();
    return;
  }
  rejectCsrf(req, res);
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

// Server-formatted fallback that the browser rewrites into the viewer's own timezone.
function localTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `<time datetime="${date.toISOString()}" data-local-time>${escapeHtml(formatDate(date))}</time>`;
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

function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
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

function removeAttachmentFile(filename) {
  const safeFilename = normalizeFilename(filename);
  if (!safeFilename) {
    return;
  }
  const filePath = path.join(UPLOAD_DIR, safeFilename);
  if (isPathInside(UPLOAD_DIR, filePath)) {
    fs.rm(filePath, { force: true }, () => {});
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
    removeAttachmentFile(attachment.filename);
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

function exportableSettings() {
  return db
    .prepare('SELECT key, value FROM settings ORDER BY key')
    .all()
    .filter((setting) => !INSTANCE_SETTING_KEYS.has(setting.key));
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
    settings: exportableSettings(),
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

// Copies the source entries over the destination and returns the names the destination should keep.
function stageDirectoryContents(sourceDirectory, destinationDirectory) {
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const entries = fs.readdirSync(sourceDirectory);
  for (const entry of entries) {
    fs.cpSync(path.join(sourceDirectory, entry), path.join(destinationDirectory, entry), { recursive: true, force: true });
  }
  return new Set(entries);
}

function removeDirectoryEntries(directory, shouldRemove) {
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory)) {
    if (shouldRemove(entry)) {
      fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
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
  if (!safeFilename.startsWith(BACKUP_FILENAME_PREFIX) || !safeFilename.endsWith('.zip')) {
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

function backupKind(filename) {
  if (filename.endsWith('-scheduled.zip')) {
    return 'Scheduled';
  }
  if (filename.endsWith('-pre-restore.zip')) {
    return 'Before restore';
  }
  return 'Manual';
}

function addDirectoryToZip(zip, sourceDirectory, archiveDirectory) {
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const archivePath = `${archiveDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, archivePath);
    } else if (entry.isFile()) {
      // Images and PDFs are already compressed, so store them as-is.
      zip.addFile(sourcePath, archivePath, { compress: false });
    }
  }
}

// The snapshot is a byte copy of the live database, so strip this server's secrets from it too.
function scrubInstanceSettings(databasePath) {
  const snapshot = new Database(databasePath);
  try {
    snapshot.pragma('journal_mode = DELETE');
    const keys = [...INSTANCE_SETTING_KEYS];
    snapshot.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
    snapshot.exec('VACUUM');
  } finally {
    snapshot.close();
  }
}

async function createFullBackupArchive(destinationPath) {
  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'backup-build-'));
  const dbSnapshotPath = path.join(tmpRoot, 'simple_issue_tracker.sqlite');
  const manifestPath = path.join(tmpRoot, 'manifest.json');
  const recordsPath = path.join(tmpRoot, 'records.json');
  const partialPath = `${destinationPath}.partial`;

  try {
    await db.backup(dbSnapshotPath);
    scrubInstanceSettings(dbSnapshotPath);
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

    const zip = new yazl.ZipFile();
    zip.addFile(manifestPath, 'manifest.json');
    zip.addFile(recordsPath, 'metadata/records.json');
    zip.addFile(dbSnapshotPath, 'database/simple_issue_tracker.sqlite');
    addDirectoryToZip(zip, UPLOAD_DIR, 'uploads');
    addDirectoryToZip(zip, LOGO_DIR, 'logo');
    zip.end();

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    await pipeline(zip.outputStream, fs.createWriteStream(partialPath));
    fs.renameSync(partialPath, destinationPath);
  } finally {
    fs.rmSync(partialPath, { force: true });
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
        kind: backupKind(filename),
        size: stats.size,
        formattedSize: formatBytes(stats.size),
        createdAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups(suffix, retention) {
  const matchingBackups = listBackupArchives()
    .filter((backup) => backup.filename.endsWith(suffix));

  for (const backup of matchingBackups.slice(retention)) {
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

function safeZipTargetPath(destinationDirectory, relativeName) {
  const safeName = safeZipEntryName(relativeName);
  if (!safeName) {
    return '';
  }

  const filePath = path.join(destinationDirectory, ...safeName.split('/'));
  if (!isPathInside(destinationDirectory, filePath)) {
    throw new Error('The backup archive contains an unsafe file path.');
  }
  return filePath;
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

function openZipFile(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        reject(new Error('That file is not a readable zip archive.'));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openZipEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

async function readZipEntryText(zipFile, entry, maxSize) {
  if (entry.uncompressedSize > maxSize) {
    throw new Error('The backup manifest is too large.');
  }
  const chunks = [];
  for await (const chunk of await openZipEntryStream(zipFile, entry)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Streams entries to disk one at a time so large backups never have to fit in memory.
async function extractBackupArchive(archivePath, destinationRoot) {
  const tmpUploadDir = path.join(destinationRoot, 'uploads');
  const tmpLogoDir = path.join(destinationRoot, 'logo');
  const tmpDatabasePath = path.join(destinationRoot, 'simple_issue_tracker.sqlite');
  let manifest = null;
  let totalSize = 0;

  fs.mkdirSync(tmpUploadDir, { recursive: true });
  fs.mkdirSync(tmpLogoDir, { recursive: true });

  const zipFile = await openZipFile(archivePath);
  try {
    if (zipFile.entryCount > MAX_RESTORE_ENTRIES) {
      throw new Error('The backup archive contains too many files.');
    }

    const handleEntry = async (entry) => {
      if (entry.fileName.endsWith('/')) {
        return;
      }

      const entryName = safeZipEntryName(entry.fileName);
      if (!entryName) {
        throw new Error('The backup archive contains an unsafe file path.');
      }

      totalSize += entry.uncompressedSize;
      if (totalSize > MAX_RESTORE_UNCOMPRESSED_SIZE) {
        throw new Error('The backup archive is too large to restore.');
      }

      if (entryName === 'manifest.json') {
        try {
          manifest = JSON.parse(await readZipEntryText(zipFile, entry, MAX_MANIFEST_SIZE));
        } catch (_error) {
          throw new Error('The backup manifest could not be read.');
        }
        return;
      }

      let targetPath = '';
      if (entryName === 'database/simple_issue_tracker.sqlite') {
        targetPath = tmpDatabasePath;
      } else if (entryName.startsWith('uploads/')) {
        targetPath = safeZipTargetPath(tmpUploadDir, entryName.replace(/^uploads\//, ''));
      } else if (entryName.startsWith('logo/')) {
        targetPath = safeZipTargetPath(tmpLogoDir, entryName.replace(/^logo\//, ''));
      }

      if (!targetPath) {
        return;
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await pipeline(await openZipEntryStream(zipFile, entry), fs.createWriteStream(targetPath));
    };

    await new Promise((resolve, reject) => {
      zipFile.on('entry', (entry) => {
        handleEntry(entry).then(() => zipFile.readEntry(), reject);
      });
      zipFile.on('end', resolve);
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
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

async function restoreBackupArchive(archivePath) {
  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'restore-'));
  try {
    const extracted = await extractBackupArchive(archivePath, tmpRoot);
    const backup = readBackupDatabaseData(extracted.databasePath);
    return restoreBackupData(backup, {
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
    pruneBackups('-scheduled.zip', SCHEDULED_BACKUP_RETENTION);
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

function restoredAttachmentMimeType(attachment, filename) {
  const mimeType = String(attachment.mime_type || '');
  if (allowedAttachmentTypes.has(mimeType)) {
    return mimeType;
  }
  return mimeTypeForAttachmentFilename(filename) || 'application/octet-stream';
}

function restoreBackupData(backup, fileSource = {}) {
  if (!backup || !Array.isArray(backup.departments) || !Array.isArray(backup.issues)) {
    throw new Error('That backup file does not look like a Simple Issue Tracker backup.');
  }

  const tmpRoot = fs.mkdtempSync(path.join(TMP_DIR, 'import-'));
  const tmpUploadDir = fileSource.uploadDir || path.join(tmpRoot, 'uploads');
  const tmpLogoDir = fileSource.logoDir || path.join(tmpRoot, 'logo');
  const previousUploads = new Set(fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []);
  const previousLogos = new Set(fs.existsSync(LOGO_DIR) ? fs.readdirSync(LOGO_DIR) : []);
  const previousPasswordHash = getSetting('password_hash');
  let restoredUploads = new Set();
  let restoredLogos = new Set();

  try {
    if (!fileSource.uploadDir) {
      writeBackupFilesTo(tmpUploadDir, backup.attachments || []);
    }
    if (!fileSource.logoDir) {
      writeBackupFilesTo(tmpLogoDir, backup.logos || []);
    }

    // Copy files in before touching the database; old files are only removed once the database commits.
    restoredUploads = stageDirectoryContents(tmpUploadDir, UPLOAD_DIR);
    restoredLogos = stageDirectoryContents(tmpLogoDir, LOGO_DIR);

    const restore = db.transaction(() => {
      const instanceKeys = [...INSTANCE_SETTING_KEYS];
      const instanceSettings = db
        .prepare(`SELECT key, value FROM settings WHERE key IN (${instanceKeys.map(() => '?').join(',')})`)
        .all(...instanceKeys);

      db.prepare('DELETE FROM attachments').run();
      db.prepare('DELETE FROM issue_departments').run();
      db.prepare('DELETE FROM issues').run();
      db.prepare('DELETE FROM departments').run();
      db.prepare('DELETE FROM settings').run();

      const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const setting of backup.settings || []) {
        if (setting && setting.key && !INSTANCE_SETTING_KEYS.has(String(setting.key))) {
          insertSetting.run(String(setting.key), String(setting.value || ''));
        }
      }
      for (const setting of instanceSettings) {
        insertSetting.run(setting.key, setting.value);
      }

      if (!getSetting('password_hash')) {
        setSetting('password_hash', bcrypt.hashSync(DEFAULT_PASSWORD, 12));
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
      if (getSetting('logo_filename') && !configuredLogoFilename()) {
        db.prepare("DELETE FROM settings WHERE key = 'logo_filename'").run();
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
        INSERT INTO issues (id, department_id, poster_name, status, issue_html, resolution_html, search_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of backup.issues) {
        const issueDepartmentId = restoredDepartmentIds.includes(Number(issue.department_id))
          ? Number(issue.department_id)
          : restoredDepartmentIds[0];
        const issueHtml = sanitizeEditorHtml(String(issue.issue_html || ''));
        const resolutionHtml = sanitizeEditorHtml(String(issue.resolution_html || ''));
        insertIssue.run(
          Number(issue.id),
          issueDepartmentId,
          String(issue.poster_name || '').slice(0, 120),
          normalizeStatus(issue.status),
          issueHtml,
          resolutionHtml,
          issueSearchText(issueHtml, resolutionHtml),
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
          restoredAttachmentMimeType(attachment, filename),
          Number(attachment.size || 0),
          attachment.uploaded_at || nowIso()
        );
      }
    });

    restore();
  } catch (error) {
    // Remove staged files that were not there before, so a failed restore leaves everything as it was.
    removeDirectoryEntries(UPLOAD_DIR, (entry) => restoredUploads.has(entry) && !previousUploads.has(entry));
    removeDirectoryEntries(LOGO_DIR, (entry) => restoredLogos.has(entry) && !previousLogos.has(entry));
    throw error;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  removeDirectoryEntries(UPLOAD_DIR, (entry) => !restoredUploads.has(entry));
  removeDirectoryEntries(LOGO_DIR, (entry) => !restoredLogos.has(entry));
  refreshDefaultPasswordFlag();
  return { passwordChanged: getSetting('password_hash') !== previousPasswordHash };
}

function uploadErrorMessage(error, maxSizeLabel) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return `Each file must be ${maxSizeLabel} or smaller.`;
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return `Too many files were selected. Attach up to ${MAX_ATTACHMENT_FILES} at a time.`;
    }
    if (error.code === 'LIMIT_FIELD_VALUE') {
      return 'The text is too long to save. If you pasted an image into the text, attach it as a file instead.';
    }
    return 'The upload could not be processed.';
  }
  return error.message || 'The upload could not be processed.';
}

// Runs a multer middleware, handing any upload error to onError instead of the generic error page.
function uploadMiddleware(middleware, maxSizeLabel, onError) {
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      onError(req, res, uploadErrorMessage(error, maxSizeLabel));
    });
  };
}

function redirectOnUploadError(target) {
  return (req, res, message) => {
    setFlash(req, 'error', message);
    redirectTo(req, res, target);
  };
}

function renderIssueForm(res, options) {
  res.render('issue-form', {
    appName: APP_NAME,
    ...options
  });
}

function issueFromBody(req, base = {}) {
  const body = req.body || {};
  return {
    ...base,
    poster_name: String(body.poster_name || '').trim().slice(0, 120),
    status: normalizeStatus(body.status),
    department_ids: validDepartmentIds(selectedIdsFrom(body.department_ids)),
    issue_html: sanitizeEditorHtml(body.issue_html),
    resolution_html: sanitizeEditorHtml(body.resolution_html)
  };
}

// Shows the form again with what the person typed, so a mistake never throws away their write-up.
function rerenderIssueForm(req, res, { issue, message, status = 422 }) {
  const hadFiles = Boolean(req.files && req.files.length > 0);
  removeUploadedFiles(req.files);
  const isEdit = Boolean(issue.id);
  res.status(status);
  res.locals.flash = {
    type: 'error',
    message: hadFiles ? `${message} Your text was kept, but choose your files again before saving.` : message,
    sticky: true
  };
  renderIssueForm(res, {
    title: isEdit ? 'Edit Issue' : 'Add Issue',
    mode: isEdit ? 'edit' : 'create',
    action: isEdit ? `/issues/${issue.id}` : '/issues',
    issue,
    attachments: isEdit ? getAttachments(issue.id) : [],
    departments: getDepartments()
  });
}

function issueUploadError(req, res, message) {
  if (!req.params.id) {
    rerenderIssueForm(req, res, { issue: issueFromBody(req), message });
    return;
  }

  const existing = getIssue(Number(req.params.id));
  if (!existing) {
    setFlash(req, 'error', 'That issue could not be found.');
    redirectTo(req, res, '/');
    return;
  }
  rerenderIssueForm(req, res, {
    issue: issueFromBody(req, {
      id: existing.id,
      created_at: existing.created_at,
      updated_at: String((req.body && req.body.base_updated_at) || existing.updated_at)
    }),
    message
  });
}

function issueValidationError(issue) {
  if (!issue.poster_name) {
    return 'Add your name before saving.';
  }
  if (issue.department_ids.length === 0) {
    return 'Choose at least one department before saving.';
  }
  if (!textFromHtml(issue.issue_html)) {
    return 'Add the issue details before saving.';
  }
  return '';
}

const loginFailures = new Map();

function loginIsBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.firstFailureAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() - entry.firstFailureAt > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, firstFailureAt: Date.now() });
    return;
  }
  entry.count += 1;
}

setInterval(() => {
  for (const [ip, entry] of loginFailures) {
    if (Date.now() - entry.firstFailureAt > LOGIN_WINDOW_MS) {
      loginFailures.delete(ip);
    }
  }
}, LOGIN_WINDOW_MS).unref();

app.use((req, res, next) => {
  res.locals.appName = APP_NAME;
  res.locals.displayTitle = getSetting('display_title', APP_NAME);
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.appVersion = APP_VERSION;
  res.locals.appBranch = APP_BRANCH;
  res.locals.appCommit = APP_COMMIT ? APP_COMMIT.slice(0, 7) : '';
  res.locals.urlFor = (target) => urlFor(req, target);
  res.locals.csrfToken = () => csrfToken(req);
  res.locals.isAuthenticated = isAuthenticated(req);
  res.locals.passwordIsDefault = getSetting('password_is_default') === '1';
  res.locals.currentPath = req.path;
  res.locals.flash = consumeFlash(req);
  res.locals.formatDate = formatDate;
  res.locals.localTime = localTime;
  const cookieTheme = readCookie(req, THEME_COOKIE);
  res.locals.theme = cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : getSetting('theme', 'dark');
  const logoFilename = configuredLogoFilename();
  res.locals.logoUrl = logoFilename ? urlFor(req, `/logo/${encodeURIComponent(logoFilename)}`) : '';
  res.locals.faviconUrl = urlFor(req, `/site-icon?v=${encodeURIComponent(logoFilename || ASSET_VERSION)}`);
  next();
});

// Every urlencoded POST must carry the form token; multipart posts are only accepted on upload routes.
app.use((req, res, next) => {
  if (req.method !== 'POST') {
    next();
    return;
  }
  if (req.is('multipart/form-data')) {
    if (MULTIPART_ROUTES.some((pattern) => pattern.test(req.path))) {
      next();
      return;
    }
    rejectCsrf(req, res);
    return;
  }
  requireCsrf(req, res, next);
});

app.get('/healthz', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.status(200).json({ ok: true });
});

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) {
    redirectTo(req, res, '/');
    return;
  }
  res.render('login', { appName: APP_NAME });
});

app.post('/login', async (req, res, next) => {
  try {
    if (loginIsBlocked(req.ip)) {
      console.info(`Shared login blocked for ${req.ip} after repeated failures`);
      setFlash(req, 'error', 'Too many incorrect passwords. Wait 15 minutes and try again.');
      redirectTo(req, res, '/login');
      return;
    }

    const password = String(req.body.password || '');
    if (await bcrypt.compare(password, getSetting('password_hash'))) {
      console.info(`Shared login succeeded from ${req.ip}`);
      loginFailures.delete(req.ip);
      signIn(req);
      setFlash(req, 'success', 'You are logged in.');
      redirectTo(req, res, '/');
      return;
    }

    console.info(`Shared login failed from ${req.ip}`);
    recordLoginFailure(req.ip);
    setFlash(req, 'error', 'The password was not correct.');
    redirectTo(req, res, '/login');
  } catch (error) {
    next(error);
  }
});

app.post('/logout', (req, res) => {
  req.session = null;
  redirectTo(req, res, '/login');
});

app.get('/logo/:filename', (req, res) => {
  const configuredLogo = configuredLogoFilename();
  const filename = normalizeFilename(req.params.filename);
  if (!configuredLogo || configuredLogo !== filename) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(path.join(LOGO_DIR, filename));
});

app.get(['/site-icon', '/favicon.ico'], (_req, res) => {
  const filename = configuredLogoFilename();
  if (filename) {
    const logoPath = path.join(LOGO_DIR, filename);
    if (isPathInside(LOGO_DIR, logoPath) && fs.existsSync(logoPath)) {
      res.sendFile(logoPath);
      return;
    }
  }

  res.type('image/svg+xml').send(defaultSiteIconSvg());
});

app.use(requireAuth);

app.use((req, res, next) => {
  if (getSetting('password_is_default') !== '1' || DEFAULT_PASSWORD_ALLOWED_PATHS.has(req.path)) {
    next();
    return;
  }
  setFlash(req, 'error', 'Change the default password before using the tracker.');
  redirectTo(req, res, '/settings');
});

app.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const department = String(req.query.department || '');
  const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';
  const pageSize = pageSizeFrom(req.query.pageSize);
  const page = safePositiveInt(req.query.page, 1);

  const where = [];
  const params = [];

  if (q) {
    const pattern = likePattern(q);
    where.push(`(
      i.search_text LIKE ? ESCAPE '\\'
      OR i.poster_name LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM issue_departments sidp
        JOIN departments sd ON sd.id = sidp.department_id
        WHERE sidp.issue_id = i.id AND sd.name LIKE ? ESCAPE '\\'
      )
    )`);
    params.push(pattern, pattern, pattern);
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
        GROUP_CONCAT(d.name, char(31)) AS department_names
      FROM issues i
      LEFT JOIN issue_departments idp ON idp.issue_id = i.id
      LEFT JOIN departments d ON d.id = idp.department_id
      ${whereSql}
      GROUP BY i.id
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset)
    .map((issue) => ({
      ...issue,
      department_list: String(issue.department_names || '').split(DEPARTMENT_SEPARATOR).filter(Boolean)
    }));
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

app.get('/files', (_req, res) => {
  const groups = new Map(getDepartments().map((department) => [
    department.id, { ...department, files: [] }
  ]));
  const files = db.prepare(`
    SELECT a.*, idp.department_id
    FROM attachments a
    JOIN issues i ON i.id = a.issue_id
    LEFT JOIN issue_departments idp ON idp.issue_id = i.id
    ORDER BY a.uploaded_at DESC, a.id DESC
  `).all();

  for (const file of files) {
    if (!groups.has(file.department_id)) {
      groups.set(file.department_id, { id: 'unassigned', name: 'No department', files: [] });
    }
    groups.get(file.department_id).files.push(file);
  }

  res.render('files', {
    departments: [...groups.values()],
    fileCount: new Set(files.map((file) => file.id)).size,
    formatBytes
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

app.post(
  '/issues',
  uploadMiddleware(attachmentUpload.array('attachments', MAX_ATTACHMENT_FILES), '10 MB', issueUploadError),
  requireCsrf,
  (req, res) => {
    const issue = issueFromBody(req);
    const validationError = issueValidationError(issue);
    if (validationError) {
      rerenderIssueForm(req, res, { issue, message: validationError });
      return;
    }

    const timestamp = nowIso();
    const createIssue = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO issues (department_id, poster_name, status, issue_html, resolution_html, search_text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          issue.department_ids[0],
          issue.poster_name,
          issue.status,
          issue.issue_html,
          issue.resolution_html,
          issueSearchText(issue.issue_html, issue.resolution_html),
          timestamp,
          timestamp
        );

      saveIssueDepartments(result.lastInsertRowid, issue.department_ids);
      return result.lastInsertRowid;
    });

    const issueId = createIssue();
    insertAttachments(issueId, req.files);
    setFlash(req, 'success', 'Issue added.');
    redirectTo(req, res, '/');
  }
);

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

app.post(
  '/issues/:id',
  uploadMiddleware(attachmentUpload.array('attachments', MAX_ATTACHMENT_FILES), '10 MB', issueUploadError),
  requireCsrf,
  (req, res) => {
    const issueId = Number(req.params.id);
    const existingIssue = getIssue(issueId);

    if (!existingIssue) {
      removeUploadedFiles(req.files);
      setFlash(req, 'error', 'That issue could not be found.');
      redirectTo(req, res, '/');
      return;
    }

    const baseUpdatedAt = String(req.body.base_updated_at || '');
    const issue = issueFromBody(req, {
      id: existingIssue.id,
      created_at: existingIssue.created_at,
      updated_at: baseUpdatedAt || existingIssue.updated_at
    });

    if (baseUpdatedAt && baseUpdatedAt !== existingIssue.updated_at) {
      // Point the form at the latest version so saving again deliberately replaces it.
      issue.updated_at = existingIssue.updated_at;
      rerenderIssueForm(req, res, {
        issue,
        status: 409,
        message: 'Someone else saved this issue while you were editing. Your version is shown below: save again to replace theirs, or cancel to keep theirs.'
      });
      return;
    }

    const validationError = issueValidationError(issue);
    if (validationError) {
      rerenderIssueForm(req, res, { issue, message: validationError });
      return;
    }

    deleteAttachmentFiles(issueId, req.body.delete_attachment_ids);
    const updateIssue = db.transaction(() => {
      db.prepare(`
        UPDATE issues
        SET department_id = ?, poster_name = ?, status = ?, issue_html = ?, resolution_html = ?, search_text = ?, updated_at = ?
        WHERE id = ?
      `).run(
        issue.department_ids[0],
        issue.poster_name,
        issue.status,
        issue.issue_html,
        issue.resolution_html,
        issueSearchText(issue.issue_html, issue.resolution_html),
        nowIso(),
        issueId
      );
      saveIssueDepartments(issueId, issue.department_ids);
    });
    updateIssue();
    insertAttachments(issueId, req.files);

    setFlash(req, 'success', 'Issue updated.');
    redirectTo(req, res, '/');
  }
);

app.post('/issues/:id/delete', (req, res) => {
  const issueId = Number(req.params.id);
  const issue = getIssue(issueId);
  if (!issue) {
    setFlash(req, 'error', 'That issue could not be found.');
    redirectTo(req, res, '/');
    return;
  }

  const attachments = getAttachments(issueId);
  db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
  for (const attachment of attachments) {
    removeAttachmentFile(attachment.filename);
  }

  setFlash(req, 'success', `Issue #${issueId} deleted.`);
  redirectTo(req, res, '/');
});

app.get('/uploads/:filename', (req, res) => {
  const filename = normalizeFilename(req.params.filename);
  const attachment = db.prepare('SELECT * FROM attachments WHERE filename = ?').get(filename);
  if (!attachment) {
    res.status(404).send('Not found');
    return;
  }

  if (allowedAttachmentTypes.has(attachment.mime_type)) {
    res.type(attachment.mime_type);
  } else {
    // Anything outside the allowlist is only offered as a download, never rendered by the browser.
    // attachment() guesses a type from the extension, so the type must be set after it.
    res.attachment(attachment.original_filename || filename);
    res.type('application/octet-stream');
  }
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
    nextBackupAt: backupLastRunAt ? nextBackupTime(backupLastRunAt, backupFrequency).toISOString() : '',
    backupFiles: listBackupArchives(),
    minPasswordLength: MIN_PASSWORD_LENGTH
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

app.post(
  '/settings/logo',
  uploadMiddleware(logoUpload.single('logo'), '3 MB', redirectOnUploadError('/settings')),
  requireCsrf,
  (req, res) => {
    if (!req.file) {
      setFlash(req, 'error', 'Choose a logo image to upload.');
      redirectTo(req, res, '/settings');
      return;
    }

    const oldLogo = normalizeFilename(getSetting('logo_filename'));
    setSetting('logo_filename', normalizeFilename(req.file.filename));

    if (oldLogo && oldLogo !== req.file.filename) {
      fs.rm(path.join(LOGO_DIR, oldLogo), { force: true }, () => {});
    }

    setFlash(req, 'success', 'Logo updated.');
    redirectTo(req, res, '/settings');
  }
);

app.post('/settings/theme', (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  setSetting('theme', theme);
  // Let this device follow the new default instead of its own Theme-button choice.
  res.clearCookie(THEME_COOKIE, { path: '/' });
  setFlash(req, 'success', 'Default theme saved. Devices that picked a theme with the Theme button keep their own choice.');
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

app.post('/settings/backups/:filename/delete', (req, res) => {
  const filePath = backupArchivePath(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    setFlash(req, 'error', 'That backup could not be found.');
    redirectTo(req, res, '/settings');
    return;
  }
  fs.rmSync(filePath, { force: true });
  setFlash(req, 'success', 'Backup deleted.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/export', async (req, res) => {
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

app.post(
  '/settings/import',
  uploadMiddleware(backupUpload.single('backup'), '5 GB', redirectOnUploadError('/settings')),
  requireCsrf,
  async (req, res) => {
    if (!req.file) {
      setFlash(req, 'error', 'Choose a backup file to import.');
      redirectTo(req, res, '/settings');
      return;
    }

    try {
      const safetyBackup = await createStoredBackup('pre-restore');
      pruneBackups('-pre-restore.zip', PRE_RESTORE_BACKUP_RETENTION);

      const extension = path.extname(req.file.originalname || req.file.filename || '').toLowerCase();
      let result;
      if (extension === '.json') {
        const backup = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
        result = restoreBackupData(backup);
      } else {
        result = await restoreBackupArchive(req.file.path);
      }

      if (result.passwordChanged) {
        // The restored password replaces the old one, so sign everyone else out as a password change would.
        signOutOtherSessions(req);
      }
      setFlash(req, 'success', `Backup restored. The previous data was saved first as ${safetyBackup.filename}.`);
    } catch (error) {
      console.error(error);
      setFlash(req, 'error', error.message || 'The backup could not be restored.');
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
    }
    redirectTo(req, res, '/settings');
  }
);

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
  const used = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM issue_departments WHERE department_id = ?)
      + (SELECT COUNT(*) FROM issues WHERE department_id = ?) AS count
  `).get(id, id).count;
  if (used > 0) {
    setFlash(req, 'error', 'That department is used by existing issues, so it cannot be deleted.');
    redirectTo(req, res, '/settings');
    return;
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  setFlash(req, 'success', 'Department deleted.');
  redirectTo(req, res, '/settings');
});

app.post('/settings/password', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirm_password || '');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setFlash(req, 'error', `Use at least ${MIN_PASSWORD_LENGTH} characters for the shared password.`);
      redirectTo(req, res, '/settings');
      return;
    }

    if (password !== confirmPassword) {
      setFlash(req, 'error', 'The new passwords did not match.');
      redirectTo(req, res, '/settings');
      return;
    }

    setSetting('password_hash', await bcrypt.hash(password, 12));
    setSetting('password_is_default', '0');
    signOutOtherSessions(req);
    setFlash(req, 'success', 'Password updated. Everyone else will need to sign in again with the new password.');
    redirectTo(req, res, '/settings');
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).render('not-found', { appName: APP_NAME });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).render('error', { appName: APP_NAME });
});

const server = app.listen(PORT, () => {
  console.log(`${APP_NAME} listening on port ${server.address().port}`);
  startScheduledBackups();
});
