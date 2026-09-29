const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const yauzl = require('yauzl');
const yazl = require('yazl');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const NEW_PASSWORD = 'new-password-123';

let serverProcess;
let baseUrl;
let dataDir;
let serverOutput = '';

class Client {
  constructor() {
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(urlPath, options = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: options.method || 'GET',
      body: options.body,
      headers: { ...(options.headers || {}), cookie: this.cookieHeader() },
      redirect: 'manual'
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return response;
  }

  async page(urlPath) {
    const response = await this.request(urlPath);
    return { response, text: await response.text() };
  }

  async token(urlPath = '/login') {
    const { text } = await this.page(urlPath);
    const match = text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, `no CSRF token on ${urlPath}`);
    return match[1];
  }

  async post(urlPath, fields, tokenPage = '/settings') {
    const token = fields._csrf === undefined ? await this.token(tokenPage) : fields._csrf;
    const body = new URLSearchParams({ ...fields, _csrf: token });
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        body.delete(key);
        value.forEach((item) => body.append(key, item));
      }
    }
    return this.request(urlPath, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
  }

  async postMultipart(urlPath, fields, files = [], tokenPage = '/issues/new') {
    const form = new FormData();
    form.append('_csrf', fields._csrf === undefined ? await this.token(tokenPage) : fields._csrf);
    for (const [key, value] of Object.entries(fields)) {
      if (key === '_csrf') continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        form.append(key, item);
      }
    }
    for (const file of files) {
      form.append(file.field, new Blob([file.data], { type: file.type }), file.name);
    }
    return this.request(urlPath, { method: 'POST', body: form });
  }

  async login(password) {
    const token = await this.token('/login');
    return this.post('/login', { password, _csrf: token });
  }
}

function liveDb() {
  return new Database(path.join(dataDir, 'db', 'simple_issue_tracker.sqlite'), { readonly: true });
}

function setting(key) {
  const database = liveDb();
  try {
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : undefined;
  } finally {
    database.close();
  }
}

function departmentId(name) {
  const database = liveDb();
  try {
    return database.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
  } finally {
    database.close();
  }
}

function backupFiles() {
  return fs.readdirSync(path.join(dataDir, 'backups')).filter((name) => name.endsWith('.zip'));
}

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) return reject(error);
      const entries = new Map();
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
        });
      });
      zipFile.on('end', () => resolve(entries));
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

function buildDocx(bodyXml) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>'
  ), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'
  ), '_rels/.rels');
  zip.addBuffer(Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${bodyXml}</w:body></w:document>`
  ), 'word/document.xml');
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function buildXlsx() {
  const workbook = XLSX.utils.book_new();
  const inputs = XLSX.utils.aoa_to_sheet([['Channel', 'Source', 'Secret'], [1, 'Kick <script>alert(1)</script>', 'hidden value'], ['Drums', '']]);
  inputs['!cols'] = [{ wpx: 70 }, { wpx: 300 }, { hidden: true }];
  inputs['!merges'] = [{ s: { r: 2, c: 0 }, e: { r: 2, c: 1 } }];
  XLSX.utils.book_append_sheet(workbook, inputs, 'Inputs');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Mix', 'Wedge'], ['Monitor 1', 'Stage left']]), 'Monitors');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function libraryRows() {
  const database = liveDb();
  try {
    return database.prepare('SELECT * FROM library_files ORDER BY id').all();
  } finally {
    database.close();
  }
}

async function dashboard(client, query = '') {
  const { response, text } = await client.page(`/${query}`);
  assert.equal(response.status, 200, `dashboard status for ${query}`);
  const total = Number((text.match(/<span>(\d+) total<\/span>/) || [0, 0])[1]);
  return { text, total };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-test-'));
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'test', SESSION_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverOutput += chunk;
  });
  baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${serverOutput}`)), 15000);
    serverProcess.stdout.on('data', (chunk) => {
      serverOutput += chunk;
      const match = String(serverOutput).match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    serverProcess.on('exit', (code) => reject(new Error(`server exited ${code}:\n${serverOutput}`)));
  });
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
    serverProcess.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const admin = new Client();
const otherDevice = new Client();

test('health check does not reveal internals', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('login requires the form token and the right password', async () => {
  const noToken = await admin.request('/login', {
    method: 'POST',
    body: new URLSearchParams({ password: 'admin' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  assert.equal(noToken.status, 303);
  assert.equal((await admin.request('/')).status, 302);

  const wrong = await admin.login('wrong');
  assert.match(wrong.headers.get('location'), /login/);

  const right = await admin.login('admin');
  assert.doesNotMatch(right.headers.get('location'), /login/);
  await otherDevice.login('admin');
});

test('the default password must be changed before using the tracker', async () => {
  const response = await admin.request('/');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /settings/);

  const { text } = await admin.page('/settings');
  assert.match(text, /Change the default password/);
});

test('posts without a valid token change nothing', async () => {
  const forged = await admin.post('/settings/title', { display_title: 'Hacked', _csrf: 'x'.repeat(48) });
  assert.equal(forged.status, 303);
  assert.equal(setting('display_title'), 'Simple Issue Tracker');

  const form = new FormData();
  form.append('ignored', 'value');
  const multipart = await admin.request('/settings/backups/run', { method: 'POST', body: form });
  assert.equal(multipart.status, 303);
  assert.deepEqual(backupFiles(), []);
});

test('changing the password signs out other devices', async () => {
  const short = await admin.post('/settings/password', { password: 'short', confirm_password: 'short' });
  assert.equal(short.status, 302);
  assert.equal(setting('password_is_default'), '1');

  await admin.post('/settings/password', { password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
  assert.equal(setting('password_is_default'), '0');

  assert.equal((await admin.request('/')).status, 200);
  const stale = await otherDevice.request('/');
  assert.equal(stale.status, 302);
  assert.match(stale.headers.get('location'), /login/);
});

test('a rejected issue keeps what was typed', async () => {
  const response = await admin.postMultipart('/issues', {
    poster_name: 'Sam',
    status: 'pending',
    issue_html: '<p>Projector flickers during worship</p>',
    resolution_html: ''
  });
  assert.equal(response.status, 422);
  const text = await response.text();
  assert.match(text, /Choose at least one department/);
  assert.match(text, /Projector flickers during worship/);
  assert.match(text, /value="Sam"/);
});

test('an oversized pasted image keeps the form instead of losing it', async () => {
  const response = await admin.postMultipart('/issues', {
    poster_name: 'Sam',
    status: 'pending',
    department_ids: String(departmentId('Audio')),
    issue_html: `<p>Look</p><img src="data:image/png;base64,${'A'.repeat(2.5 * 1024 * 1024)}">`,
    resolution_html: ''
  });
  assert.equal(response.status, 422);
  const text = await response.text();
  assert.match(text, /pasted an image/);
  assert.match(text, /value="Sam"/);
});

let issueId;

test('issues save with attachments, and search ignores markup', async () => {
  await admin.post('/settings/departments', { name: 'Audio, Monitors' });
  const response = await admin.postMultipart(
    '/issues',
    {
      poster_name: 'Alex',
      status: 'pending',
      department_ids: [String(departmentId('Audio, Monitors'))],
      issue_html: '<p>Mic &amp; stand <strong>broke</strong></p>',
      resolution_html: ''
    },
    [{ field: 'attachments', name: 'photo.png', type: 'image/png', data: PNG }]
  );
  assert.equal(response.status, 302);

  const database = liveDb();
  issueId = database.prepare('SELECT id FROM issues ORDER BY id DESC').get().id;
  database.close();

  const all = await dashboard(admin);
  assert.match(all.text, /<span class="department-pill">Audio, Monitors<\/span>/);
  assert.equal((await dashboard(admin, '?q=%26')).total, 1);
  assert.equal((await dashboard(admin, '?q=strong')).total, 0);
  assert.equal((await dashboard(admin, '?q=%25')).total, 0);
  assert.equal((await dashboard(admin, '?q=broke')).total, 1);
  assert.match(all.text, /<time datetime="[^"]+" data-local-time>/);
});

test('saving over someone else\'s newer edit is caught', async () => {
  const { text } = await admin.page(`/issues/${issueId}/edit`);
  const base = text.match(/name="base_updated_at" value="([^"]+)"/)[1];
  const fields = (body) => ({
    poster_name: 'Alex',
    status: 'pending',
    department_ids: String(departmentId('Audio, Monitors')),
    issue_html: `<p>${body}</p>`,
    resolution_html: '',
    base_updated_at: base
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = await admin.postMultipart(`/issues/${issueId}`, fields('First editor'), [], `/issues/${issueId}/edit`);
  assert.equal(first.status, 302);

  const second = await admin.postMultipart(`/issues/${issueId}`, fields('Second editor'), [], `/issues/${issueId}/edit`);
  assert.equal(second.status, 409);
  const secondText = await second.text();
  assert.match(secondText, /Someone else saved this issue/);
  assert.match(secondText, /Second editor/);

  const database = liveDb();
  assert.match(database.prepare('SELECT issue_html FROM issues WHERE id = ?').get(issueId).issue_html, /First editor/);
  database.close();
});

const libraryIds = {};

test('library files upload and open in the browser', async () => {
  const docx = await buildDocx(
    '<w:p><w:r><w:t>Downstage center</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Mic 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Pulpit</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  );
  const response = await admin.postMultipart(
    '/library',
    { department_id: String(departmentId('Audio')), description: 'Sunday setup' },
    [
      { field: 'files', name: 'Stage Plot.docx', type: 'application/octet-stream', data: docx },
      { field: 'files', name: 'Input List.xlsx', type: '', data: buildXlsx() },
      { field: 'files', name: 'Manual.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') }
    ],
    '/library'
  );
  assert.equal(response.status, 302);

  const rows = libraryRows();
  assert.deepEqual(rows.map((row) => row.title), ['Stage Plot', 'Input List', 'Manual']);
  assert.equal(rows[0].original_filename, 'Stage Plot.docx');
  assert.equal(rows[0].department_id, departmentId('Audio'));
  [libraryIds.docx, libraryIds.xlsx, libraryIds.pdf] = rows.map((row) => row.id);

  const list = await admin.page('/library');
  assert.match(list.text, /Stage Plot/);
  assert.match(list.text, /Sunday setup/);
  const search = await admin.page('/library?q=plot');
  assert.match(search.text, /Stage Plot/);
  assert.doesNotMatch(search.text, /Input List/);

  const word = await admin.page(`/library/${libraryIds.docx}`);
  assert.match(word.text, /class="doc-page"/);
  assert.match(word.text, /Downstage center/);
  assert.match(word.text, /<td>.*Pulpit.*<\/td>/s);

  const sheet = await admin.page(`/library/${libraryIds.xlsx}`);
  assert.match(sheet.text, /data-sheet-tab="1">Monitors</);
  assert.match(sheet.text, /Stage left/);
  assert.match(sheet.text, /Kick &lt;script&gt;/);
  assert.doesNotMatch(sheet.text, /<script>alert/);
  assert.match(sheet.text, /<col data-width="84"><col data-width="360"><\/colgroup>/);
  assert.doesNotMatch(sheet.text, /hidden value/);
  assert.match(sheet.text, /<td colspan="2">Drums<\/td>/);

  const download = await admin.request(`/library/${libraryIds.docx}/file`);
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="Stage Plot.docx"/);
  const pdf = await admin.request(`/library/${libraryIds.pdf}/file`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline/);
  const pdfDownload = await admin.request(`/library/${libraryIds.pdf}/file?download=1`);
  assert.match(pdfDownload.headers.get('content-disposition'), /^attachment/);
});

test('the library refuses file types it cannot safely serve', async () => {
  const before = fs.readdirSync(path.join(dataDir, 'uploads', 'library')).length;
  const response = await admin.postMultipart(
    '/library',
    {},
    [
      { field: 'files', name: 'notes.txt', type: 'text/plain', data: Buffer.from('fine') },
      { field: 'files', name: 'page.html', type: 'text/plain', data: Buffer.from('<script>alert(1)</script>') }
    ],
    '/library'
  );
  assert.equal(response.status, 302);
  const { text } = await admin.page('/library');
  assert.match(text, /page\.html is not an allowed file type/);
  assert.equal(libraryRows().length, 3);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads', 'library')).length, before);
});

test('library files can be edited, replaced, and deleted', async () => {
  const [oldRow] = libraryRows();
  const replacement = await buildDocx('<w:p><w:r><w:t>Version two</w:t></w:r></w:p>');
  const response = await admin.postMultipart(
    `/library/${libraryIds.docx}`,
    { title: 'Stage Plot (Main Hall)', department_id: '', description: '' },
    [{ field: 'file', name: 'stage-plot-v2.docx', type: '', data: replacement }],
    `/library/${libraryIds.docx}/edit`
  );
  assert.equal(response.status, 302);

  const updated = libraryRows().find((row) => row.id === libraryIds.docx);
  assert.equal(updated.title, 'Stage Plot (Main Hall)');
  assert.equal(updated.department_id, null);
  assert.equal(updated.original_filename, 'stage-plot-v2.docx');
  assert.match((await admin.page(`/library/${libraryIds.docx}`)).text, /Version two/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'library', oldRow.filename)));

  const pdfRow = libraryRows().find((row) => row.id === libraryIds.pdf);
  await admin.post(`/library/${libraryIds.pdf}/delete`, {}, '/library');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!libraryRows().some((row) => row.id === libraryIds.pdf));
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'library', pdfRow.filename)));
  assert.equal((await admin.request(`/library/${libraryIds.pdf}/file`)).status, 404);
});

let backupPath;

test('backups leave out this server\'s session secret', async () => {
  const secret = setting('session_secret');
  await admin.post('/settings/backups/run', {});
  const [backupName] = backupFiles();
  assert.ok(backupName);
  backupPath = path.join(dataDir, 'backups', backupName);

  const entries = await readZip(backupPath);
  const records = JSON.parse(entries.get('metadata/records.json').toString('utf8'));
  assert.ok(!records.settings.some((row) => row.key === 'session_secret' || row.key === 'session_version'));
  assert.ok(records.settings.some((row) => row.key === 'password_hash'));

  const snapshot = entries.get('database/simple_issue_tracker.sqlite');
  assert.ok(!snapshot.includes(Buffer.from(secret)), 'secret bytes left in the SQLite snapshot');
  assert.ok([...entries.keys()].some((name) => name.startsWith('uploads/')));
  assert.equal([...entries.keys()].filter((name) => name.startsWith('library/')).length, 2);
  assert.ok(![...entries.keys()].some((name) => name.startsWith('uploads/library')));
  assert.equal(records.library_files.length, 2);
});

test('restoring a zip saves the current data first and keeps you signed in', async () => {
  const response = await admin.postMultipart(
    '/settings/import',
    {},
    [{ field: 'backup', name: 'backup.zip', type: 'application/zip', data: fs.readFileSync(backupPath) }],
    '/settings'
  );
  assert.equal(response.status, 302);
  const { text } = await admin.page('/settings');
  assert.match(text, /Backup restored/);
  assert.ok(backupFiles().some((name) => name.endsWith('-pre-restore.zip')));
  assert.equal((await dashboard(admin, '?q=First')).total, 1);

  const database = liveDb();
  const attachment = database.prepare('SELECT filename FROM attachments').get();
  database.close();
  assert.equal((await admin.request(`/uploads/${attachment.filename}`)).status, 200);

  assert.equal(libraryRows().length, 2);
  assert.match((await admin.page(`/library/${libraryIds.docx}`)).text, /Version two/);
  assert.equal((await admin.request(`/library/${libraryIds.xlsx}/file`)).status, 200);
});

test('a hostile backup cannot inject scripts, HTML files, or secrets', async () => {
  const secretBefore = setting('session_secret');
  const bystander = new Client();
  await bystander.login(NEW_PASSWORD);
  assert.equal((await bystander.request('/')).status, 200);

  const backup = {
    settings: [
      { key: 'password_hash', value: bcrypt.hashSync('restored-pass-1', 4) },
      { key: 'session_secret', value: 'attacker-secret' },
      { key: 'logo_filename', value: 'evil.html' }
    ],
    departments: [{ id: 1, name: 'Audio' }],
    issues: [{
      id: 1,
      department_id: 1,
      poster_name: 'Mallory',
      status: 'pending',
      issue_html: '<script>alert(1)</script><p>Looks normal</p>',
      resolution_html: '<img src=x onerror=alert(2)>'
    }],
    issue_departments: [{ issue_id: 1, department_id: 1 }],
    attachments: [{
      id: 1,
      issue_id: 1,
      filename: 'page.html',
      original_filename: 'page.html',
      mime_type: 'text/html',
      size: 20,
      data_base64: Buffer.from('<script>alert(3)</script>').toString('base64')
    }],
    logos: [{ filename: 'evil.html', data_base64: Buffer.from('<script>alert(4)</script>').toString('base64') }]
  };

  await admin.postMultipart(
    '/settings/import',
    {},
    [{ field: 'backup', name: 'backup.json', type: 'application/json', data: JSON.stringify(backup) }],
    '/settings'
  );

  assert.equal(setting('session_secret'), secretBefore);
  assert.equal(setting('logo_filename'), undefined);

  const { text } = await dashboard(admin);
  assert.match(text, /Looks normal/);
  assert.doesNotMatch(text, /<script>alert/);
  assert.doesNotMatch(text, /onerror/);

  const upload = await admin.request('/uploads/page.html');
  assert.equal(upload.headers.get('content-type'), 'application/octet-stream');
  assert.match(upload.headers.get('content-disposition'), /attachment/);
  assert.equal((await admin.request('/logo/evil.html')).status, 404);

  // The backup had no library, so the restore empties it.
  assert.equal(libraryRows().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads', 'library')), []);

  const signedOut = await bystander.request('/');
  assert.match(signedOut.headers.get('location'), /login/, 'restoring a different password should sign others out');
});

test('issues can be deleted along with their files', async () => {
  const response = await admin.post('/issues/1/delete', {}, '/issues/1/edit');
  assert.equal(response.status, 302);
  assert.equal((await dashboard(admin)).total, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', 'page.html')));
});

test('stored backups can be deleted', async () => {
  const [name] = backupFiles();
  await admin.post(`/settings/backups/${encodeURIComponent(name)}/delete`, {});
  assert.ok(!backupFiles().includes(name));
});

test('the theme cookie is rendered by the server', async () => {
  admin.cookies.set('sit_theme', 'light');
  const { text } = await admin.page('/');
  assert.match(text, /<html lang="en" data-theme="light">/);
  admin.cookies.delete('sit_theme');
});

test('logout needs a form post', async () => {
  assert.equal((await admin.request('/logout')).status, 404);
  await admin.post('/logout', {}, '/');
  assert.match((await admin.request('/')).headers.get('location'), /login/);
});

test('repeated wrong passwords lock out that address', async () => {
  const attacker = new Client();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await attacker.login('guess');
  }
  await attacker.login('restored-pass-1');
  const { text } = await attacker.page('/login');
  assert.match(text, /Too many incorrect passwords/);
  assert.match((await attacker.request('/')).headers.get('location'), /login/);
});
