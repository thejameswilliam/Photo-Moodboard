import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

function normalizeBoolean(value, fallback = false) {
  if (typeof value !== 'string') {
    return fallback;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  return fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePath(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  return path.resolve(ROOT_DIR, value);
}

export function getConfig() {
  const dataDir = normalizePath(process.env.DATA_DIR, path.join(ROOT_DIR, 'data'));
  const sqlitePath = normalizePath(process.env.SQLITE_PATH, path.join(dataDir, 'moodboard.sqlite'));
  const appOrigin = typeof process.env.APP_ORIGIN === 'string' && process.env.APP_ORIGIN.trim()
    ? process.env.APP_ORIGIN.trim().replace(/\/$/, '')
    : 'http://localhost:5173';
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieSecure = normalizeBoolean(process.env.COOKIE_SECURE, isProduction || appOrigin.startsWith('https://'));

  return {
    rootDir: ROOT_DIR,
    distDir: path.join(ROOT_DIR, 'dist'),
    dataDir,
    sqlitePath,
    uploadsDir: path.join(dataDir, 'uploads'),
    devMailDir: path.join(dataDir, 'dev-mail'),
    legacyBoardPath: path.join(dataDir, 'board.json'),
    legacyBoardsDir: path.join(dataDir, 'boards'),
    port: normalizeNumber(process.env.PORT, 3001),
    appOrigin,
    sessionSecret: typeof process.env.SESSION_SECRET === 'string' && process.env.SESSION_SECRET.trim()
      ? process.env.SESSION_SECRET.trim()
      : 'local-moodboard-session-secret',
    sessionCookieName: 'moodboard_session',
    sessionDurationMs: 1000 * 60 * 60 * 24 * 30,
    magicLinkTtlMs: normalizeNumber(process.env.MAGIC_LINK_TTL_MINUTES, 20) * 60 * 1000,
    smtp: {
      host: process.env.SMTP_HOST?.trim() || '',
      port: normalizeNumber(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER?.trim() || '',
      pass: process.env.SMTP_PASS || '',
      secure: normalizeBoolean(process.env.SMTP_SECURE, false),
      from: process.env.MAIL_FROM?.trim() || '',
    },
    mailgun: {
      apiKey: process.env.MAILGUN_API_KEY?.trim() || '',
      domain: process.env.MAILGUN_DOMAIN?.trim() || '',
      region: normalizeMailgunRegion(process.env.MAILGUN_REGION),
      from: process.env.MAIL_FROM?.trim() || '',
    },
    isProduction,
    cookieSecure,
    trustProxy: true,
  };
}

function normalizeMailgunRegion(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'eu' ? 'eu' : 'us';
}
