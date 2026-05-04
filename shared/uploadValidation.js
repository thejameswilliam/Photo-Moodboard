export const MAX_UPLOAD_FILE_SIZE = 8 * 1024 * 1024;
export const MAX_UPLOAD_FILE_SIZE_MB = 8;
export const DEFAULT_UPLOAD_METADATA = {
  originalWidth: 240,
  originalHeight: 180,
};
export const SUPPORTED_UPLOAD_TYPE_LABEL = 'PNG, JPG, GIF, WEBP, and HEIC';

const ALLOWED_MIME_TYPES_BY_EXTENSION = new Map([
  ['.png', new Set(['image/png'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.gif', new Set(['image/gif'])],
  ['.webp', new Set(['image/webp'])],
  ['.heic', new Set(['image/heic', 'image/heif', 'application/octet-stream'])],
  ['.heif', new Set(['image/heif', 'image/heic', 'application/octet-stream'])],
]);

export function validateUploadCandidate({ fileName = '', mimeType = '', size } = {}) {
  const normalizedSize = Number(size);

  if (Number.isFinite(normalizedSize) && normalizedSize > MAX_UPLOAD_FILE_SIZE) {
    return {
      ok: false,
      code: 'file-too-large',
      message: `Images must be ${MAX_UPLOAD_FILE_SIZE_MB} MB or smaller.`,
    };
  }

  const extension = getNormalizedFileExtension(fileName);

  if (!extension || !ALLOWED_MIME_TYPES_BY_EXTENSION.has(extension)) {
    return {
      ok: false,
      code: 'unsupported-file-type',
      message: getUnsupportedFileTypeMessage(),
    };
  }

  const normalizedMimeType = normalizeMimeType(mimeType);
  const allowedMimeTypes = ALLOWED_MIME_TYPES_BY_EXTENSION.get(extension);

  if (normalizedMimeType && allowedMimeTypes.has(normalizedMimeType)) {
    return { ok: true, code: null, message: null };
  }

  if (!normalizedMimeType && isHeicExtension(extension)) {
    return { ok: true, code: null, message: null };
  }

  return {
    ok: false,
    code: 'unsupported-file-type',
    message: getUnsupportedFileTypeMessage(),
  };
}

export function getNormalizedFileExtension(fileName = '') {
  const lastDotIndex = String(fileName).lastIndexOf('.');

  if (lastDotIndex === -1) {
    return '';
  }

  return String(fileName).slice(lastDotIndex).toLowerCase();
}

export function getUnsupportedFileTypeMessage() {
  return `Only ${SUPPORTED_UPLOAD_TYPE_LABEL} images can be added to the mood board.`;
}

function isHeicExtension(extension) {
  return extension === '.heic' || extension === '.heif';
}

function normalizeMimeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
