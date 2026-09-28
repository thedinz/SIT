const sanitizeHtml = require('sanitize-html');

const allowedTags = [
  'p',
  'div',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote'
];

function sanitizeEditorHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'target', 'rel']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer',
        target: '_blank'
      })
    }
  }).trim();
}

function textFromHtml(html) {
  return sanitizeHtml(html || '', {
    allowedTags: [],
    allowedAttributes: {}
  })
    .replace(/\s+/g, ' ')
    .trim();
}

const namedEntities = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const decoded = namedEntities[entity.toLowerCase()];
    return decoded === undefined ? match : decoded;
  });
}

// Plain text used for searching, so queries never match markup or escaped entities.
function searchTextFromHtml(html) {
  const spaced = String(html || '').replace(/<(br|\/p|\/div|\/li|\/blockquote)\b[^>]*>/gi, '$& ');
  return decodeEntities(textFromHtml(spaced));
}

module.exports = {
  sanitizeEditorHtml,
  textFromHtml,
  searchTextFromHtml
};
