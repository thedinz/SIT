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

function titleFromFilename(filename) {
  const name = cleanDisplayFilename(filename);
  const extension = path.extname(name);
  return (extension ? name.slice(0, -extension.length) : name).trim().slice(0, 160) || name;
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

function sheetPreview(filePath) {
  const workbook = XLSX.readFile(filePath, { sheetRows: MAX_SHEET_ROWS + 1, cellFormula: false, cellHTML: false });
  const sheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((name) => {
    const sheet = workbook.Sheets[name];
    const fullRange = sheet['!fullref'] || sheet['!ref'];
    const totalRows = fullRange ? XLSX.utils.decode_range(fullRange).e.r + 1 : 0;
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      range.e.r = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
      sheet['!ref'] = XLSX.utils.encode_range(range);
    }
    return {
      name,
      html: sheet['!ref'] ? sanitizeDocumentHtml(XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' })) : '',
      truncated: totalRows > MAX_SHEET_ROWS
    };
  });
  return {
    kind: 'sheets',
    sheets,
    maxRows: MAX_SHEET_ROWS,
    hiddenSheetCount: Math.max(0, workbook.SheetNames.length - sheets.length)
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
