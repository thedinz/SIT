// How-to guides: a title, an optional intro, and numbered steps that each hold their own
// text and an ordered set of screenshots.
const path = require('path');
const { db, nowIso } = require('./db');
const { sanitizeEditorHtml, textFromHtml, searchTextFromHtml } = require('./sanitize');

const MAX_HOWTO_STEPS = 100;
const MAX_HOWTO_TITLE = 120;
const MAX_HOWTO_AUTHOR = 120;
const MAX_STEP_HEADING = 120;
const MAX_IMAGE_CAPTION = 200;
const STEP_KEY = /^[sn]\d{1,9}$/;
const STEP_FILE_FIELD = /^step_files_([sn]\d{1,9})$/;
const DEPARTMENT_SEPARATOR = '\u001f';
const HOWTO_IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);

function safeName(filename) {
  return path.basename(String(filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function howtoImageMimeType(filename) {
  return HOWTO_IMAGE_TYPES.get(path.extname(String(filename || '')).toLowerCase()) || '';
}

function listFrom(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function splitDepartments(value) {
  return String(value || '').split(DEPARTMENT_SEPARATOR).filter(Boolean);
}

// Plain text of everything in a guide except the title (searched on its own, as issues do).
function howtoSearchText(howto) {
  const parts = [searchTextFromHtml(howto.intro_html)];
  for (const step of howto.steps || []) {
    parts.push(step.heading || '', searchTextFromHtml(step.body_html));
    for (const image of step.images || []) {
      parts.push(image.caption || '');
    }
  }
  return parts.filter(Boolean).join('\n');
}

function getHowtoSteps(howtoId) {
  const steps = db
    .prepare('SELECT * FROM howto_steps WHERE howto_id = ? ORDER BY position, id')
    .all(howtoId)
    .map((step) => ({ ...step, key: `s${step.id}`, images: [] }));
  if (steps.length === 0) {
    return steps;
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  const images = db
    .prepare(`
      SELECT hi.*
      FROM howto_images hi
      JOIN howto_steps hs ON hs.id = hi.step_id
      WHERE hs.howto_id = ?
      ORDER BY hi.position, hi.id
    `)
    .all(howtoId);
  for (const image of images) {
    byId.get(image.step_id).images.push(image);
  }
  return steps;
}

function getHowto(id) {
  const howto = db.prepare('SELECT * FROM howtos WHERE id = ?').get(id);
  if (!howto) {
    return null;
  }

  const departments = db
    .prepare(`
      SELECT d.id, d.name
      FROM howto_departments hd
      JOIN departments d ON d.id = hd.department_id
      WHERE hd.howto_id = ?
      ORDER BY lower(d.name)
    `)
    .all(id);
  howto.department_ids = departments.map((department) => department.id);
  howto.department_list = departments.map((department) => department.name);
  howto.steps = getHowtoSteps(id);
  return howto;
}

function listHowtos({ pattern = '', departmentId = 0, sort = 'title' } = {}) {
  const where = [];
  const params = [];

  if (pattern) {
    where.push(`(
      h.search_text LIKE ? ESCAPE '\\'
      OR h.title LIKE ? ESCAPE '\\'
      OR h.author_name LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM howto_departments shd
        JOIN departments sd ON sd.id = shd.department_id
        WHERE shd.howto_id = h.id AND sd.name LIKE ? ESCAPE '\\'
      )
    )`);
    params.push(pattern, pattern, pattern, pattern);
  }

  if (departmentId) {
    where.push('EXISTS (SELECT 1 FROM howto_departments fhd WHERE fhd.howto_id = h.id AND fhd.department_id = ?)');
    params.push(departmentId);
  }

  const orderSql = sort === 'updated' ? 'h.updated_at DESC, h.id DESC' : 'lower(h.title), h.id';
  return db
    .prepare(`
      SELECT
        h.*,
        (
          SELECT GROUP_CONCAT(name, char(31))
          FROM (
            SELECT d.name
            FROM howto_departments hd
            JOIN departments d ON d.id = hd.department_id
            WHERE hd.howto_id = h.id
            ORDER BY lower(d.name)
          )
        ) AS department_names,
        (SELECT COUNT(*) FROM howto_steps hs WHERE hs.howto_id = h.id) AS step_count,
        (
          SELECT COUNT(*)
          FROM howto_images hi
          JOIN howto_steps hs ON hs.id = hi.step_id
          WHERE hs.howto_id = h.id
        ) AS image_count,
        (
          SELECT hi.filename
          FROM howto_images hi
          JOIN howto_steps hs ON hs.id = hi.step_id
          WHERE hs.howto_id = h.id
          ORDER BY hs.position, hs.id, hi.position, hi.id
          LIMIT 1
        ) AS cover_filename
      FROM howtos h
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderSql}
    `)
    .all(...params)
    .map((howto) => ({ ...howto, department_list: splitDepartments(howto.department_names) }));
}

function getDepartmentsWithHowtoCounts() {
  return db
    .prepare(`
      SELECT d.*, COUNT(hd.howto_id) AS howto_count
      FROM departments d
      LEFT JOIN howto_departments hd ON hd.department_id = d.id
      GROUP BY d.id
      ORDER BY lower(d.name)
    `)
    .all();
}

function countHowtos() {
  return db.prepare('SELECT COUNT(*) AS count FROM howtos').get().count;
}

function getHowtoImageByFilename(filename) {
  return db.prepare('SELECT * FROM howto_images WHERE filename = ?').get(filename) || null;
}

/*
 * Reads the how-to form. Steps arrive in page order as `step_keys` ("s12" for a saved step,
 * "n3" for a new one). Each step's `step_order_<key>` lists its screenshots in order:
 * "img:<id>" for a saved image (of this guide) and "new:<n>" for the nth file uploaded
 * under `step_files_<key>`. Empty steps are dropped.
 */
function howtoFromForm(body, files, existing, validDepartmentIds) {
  const form = body || {};
  const existingSteps = new Map((existing ? existing.steps : []).map((step) => [step.key, step]));
  const existingImages = new Map();
  for (const step of existing ? existing.steps : []) {
    for (const image of step.images) {
      existingImages.set(image.id, image);
    }
  }

  const filesByKey = new Map();
  for (const file of files || []) {
    const match = STEP_FILE_FIELD.exec(file.fieldname);
    if (!match) {
      continue;
    }
    if (!filesByKey.has(match[1])) {
      filesByKey.set(match[1], []);
    }
    filesByKey.get(match[1]).push(file);
  }

  const keys = [...new Set(listFrom(form.step_keys).map(String).filter((key) => STEP_KEY.test(key)))]
    .slice(0, MAX_HOWTO_STEPS);
  const usedImageIds = new Set();
  const usedFiles = new Set();

  const steps = keys.map((key) => {
    const saved = existingSteps.get(key);
    const newFiles = filesByKey.get(key) || [];
    const newCaptions = listFrom(form[`step_new_caption_${key}`]);
    const images = [];

    const addSaved = (image) => {
      if (!image || usedImageIds.has(image.id)) {
        return;
      }
      usedImageIds.add(image.id);
      const caption = form[`image_caption_${image.id}`];
      images.push({
        ...image,
        caption: String(caption === undefined ? image.caption : caption).trim().slice(0, MAX_IMAGE_CAPTION)
      });
    };
    const addNew = (index) => {
      const file = newFiles[index];
      if (!file || usedFiles.has(file)) {
        return;
      }
      usedFiles.add(file);
      images.push({
        id: null,
        file,
        caption: String(newCaptions[index] || '').trim().slice(0, MAX_IMAGE_CAPTION)
      });
    };

    const order = form[`step_order_${key}`];
    if (order === undefined) {
      // Without the order field (no script ran), a saved step keeps its screenshots as they were.
      (saved ? saved.images : []).forEach((image) => addSaved(existingImages.get(image.id)));
    } else {
      for (const token of String(order).split(',')) {
        const savedMatch = /^img:(\d+)$/.exec(token.trim());
        const newMatch = /^new:(\d+)$/.exec(token.trim());
        if (savedMatch) {
          addSaved(existingImages.get(Number(savedMatch[1])));
        } else if (newMatch) {
          addNew(Number(newMatch[1]));
        }
      }
    }
    newFiles.forEach((_file, index) => addNew(index));

    return {
      key,
      id: saved ? saved.id : null,
      heading: String(form[`step_heading_${key}`] || '').trim().slice(0, MAX_STEP_HEADING),
      body_html: sanitizeEditorHtml(form[`step_body_${key}`]),
      images
    };
  });

  const kept = steps.filter((step) => step.heading || textFromHtml(step.body_html) || step.images.length > 0);
  const keptFiles = new Set();
  for (const step of kept) {
    for (const image of step.images) {
      if (image.file) {
        keptFiles.add(image.file);
      }
    }
  }

  return {
    ...(existing ? { id: existing.id, created_at: existing.created_at } : {}),
    title: String(form.title || '').trim().slice(0, MAX_HOWTO_TITLE),
    author_name: String(form.author_name || '').trim().slice(0, MAX_HOWTO_AUTHOR),
    needs_update: form.needs_update ? 1 : 0,
    department_ids: validDepartmentIds(listFrom(form.department_ids)),
    intro_html: sanitizeEditorHtml(form.intro_html),
    steps: kept,
    unusedFiles: (files || []).filter((file) => !keptFiles.has(file))
  };
}

// The guide as it can be shown again on the form: new uploads are dropped, saved images stay.
function howtoForForm(howto) {
  return {
    ...howto,
    steps: howto.steps.map((step) => ({ ...step, images: step.images.filter((image) => image.id) }))
  };
}

function howtoValidationError(howto) {
  if (!howto.title) {
    return 'Add a title before saving.';
  }
  if (!howto.author_name) {
    return 'Add your name before saving.';
  }
  if (howto.department_ids.length === 0) {
    return 'Choose at least one department before saving.';
  }
  if (howto.steps.length === 0 && !textFromHtml(howto.intro_html)) {
    return 'Add at least one step before saving.';
  }
  return '';
}

// Saves the guide and returns the screenshot files it no longer uses, to delete once committed.
function saveHowto(howto) {
  const timestamp = nowIso();
  const removedFilenames = [];

  const save = db.transaction(() => {
    let howtoId = howto.id || null;
    const searchText = howtoSearchText(howto);
    if (howtoId) {
      db.prepare(`
        UPDATE howtos
        SET title = ?, author_name = ?, intro_html = ?, needs_update = ?, search_text = ?, updated_at = ?
        WHERE id = ?
      `).run(howto.title, howto.author_name, howto.intro_html, howto.needs_update, searchText, timestamp, howtoId);
    } else {
      howtoId = Number(db.prepare(`
        INSERT INTO howtos (title, author_name, intro_html, needs_update, search_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(howto.title, howto.author_name, howto.intro_html, howto.needs_update, searchText, timestamp, timestamp).lastInsertRowid);
    }

    db.prepare('DELETE FROM howto_departments WHERE howto_id = ?').run(howtoId);
    const insertDepartment = db.prepare('INSERT OR IGNORE INTO howto_departments (howto_id, department_id) VALUES (?, ?)');
    for (const departmentId of howto.department_ids) {
      insertDepartment.run(howtoId, departmentId);
    }

    const oldSteps = db.prepare('SELECT id FROM howto_steps WHERE howto_id = ?').all(howtoId);
    const oldImages = db.prepare(`
      SELECT hi.id, hi.filename
      FROM howto_images hi
      JOIN howto_steps hs ON hs.id = hi.step_id
      WHERE hs.howto_id = ?
    `).all(howtoId);
    const ownStepIds = new Set(oldSteps.map((step) => step.id));
    const ownImageIds = new Set(oldImages.map((image) => image.id));
    const keptStepIds = new Set();
    const keptImageIds = new Set();

    const updateStep = db.prepare('UPDATE howto_steps SET position = ?, heading = ?, body_html = ? WHERE id = ? AND howto_id = ?');
    const insertStep = db.prepare('INSERT INTO howto_steps (howto_id, position, heading, body_html) VALUES (?, ?, ?, ?)');
    const moveImage = db.prepare('UPDATE howto_images SET step_id = ?, position = ?, caption = ? WHERE id = ?');
    const insertImage = db.prepare(`
      INSERT INTO howto_images (step_id, position, filename, original_filename, mime_type, size, caption, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    howto.steps.forEach((step, stepIndex) => {
      let stepId = step.id && ownStepIds.has(step.id) ? step.id : null;
      if (stepId) {
        updateStep.run(stepIndex, step.heading, step.body_html, stepId, howtoId);
      } else {
        stepId = Number(insertStep.run(howtoId, stepIndex, step.heading, step.body_html).lastInsertRowid);
      }
      keptStepIds.add(stepId);

      step.images.forEach((image, imageIndex) => {
        if (image.id && ownImageIds.has(image.id)) {
          moveImage.run(stepId, imageIndex, image.caption, image.id);
          keptImageIds.add(image.id);
        } else if (image.file) {
          insertImage.run(
            stepId,
            imageIndex,
            safeName(image.file.filename),
            safeName(image.file.originalname) || 'screenshot',
            image.file.mimetype,
            image.file.size,
            image.caption,
            timestamp
          );
        }
      });
    });

    const deleteImage = db.prepare('DELETE FROM howto_images WHERE id = ?');
    for (const image of oldImages) {
      if (!keptImageIds.has(image.id)) {
        deleteImage.run(image.id);
        removedFilenames.push(image.filename);
      }
    }
    const deleteStep = db.prepare('DELETE FROM howto_steps WHERE id = ?');
    for (const step of oldSteps) {
      if (!keptStepIds.has(step.id)) {
        deleteStep.run(step.id);
      }
    }
    return howtoId;
  });

  return { id: save(), removedFilenames };
}

// Deletes the guide and returns its screenshot files, to delete once the rows are gone.
function deleteHowto(id) {
  const filenames = db.prepare(`
    SELECT hi.filename
    FROM howto_images hi
    JOIN howto_steps hs ON hs.id = hi.step_id
    WHERE hs.howto_id = ?
  `).all(id).map((row) => row.filename);
  db.prepare('DELETE FROM howtos WHERE id = ?').run(id);
  return filenames;
}

function howtoDepartmentUseCount(departmentId) {
  return db.prepare('SELECT COUNT(*) AS count FROM howto_departments WHERE department_id = ?').get(departmentId).count;
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

// The how-to rows of a database, for backups. Older databases without how-tos give empty lists.
function exportHowtoRecords(database = db) {
  if (!tableExists(database, 'howtos')) {
    return { howtos: [], howto_departments: [], howto_steps: [], howto_images: [] };
  }
  return {
    howtos: database.prepare(`
      SELECT id, title, author_name, intro_html, needs_update, created_at, updated_at
      FROM howtos
      ORDER BY id
    `).all(),
    howto_departments: database.prepare('SELECT howto_id, department_id FROM howto_departments ORDER BY howto_id, department_id').all(),
    howto_steps: database.prepare('SELECT id, howto_id, position, heading, body_html FROM howto_steps ORDER BY id').all(),
    howto_images: database.prepare(`
      SELECT id, step_id, position, filename, original_filename, mime_type, size, caption, uploaded_at
      FROM howto_images
      ORDER BY id
    `).all()
  };
}

function clearHowtos() {
  db.prepare('DELETE FROM howto_images').run();
  db.prepare('DELETE FROM howto_steps').run();
  db.prepare('DELETE FROM howto_departments').run();
  db.prepare('DELETE FROM howtos').run();
}

function refreshHowtoSearchText(howtoId) {
  const howto = db.prepare('SELECT intro_html FROM howtos WHERE id = ?').get(howtoId);
  if (!howto) {
    return;
  }
  db.prepare('UPDATE howtos SET search_text = ? WHERE id = ?')
    .run(howtoSearchText({ intro_html: howto.intro_html, steps: getHowtoSteps(howtoId) }), howtoId);
}

// Restores how-to rows inside the caller's restore transaction. Everything is re-sanitized,
// rows that point at missing guides or steps are skipped, and only image files are kept.
function restoreHowtoRecords(backup, restoredDepartmentIds) {
  const howtoIds = new Set();
  const insertHowto = db.prepare(`
    INSERT INTO howtos (id, title, author_name, intro_html, needs_update, search_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)
  `);
  for (const howto of listFrom(backup.howtos)) {
    const id = Number(howto && howto.id);
    if (!Number.isInteger(id) || id <= 0 || howtoIds.has(id)) {
      continue;
    }
    insertHowto.run(
      id,
      String(howto.title || 'Untitled how-to').trim().slice(0, MAX_HOWTO_TITLE) || 'Untitled how-to',
      String(howto.author_name || '').trim().slice(0, MAX_HOWTO_AUTHOR),
      sanitizeEditorHtml(String(howto.intro_html || '')),
      howto.needs_update ? 1 : 0,
      howto.created_at || nowIso(),
      howto.updated_at || howto.created_at || nowIso()
    );
    howtoIds.add(id);
  }

  const insertDepartment = db.prepare('INSERT OR IGNORE INTO howto_departments (howto_id, department_id) VALUES (?, ?)');
  for (const row of listFrom(backup.howto_departments)) {
    const howtoId = Number(row && row.howto_id);
    if (!howtoIds.has(howtoId)) {
      continue;
    }
    const departmentId = restoredDepartmentIds.includes(Number(row.department_id))
      ? Number(row.department_id)
      : restoredDepartmentIds[0];
    insertDepartment.run(howtoId, departmentId);
  }

  const stepIds = new Set();
  const insertStep = db.prepare('INSERT INTO howto_steps (id, howto_id, position, heading, body_html) VALUES (?, ?, ?, ?, ?)');
  for (const step of listFrom(backup.howto_steps)) {
    const id = Number(step && step.id);
    const howtoId = Number(step && step.howto_id);
    if (!Number.isInteger(id) || id <= 0 || stepIds.has(id) || !howtoIds.has(howtoId)) {
      continue;
    }
    insertStep.run(
      id,
      howtoId,
      Number(step.position) || 0,
      String(step.heading || '').trim().slice(0, MAX_STEP_HEADING),
      sanitizeEditorHtml(String(step.body_html || ''))
    );
    stepIds.add(id);
  }

  const imageIds = new Set();
  const filenames = new Set();
  const insertImage = db.prepare(`
    INSERT INTO howto_images (id, step_id, position, filename, original_filename, mime_type, size, caption, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const image of listFrom(backup.howto_images)) {
    const id = Number(image && image.id);
    const stepId = Number(image && image.step_id);
    const filename = safeName(image && image.filename);
    const mimeType = howtoImageMimeType(filename);
    if (!Number.isInteger(id) || id <= 0 || imageIds.has(id) || !stepIds.has(stepId) || !mimeType || filenames.has(filename)) {
      continue;
    }
    insertImage.run(
      id,
      stepId,
      Number(image.position) || 0,
      filename,
      safeName(image.original_filename || filename),
      mimeType,
      Number(image.size || 0),
      String(image.caption || '').trim().slice(0, MAX_IMAGE_CAPTION),
      image.uploaded_at || nowIso()
    );
    imageIds.add(id);
    filenames.add(filename);
  }

  for (const howtoId of howtoIds) {
    refreshHowtoSearchText(howtoId);
  }
}

module.exports = {
  MAX_HOWTO_STEPS,
  STEP_FILE_FIELD,
  howtoImageMimeType,
  getHowto,
  listHowtos,
  getDepartmentsWithHowtoCounts,
  countHowtos,
  getHowtoImageByFilename,
  howtoFromForm,
  howtoForForm,
  howtoValidationError,
  saveHowto,
  deleteHowto,
  howtoDepartmentUseCount,
  exportHowtoRecords,
  clearHowtos,
  restoreHowtoRecords
};
