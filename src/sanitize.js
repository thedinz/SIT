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

module.exports = {
  sanitizeEditorHtml,
  textFromHtml
};
