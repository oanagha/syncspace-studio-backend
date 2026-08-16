const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const UPLOAD_ROOT = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads')
);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.json',
  '.zip',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.fig',
]);

/** Extension → accepted MIME types (require both when possible). */
const EXT_MIME_MAP = {
  '.pdf': new Set(['application/pdf']),
  '.png': new Set(['image/png']),
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.gif': new Set(['image/gif']),
  '.webp': new Set(['image/webp']),
  '.json': new Set(['application/json', 'text/plain']),
  '.zip': new Set(['application/zip', 'application/x-zip-compressed']),
  '.doc': new Set(['application/msword']),
  '.docx': new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  '.xls': new Set(['application/vnd.ms-excel']),
  '.xlsx': new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  '.ppt': new Set(['application/vnd.ms-powerpoint']),
  '.pptx': new Set([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]),
  '.txt': new Set(['text/plain']),
  '.csv': new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel']),
  '.mp4': new Set(['video/mp4']),
  '.webm': new Set(['video/webm']),
  '.mp3': new Set(['audio/mpeg']),
  '.wav': new Set(['audio/wav', 'audio/x-wav']),
  '.fig': new Set(['application/octet-stream', 'application/zip']),
};

function getMaxUploadBytes() {
  const raw = Number(process.env.UPLOAD_MAX_BYTES);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_MAX_BYTES;
}

function ensureUploadRoot() {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  return UPLOAD_ROOT;
}

function sanitizeOriginalName(name) {
  return String(name || 'file')
    .replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_')
    .slice(0, 200);
}

function extensionOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ext;
}

function isAllowedFile({ originalname, mimetype }) {
  const ext = extensionOf(originalname);
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;

  const mime = String(mimetype || '').toLowerCase().trim();
  if (!mime) return false;

  // Reject bare octet-stream except for known binary formats (.fig).
  if (mime === 'application/octet-stream' && ext !== '.fig') return false;

  const allowedForExt = EXT_MIME_MAP[ext];
  if (allowedForExt && allowedForExt.has(mime)) return true;

  // Fallback: known safe mime + known extension (covers browser mime quirks).
  return ALLOWED_MIME_TYPES.has(mime) && ALLOWED_EXTENSIONS.has(ext);
}

function kindFromName(filename, mimeType) {
  const ext = extensionOf(filename).replace('.', '').toUpperCase();
  if (ext) return ext.slice(0, 4);
  if (mimeType?.includes('pdf')) return 'PDF';
  if (mimeType?.startsWith('image/')) return 'IMG';
  if (mimeType?.startsWith('video/')) return 'VID';
  return 'FILE';
}

function colorForKind(kind) {
  const map = {
    PDF: '#C94F4F',
    PNG: '#5CBDB9',
    JPG: '#5CBDB9',
    JPEG: '#5CBDB9',
    GIF: '#5CBDB9',
    WEBP: '#5CBDB9',
    FIG: '#2D8A9E',
    JSON: '#1A4A6E',
    XLS: '#2F9E7D',
    XLSX: '#2F9E7D',
    DOC: '#D9A441',
    DOCX: '#D9A441',
    MP4: '#E07A5F',
    ZIP: '#64748B',
  };
  return map[kind] || '#1A4A6E';
}

/**
 * Local disk storage. Swap this module later for S3/Cloudinary
 * while keeping the same method signatures.
 */
async function saveFile({ buffer, originalname, mimetype, workspaceId }) {
  ensureUploadRoot();
  const safeName = sanitizeOriginalName(originalname);
  const ext = extensionOf(safeName);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const relativeKey = path.posix.join(String(workspaceId), storedName);
  const absolutePath = path.join(UPLOAD_ROOT, String(workspaceId), storedName);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, buffer);

  return {
    storage_key: relativeKey.replace(/\\/g, '/'),
    stored_name: storedName,
    original_name: safeName,
    mime_type: mimetype || 'application/octet-stream',
    size_bytes: buffer.length,
    absolute_path: absolutePath,
  };
}

async function deleteStoredFile(storageKey) {
  if (!storageKey) return;
  let absolutePath;
  try {
    absolutePath = resolveStoredPath(storageKey);
  } catch {
    return;
  }
  try {
    await fs.promises.unlink(absolutePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function deleteWorkspaceUploadDir(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return;

  const absolutePath = path.join(UPLOAD_ROOT, String(id));
  const normalizedRoot = path.resolve(UPLOAD_ROOT);
  const normalizedPath = path.resolve(absolutePath);
  const relative = path.relative(normalizedRoot, normalizedPath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return;
  }

  await fs.promises.rm(normalizedPath, { recursive: true, force: true });
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function isAllowedAvatar({ originalname, mimetype }) {
  const ext = extensionOf(originalname);
  const mime = String(mimetype || '').toLowerCase().trim();
  if (!AVATAR_EXTENSIONS.has(ext)) return false;
  if (!AVATAR_MIME_TYPES.has(mime)) return false;
  if (mime === 'image/png' && ext !== '.png') return false;
  if (mime === 'image/webp' && ext !== '.webp') return false;
  if (mime === 'image/jpeg' && ext !== '.jpg' && ext !== '.jpeg') return false;
  return true;
}

function getAvatarMaxBytes() {
  return AVATAR_MAX_BYTES;
}

/**
 * Store user avatars under uploads/avatars/{userId}/...
 * Returns a public URL path served from /uploads.
 */
async function saveAvatarFile({ buffer, originalname, mimetype, userId }) {
  ensureUploadRoot();
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid user id for avatar');
  }

  const safeName = sanitizeOriginalName(originalname);
  let ext = extensionOf(safeName);
  if (!AVATAR_EXTENSIONS.has(ext)) {
    if (mimetype === 'image/png') ext = '.png';
    else if (mimetype === 'image/webp') ext = '.webp';
    else ext = '.jpg';
  }

  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const relativeKey = path.posix.join('avatars', String(id), storedName);
  const absolutePath = path.join(UPLOAD_ROOT, 'avatars', String(id), storedName);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, buffer);

  return {
    storage_key: relativeKey.replace(/\\/g, '/'),
    public_path: `/uploads/${relativeKey.replace(/\\/g, '/')}`,
    absolute_path: absolutePath,
    size_bytes: buffer.length,
  };
}

function resolveStoredPath(storageKey) {
  const absolutePath = path.join(UPLOAD_ROOT, storageKey);
  const normalizedRoot = path.resolve(UPLOAD_ROOT);
  const normalizedPath = path.resolve(absolutePath);
  if (!normalizedPath.startsWith(normalizedRoot)) {
    throw new Error('Invalid storage key');
  }
  return normalizedPath;
}

module.exports = {
  UPLOAD_ROOT,
  getMaxUploadBytes,
  getAvatarMaxBytes,
  ensureUploadRoot,
  isAllowedFile,
  isAllowedAvatar,
  kindFromName,
  colorForKind,
  saveFile,
  saveAvatarFile,
  deleteStoredFile,
  deleteWorkspaceUploadDir,
  resolveStoredPath,
};
