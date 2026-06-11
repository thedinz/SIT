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

const {
  db,
  DB_PATH,
  UPLOAD_DIR,
  LOGO_DIR,
  getSetting,
  setSetting,
  nowIso
} = require('./db');
const { sanitizeEditorHtml, textFromHtml } = require('./sanitize');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_NAME = 'Production Fix Log';
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_LOGO_SIZE = 3 * 1024 * 1024;
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

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
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
    name: 'pfl_session',
    keys: [process.env.SESSION_SECRET || getSetting('session_secret')],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true'
  })
);

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

function setFlash(req, type, message) {
  req.session.flash = { type, message };
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
  res.redirect('/login');
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

function getDepartmentsWithCounts() {
  return db
    .prepare(`
      SELECT
        d.*,
        COUNT(i.id) AS issue_count
      FROM departments d
      LEFT JOIN issues i ON i.department_id = d.id
      GROUP BY d.id
      ORDER BY lower(d.name)
    `)
    .all();
}

function getDepartments() {
  return db.prepare('SELECT * FROM departments ORDER BY lower(name)').all();
}

function getIssue(id) {
  return db
    .prepare(`
      SELECT i.*, d.name AS department_name
      FROM issues i
      JOIN departments d ON d.id = i.department_id
      WHERE i.id = ?
    `)
    .get(id);
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
      res.redirect(failureRedirect === 'back' ? req.get('referer') || '/' : failureRedirect);
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
  res.locals.isAuthenticated = Boolean(req.session.authenticated);
  res.locals.currentPath = req.path;
  res.locals.flash = consumeFlash(req);
  res.locals.formatDate = formatDate;
  res.locals.theme = req.session.theme || getSetting('theme', 'dark');
  const logoFilename = getSetting('logo_filename');
  res.locals.logoUrl = logoFilename ? `/logo/${encodeURIComponent(logoFilename)}` : '';
  next();
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, database: path.basename(DB_PATH) });
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    res.redirect('/');
    return;
  }
  res.render('login', { appName: APP_NAME });
});

app.post('/login', (req, res) => {
  const password = String(req.body.password || '');
  const passwordHash = getSetting('password_hash');

  if (bcrypt.compareSync(password, passwordHash)) {
    req.session.authenticated = true;
    req.session.theme = getSetting('theme', 'dark');
    setFlash(req, 'success', 'You are logged in.');
    res.redirect('/');
    return;
  }

  setFlash(req, 'error', 'The password was not correct.');
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
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
    where.push('(i.issue_html LIKE ? OR i.resolution_html LIKE ? OR d.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  if (department && department !== 'all') {
    const departmentId = Number(department);
    if (Number.isInteger(departmentId) && departmentId > 0) {
      where.push('i.department_id = ?');
      params.push(departmentId);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM issues i
      JOIN departments d ON d.id = i.department_id
      ${whereSql}
    `)
    .get(...params).total;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const orderSql = sort === 'oldest' ? 'i.created_at ASC, i.id ASC' : 'i.created_at DESC, i.id DESC';

  const issues = db
    .prepare(`
      SELECT i.*, d.name AS department_name
      FROM issues i
      JOIN departments d ON d.id = i.department_id
      ${whereSql}
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
    return queryString ? `/?${queryString}` : '/';
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
      department_id: '',
      issue_html: '',
      resolution_html: ''
    },
    attachments: [],
    departments: getDepartments()
  });
});

app.post('/issues', uploadMiddleware(attachmentUpload.array('attachments', 12), '/issues/new'), (req, res) => {
  const departmentId = Number(req.body.department_id);
  const issueHtml = sanitizeEditorHtml(req.body.issue_html);
  const resolutionHtml = sanitizeEditorHtml(req.body.resolution_html);

  if (!Number.isInteger(departmentId) || !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Choose a department before saving.');
    res.redirect('/issues/new');
    return;
  }

  if (!textFromHtml(issueHtml)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add the issue details before saving.');
    res.redirect('/issues/new');
    return;
  }

  const timestamp = nowIso();
  const result = db
    .prepare(`
      INSERT INTO issues (department_id, issue_html, resolution_html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(departmentId, issueHtml, resolutionHtml, timestamp, timestamp);

  insertAttachments(result.lastInsertRowid, req.files);
  setFlash(req, 'success', 'Issue added.');
  res.redirect('/');
});

app.get('/issues/:id/edit', (req, res) => {
  const issue = getIssue(Number(req.params.id));
  if (!issue) {
    setFlash(req, 'error', 'That issue could not be found.');
    res.redirect('/');
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
    res.redirect('/');
    return;
  }

  const departmentId = Number(req.body.department_id);
  const issueHtml = sanitizeEditorHtml(req.body.issue_html);
  const resolutionHtml = sanitizeEditorHtml(req.body.resolution_html);

  if (!Number.isInteger(departmentId) || !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Choose a department before saving.');
    res.redirect(`/issues/${issueId}/edit`);
    return;
  }

  if (!textFromHtml(issueHtml)) {
    removeUploadedFiles(req.files);
    setFlash(req, 'error', 'Add the issue details before saving.');
    res.redirect(`/issues/${issueId}/edit`);
    return;
  }

  deleteAttachmentFiles(issueId, req.body.delete_attachment_ids);
  db.prepare(`
    UPDATE issues
    SET department_id = ?, issue_html = ?, resolution_html = ?, updated_at = ?
    WHERE id = ?
  `).run(departmentId, issueHtml, resolutionHtml, nowIso(), issueId);
  insertAttachments(issueId, req.files);

  setFlash(req, 'success', 'Issue updated.');
  res.redirect('/');
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

app.get('/logo/:filename', (req, res) => {
  const configuredLogo = getSetting('logo_filename');
  const filename = normalizeFilename(req.params.filename);
  if (!configuredLogo || configuredLogo !== filename) {
    res.status(404).send('Not found');
    return;
  }
  res.sendFile(path.join(LOGO_DIR, filename));
});

app.get('/settings', (_req, res) => {
  res.render('settings', {
    appName: APP_NAME,
    departments: getDepartmentsWithCounts(),
    currentTheme: getSetting('theme', 'dark')
  });
});

app.post('/settings/logo', uploadMiddleware(logoUpload.single('logo'), '/settings'), (req, res) => {
  if (!req.file) {
    setFlash(req, 'error', 'Choose a logo image to upload.');
    res.redirect('/settings');
    return;
  }

  const oldLogo = getSetting('logo_filename');
  setSetting('logo_filename', normalizeFilename(req.file.filename));

  if (oldLogo && oldLogo !== req.file.filename) {
    fs.rm(path.join(LOGO_DIR, oldLogo), { force: true }, () => {});
  }

  setFlash(req, 'success', 'Logo updated.');
  res.redirect('/settings');
});

app.post('/settings/theme', (req, res) => {
  const theme = req.body.theme === 'light' ? 'light' : 'dark';
  setSetting('theme', theme);
  req.session.theme = theme;
  setFlash(req, 'success', 'Theme preference saved.');
  res.redirect('/settings');
});

app.post('/settings/departments', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    setFlash(req, 'error', 'Department name is required.');
    res.redirect('/settings');
    return;
  }

  try {
    const timestamp = nowIso();
    db.prepare('INSERT INTO departments (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, timestamp, timestamp);
    setFlash(req, 'success', 'Department added.');
  } catch (_error) {
    setFlash(req, 'error', 'That department already exists.');
  }
  res.redirect('/settings');
});

app.post('/settings/departments/:id', (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) {
    setFlash(req, 'error', 'Department name is required.');
    res.redirect('/settings');
    return;
  }

  try {
    db.prepare('UPDATE departments SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), id);
    setFlash(req, 'success', 'Department renamed.');
  } catch (_error) {
    setFlash(req, 'error', 'That department name is already in use.');
  }
  res.redirect('/settings');
});

app.post('/settings/departments/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS count FROM issues WHERE department_id = ?').get(id).count;
  if (used > 0) {
    setFlash(req, 'error', 'That department is used by existing issues, so it cannot be deleted.');
    res.redirect('/settings');
    return;
  }

  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  setFlash(req, 'success', 'Department deleted.');
  res.redirect('/settings');
});

app.post('/settings/password', (req, res) => {
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (password.length < 4) {
    setFlash(req, 'error', 'Use at least 4 characters for the shared password.');
    res.redirect('/settings');
    return;
  }

  if (password !== confirmPassword) {
    setFlash(req, 'error', 'The new passwords did not match.');
    res.redirect('/settings');
    return;
  }

  setSetting('password_hash', bcrypt.hashSync(password, 12));
  setFlash(req, 'success', 'Password updated.');
  res.redirect('/settings');
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
});
