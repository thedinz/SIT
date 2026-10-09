const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

// The extension decides everything: browsers report Office types inconsistently, so their MIME type is ignored.
// viewer: how the file opens in the browser. Files without an in-app viewer are offered as a download.
const LIBRARY_TYPES = new Map([
  ['.pdf', { mimeType: 'application/pdf', label: 'PDF', viewer: 'pdf' }],
  ['.jpg', { mimeType: 'image/jpeg', label: 'Image', viewer: 'image' }],
  ['.jpeg', { mimeType: 'image/jpeg', label: 'Image', viewer: 'image' }],
  ['.png', { mimeType: 'image/png', label: 'Image', viewer: 'image' }],
  ['.gif', { mimeType: 'image/gif', label: 'Image', viewer: 'image' }],
  ['.webp', { mimeType: 'image/webp', label: 'Image', viewer: 'image' }],
  ['.docx', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word', viewer: 'word' }],
  ['.doc', { mimeType: 'application/msword', label: 'Word', viewer: '' }],
  ['.odt', { mimeType: 'application/vnd.oasis.opendocument.text', label: 'Document', viewer: '' }],
  ['.rtf', { mimeType: 'application/rtf', label: 'Document', viewer: '' }],
  ['.xlsx', { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', viewer: 'sheet' }],
  ['.xlsm', { mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', label: 'Excel', viewer: 'sheet' }],
  ['.xls', { mimeType: 'application/vnd.ms-excel', label: 'Excel', viewer: 'sheet' }],
  ['.ods', { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', label: 'Spreadsheet', viewer: 'sheet' }],
  ['.csv', { mimeType: 'text/csv', label: 'CSV', viewer: 'sheet' }],
  ['.pptx', { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint', viewer: '' }],
  ['.ppt', { mimeType: 'application/vnd.ms-powerpoint', label: 'PowerPoint', viewer: '' }],
  ['.odp', { mimeType: 'application/vnd.oasis.opendocument.presentation', label: 'Presentation', viewer: '' }],
  ['.txt', { mimeType: 'text/plain', label: 'Text', viewer: 'text' }],
  ['.md', { mimeType: 'text/plain', label: 'Text', viewer: 'text' }]
]);

// Only these are ever sent for the browser to display; everything else is served as a download.
const INLINE_VIEWERS = new Set(['pdf', 'image', 'text']);
const MAX_PREVIEW_SIZE = 20 * 1024 * 1024;
const MAX_TEXT_PREVIEW_SIZE = 1024 * 1024;
const MAX_SHEET_ROWS = 500;
const MAX_SHEETS = 25;
const MAX_SHEET_COLUMNS = 200;

function libraryExtension(filename) {
  return path.extname(filename || '').toLowerCase();
}

function libraryTypeFor(filename) {
  return LIBRARY_TYPES.get(libraryExtension(filename)) || null;
}

function libraryAcceptList() {
  return [...LIBRARY_TYPES.keys()].join(',');
}

function libraryExtensionsLabel() {
  return [...new Set([...LIBRARY_TYPES.keys()].map((extension) => extension.slice(1)))].join(', ');
}

// Keeps the name people gave the file (spaces and all) while dropping paths and control characters.
function cleanDisplayFilename(filename) {
  const name = path.basename(String(filename || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return name || 'file';
}

const TITLE_SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);

// Turns "new-hope-network-team-reference.xlsx" into "New Hope Network Team Reference", so nobody has to
// rename files before uploading. Names that already have capitals keep them.
// Keep in step with titleFromFilename in public/js/app.js, which pre-fills the upload form.
function titleFromFilename(filename) {
  const name = cleanDisplayFilename(filename);
  const extension = path.extname(name);
  const stem = (extension ? name.slice(0, -extension.length) : name).replace(/[_.\s-]+/g, ' ').trim();
  if (!stem) {
    return name.slice(0, 160);
  }
  const title = stem === stem.toLowerCase()
    ? stem.split(' ').map((word, index) => (
      index > 0 && TITLE_SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)
    )).join(' ')
    : stem;
  return title.slice(0, 160);
}

function sanitizeDocumentHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'a', 'img',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' })
    }
  }).trim();
}

async function wordPreview(filePath) {
  // Embedded pictures become data: URIs; linked files outside the document are never read.
  const result = await mammoth.convertToHtml({ path: filePath }, { externalFileAccess: false });
  const html = sanitizeDocumentHtml(result.value);
  return html ? { kind: 'word', html } : { kind: 'none', reason: 'This document has no text to show.' };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Excel's default column is 64px wide; files that never set widths (CSV, generated sheets) are sized to their text.
const DEFAULT_COLUMN_PX = 64;
const MIN_COLUMN_PX = 28;
const MAX_ESTIMATED_COLUMN_PX = 360;
// The page font runs wider than Excel's Calibri, so saved widths are scaled up to fit the same text.
const SAVED_WIDTH_SCALE = 1.2;

function savedColumnWidth(column) {
  if (!column) {
    return 0;
  }
  if (column.wpx) {
    return column.wpx;
  }
  if (column.wch) {
    return Math.round(column.wch * 7 + 5);
  }
  return column.width ? Math.round(column.width * 7) : 0;
}

// Builds the table by hand so it keeps the sheet's own column widths, hidden rows and columns, and merged cells.
function renderSheetTable(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  range.e.r = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
  const columns = sheet['!cols'] || [];
  const rowInfo = sheet['!rows'] || [];

  const text = (r, c) => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })];
    return cell ? XLSX.utils.format_cell(cell) : '';
  };

  // Sheets often claim a larger used range than they fill, so trailing empty rows and columns are dropped.
  // Only cells that exist are checked, since a claimed range can span thousands of empty columns.
  let lastRow = range.s.r - 1;
  let lastColumn = range.s.c - 1;
  for (const address of Object.keys(sheet)) {
    if (address[0] === '!') {
      continue;
    }
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c && text(r, c) !== '') {
      lastRow = Math.max(lastRow, r);
      lastColumn = Math.max(lastColumn, c);
    }
  }
  if (lastRow < range.s.r) {
    return '';
  }
  lastColumn = Math.min(lastColumn, range.s.c + MAX_SHEET_COLUMNS - 1);

  const spans = new Map();
  const covered = new Set();
  for (const merge of sheet['!merges'] || []) {
    if (merge.s.r > lastRow || merge.s.c > lastColumn) {
      continue;
    }
    const mergeLastRow = Math.min(merge.e.r, lastRow);
    const mergeLastColumn = Math.min(merge.e.c, lastColumn);
    spans.set(`${merge.s.r}:${merge.s.c}`, {
      rowspan: mergeLastRow - merge.s.r + 1,
      colspan: mergeLastColumn - merge.s.c + 1
    });
    for (let r = merge.s.r; r <= mergeLastRow; r += 1) {
      for (let c = merge.s.c; c <= mergeLastColumn; c += 1) {
        if (r !== merge.s.r || c !== merge.s.c) {
          covered.add(`${r}:${c}`);
        }
      }
    }
  }

  const rows = [];
  for (let r = range.s.r; r <= lastRow; r += 1) {
    if (!(rowInfo[r] && rowInfo[r].hidden)) {
      rows.push(r);
    }
  }
  const visibleColumns = [];
  for (let c = range.s.c; c <= lastColumn; c += 1) {
    if (!(columns[c] && columns[c].hidden)) {
      visibleColumns.push(c);
    }
  }

  const hasSavedWidths = columns.some((column) => savedColumnWidth(column) > 0);
  const widths = visibleColumns.map((c) => {
    if (hasSavedWidths) {
      return Math.max(MIN_COLUMN_PX, (savedColumnWidth(columns[c]) || DEFAULT_COLUMN_PX) * SAVED_WIDTH_SCALE);
    }
    const longest = rows.slice(0, 200).reduce((length, r) => {
      const lines = text(r, c).split('\n');
      return Math.max(length, ...lines.map((line) => line.length));
    }, 0);
    return Math.min(MAX_ESTIMATED_COLUMN_PX, Math.max(DEFAULT_COLUMN_PX, longest * 7.5 + 20));
  });

  const colgroup = ['<col data-width="46">']
    .concat(widths.map((width) => `<col data-width="${Math.round(width)}">`))
    .join('');
  const head = '<th class="sheet-corner"></th>'
    + visibleColumns.map((c) => `<th scope="col">${XLSX.utils.encode_col(c)}</th>`).join('');
  const body = rows.map((r) => {
    const cells = visibleColumns.map((c) => {
      const key = `${r}:${c}`;
      if (covered.has(key)) {
        return '';
      }
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      const span = spans.get(key);
      const attributes = [
        span && span.colspan > 1 ? ` colspan="${span.colspan}"` : '',
        span && span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : '',
        cell && cell.t === 'n' ? ' class="sheet-number"' : ''
      ].join('');
      const value = text(r, c);
      // The full text on hover, for words clipped by a narrow column.
      const title = value.length > 12 ? ` title="${escapeHtml(value)}"` : '';
      return `<td${attributes}${title}>${escapeHtml(value)}</td>`;
    }).join('');
    return `<tr><th scope="row">${r + 1}</th>${cells}</tr>`;
  }).join('');

  return `<table class="sheet-table"><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sheetPreview(filePath) {
  // cellStyles is what makes SheetJS read column widths and hidden rows and columns.
  const workbook = XLSX.readFile(filePath, {
    sheetRows: MAX_SHEET_ROWS + 1,
    cellFormula: false,
    cellHTML: false,
    cellStyles: true
  });
  const sheetInfo = (workbook.Workbook && workbook.Workbook.Sheets) || [];
  const visibleNames = workbook.SheetNames.filter((_name, index) => !(sheetInfo[index] && sheetInfo[index].Hidden));
  const sheets = visibleNames.slice(0, MAX_SHEETS).map((name) => {
    const sheet = workbook.Sheets[name];
    const fullRange = sheet['!fullref'] || sheet['!ref'];
    const totalRows = fullRange ? XLSX.utils.decode_range(fullRange).e.r + 1 : 0;
    return {
      name,
      html: sheet['!ref'] ? renderSheetTable(sheet) : '',
      truncated: totalRows > MAX_SHEET_ROWS
    };
  });
  return {
    kind: 'sheets',
    sheets,
    maxRows: MAX_SHEET_ROWS,
    hiddenSheetCount: Math.max(0, visibleNames.length - sheets.length)
  };
}

function textPreview(filePath, size) {
  const length = Math.min(size, MAX_TEXT_PREVIEW_SIZE);
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(filePath, 'r');
  try {
    fs.readSync(handle, buffer, 0, length, 0);
  } finally {
    fs.closeSync(handle);
  }
  return { kind: 'text', text: buffer.toString('utf8'), truncated: size > MAX_TEXT_PREVIEW_SIZE };
}

// Builds what the viewer page shows. Failures never throw: the page falls back to offering a download.
async function buildPreview(filePath, file) {
  const type = libraryTypeFor(file.filename);
  if (!type || !type.viewer) {
    return { kind: 'none', reason: 'This file type cannot be shown in the browser.' };
  }
  if (type.viewer === 'pdf' || type.viewer === 'image') {
    return { kind: type.viewer };
  }
  if (!fs.existsSync(filePath)) {
    return { kind: 'none', reason: 'The stored file is missing.' };
  }
  if (type.viewer === 'text') {
    return textPreview(filePath, file.size);
  }
  if (file.size > MAX_PREVIEW_SIZE) {
    return { kind: 'none', reason: 'This file is too large to preview.' };
  }

  try {
    return type.viewer === 'word' ? await wordPreview(filePath) : sheetPreview(filePath);
  } catch (error) {
    console.error(`Library preview failed for ${file.filename}:`, error.message);
    return { kind: 'none', reason: 'This file could not be read for a preview.' };
  }
}

module.exports = {
  LIBRARY_TYPES,
  INLINE_VIEWERS,
  libraryExtension,
  libraryTypeFor,
  libraryAcceptList,
  libraryExtensionsLabel,
  cleanDisplayFilename,
  titleFromFilename,
  buildPreview
};
