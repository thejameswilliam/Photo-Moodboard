import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
  validateUploadCandidate,
} from '../shared/uploadValidation.js';
import {
  createExpiredSessionCookie,
  createSessionCookie,
  parseCookies,
  signCookieValue,
  unsignCookieValue,
} from './lib/auth.js';
import { getConfig } from './lib/config.js';
import { createMailer } from './lib/mailer.js';
import { createStore } from './lib/store.js';

const __filename = fileURLToPath(import.meta.url);
const CONFIG = getConfig();
const STORE = createStore(CONFIG);
const MAILER = createMailer(CONFIG);

export async function createApp() {
  const app = express();
  const upload = createUploadMiddleware(CONFIG);

  app.set('trust proxy', CONFIG.trustProxy);
  app.use(express.json({ limit: '6mb' }));
  app.use(attachSession);

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/session', (request, response) => {
    response.json({
      user: request.authSession?.user || null,
    });
  });

  app.post('/api/auth/magic-link', asyncHandler(async (request, response) => {
    const email = typeof request.body?.email === 'string' ? request.body.email : '';
    const redirectPath = typeof request.body?.redirectPath === 'string' ? request.body.redirectPath : '/';
    const magicLink = STORE.createMagicLink(email, redirectPath);
    const verifyUrl = `${CONFIG.appOrigin}/auth/verify?token=${encodeURIComponent(magicLink.token)}`;
    const result = await MAILER.sendMagicLinkEmail({
      email: magicLink.email,
      magicLinkUrl: verifyUrl,
      expiresAt: magicLink.expiresAt,
    });

    response.status(201).json({
      ok: true,
      previewUrl: result.previewUrl,
      expiresAt: magicLink.expiresAt,
    });
  }));

  app.get('/auth/verify', asyncHandler(async (request, response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : '';

    try {
      const result = STORE.consumeMagicLink(token);
      const session = STORE.createSession(result.user.id);
      response.append('Set-Cookie', createSessionCookie(
        CONFIG.sessionCookieName,
        signCookieValue(session.id, CONFIG.sessionSecret),
        CONFIG.sessionDurationMs,
        CONFIG.cookieSecure,
      ));

      const targetPath = pickLoginRedirectPath(result.redirectPath, result.user.id);
      response.redirect(303, targetPath);
    } catch (error) {
      const message = error?.statusCode && error.statusCode < 500
        ? error.message
        : 'We could not complete that sign-in. Please request a new magic link.';

      response.redirect(303, withQuery('/', 'authError', message));
    }
  }));

  app.post('/api/auth/logout', asyncHandler(async (request, response) => {
    if (request.authSession?.id) {
      STORE.deleteSession(request.authSession.id);
    }

    response.append('Set-Cookie', createExpiredSessionCookie(
      CONFIG.sessionCookieName,
      CONFIG.cookieSecure,
    ));
    response.json({ ok: true });
  }));

  app.get('/api/boards', requireUser, asyncHandler(async (request, response) => {
    const boards = ensureBoardsForUser(request.authSession.user.id);
    response.json({ boards });
  }));

  app.post('/api/boards', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.createBoardForUser(request.authSession.user.id);
    const boards = STORE.listBoardsForUser(request.authSession.user.id);

    response.status(201).json({ board, boards });
  }));

  app.get('/api/boards/:boardId', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.getBoardForUser(request.authSession.user.id, request.params.boardId);
    response.json({ board, warning: null });
  }));

  app.put('/api/boards/:boardId', requireUser, asyncHandler(async (request, response) => {
    if (!isPlainObject(request.body)) {
      response.status(400).json({ message: 'Board payload must be a JSON object.' });
      return;
    }

    const board = STORE.saveBoardForUser(
      request.authSession.user.id,
      request.params.boardId,
      request.body,
    );

    response.json({ board });
  }));

  app.post('/api/boards/:boardId/uploads', requireUser, asyncHandler(async (request, response, next) => {
    STORE.getBoardForUser(request.authSession.user.id, request.params.boardId);

    upload.array('images')(request, response, async (uploadError) => {
      if (uploadError) {
        cleanupUploadedFiles(Array.isArray(request.files) ? request.files : []);
        next(uploadError);
        return;
      }

      const files = Array.isArray(request.files) ? request.files : [];

      if (files.length === 0) {
        cleanupUploadedFiles(files);
        response.status(400).json({ message: 'Drop one or more image files to continue.' });
        return;
      }

      try {
        const manifest = parseManifest(request.body?.manifest, files.length);
        const assets = STORE.createAssetsForBoard(
          request.authSession.user.id,
          request.params.boardId,
          files,
          manifest,
        );

        response.status(201).json({ assets });
      } catch (error) {
        cleanupUploadedFiles(files);
        next(error);
      }
    });
  }));

  app.post('/api/boards/:boardId/clear', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.clearBoardForUser(request.authSession.user.id, request.params.boardId);
    response.json({ board });
  }));

  app.delete('/api/boards/:boardId', requireUser, asyncHandler(async (request, response) => {
    const currentBoardId = typeof request.query.currentBoardId === 'string' && request.query.currentBoardId.trim()
      ? request.query.currentBoardId
      : request.params.boardId;

    const result = STORE.deleteBoardForUser(
      request.authSession.user.id,
      request.params.boardId,
      currentBoardId,
    );

    response.json(result);
  }));

  app.post('/api/boards/:boardId/share', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.createOrEnableShareLink(request.authSession.user.id, request.params.boardId);
    response.json({ board });
  }));

  app.delete('/api/boards/:boardId/share', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.disableShareLink(request.authSession.user.id, request.params.boardId);
    response.json({ board });
  }));

  app.post('/api/boards/:boardId/share/regenerate', requireUser, asyncHandler(async (request, response) => {
    const board = STORE.regenerateShareLink(request.authSession.user.id, request.params.boardId);
    response.json({ board });
  }));

  app.get('/api/shared/:shareToken', asyncHandler(async (request, response) => {
    const board = STORE.getSharedBoardByToken(request.params.shareToken);
    response.json({ board });
  }));

  app.get('/api/assets/:assetId', asyncHandler(async (request, response) => {
    const shareToken = typeof request.query.share === 'string' ? request.query.share : null;
    const asset = STORE.getAssetResponse(request.params.assetId, {
      userId: request.authSession?.user?.id || null,
      shareToken,
    });

    if (asset.mimeType) {
      response.type(asset.mimeType);
    }

    response.sendFile(asset.filePath);
  }));

  if (fs.existsSync(CONFIG.distDir)) {
    app.use(express.static(CONFIG.distDir));
    app.get(/^(?!\/api|\/auth|\/healthz).*/, (_request, response) => {
      response.sendFile(path.join(CONFIG.distDir, 'index.html'));
    });
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        response.status(400).json({ message: `Images must be ${MAX_UPLOAD_FILE_SIZE_MB} MB or smaller.` });
        return;
      }

      response.status(400).json({ message: error.message });
      return;
    }

    const statusCode = error?.statusCode || 500;
    const message = statusCode >= 500
      ? 'Something went wrong while updating Moodboard.'
      : error.message;

    response.status(statusCode).json({ message });
  });

  return app;
}

function attachSession(request, response, next) {
  const cookies = parseCookies(request.headers.cookie);
  const signedValue = cookies[CONFIG.sessionCookieName];

  if (!signedValue) {
    request.authSession = null;
    next();
    return;
  }

  const sessionId = unsignCookieValue(signedValue, CONFIG.sessionSecret);

  if (!sessionId) {
    response.append('Set-Cookie', createExpiredSessionCookie(CONFIG.sessionCookieName, CONFIG.cookieSecure));
    request.authSession = null;
    next();
    return;
  }

  const session = STORE.getSessionById(sessionId);

  if (!session) {
    response.append('Set-Cookie', createExpiredSessionCookie(CONFIG.sessionCookieName, CONFIG.cookieSecure));
  }

  request.authSession = session || null;
  next();
}

function requireUser(request, response, next) {
  if (!request.authSession?.user) {
    response.status(401).json({ message: 'Sign in to continue.' });
    return;
  }

  next();
}

function ensureBoardsForUser(userId) {
  const boards = STORE.listBoardsForUser(userId);

  if (boards.length > 0) {
    return boards;
  }

  STORE.createBoardForUser(userId);
  return STORE.listBoardsForUser(userId);
}

function pickLoginRedirectPath(requestedPath, userId) {
  if (isBoardPath(requestedPath) || isSharedPath(requestedPath)) {
    return requestedPath;
  }

  const boards = ensureBoardsForUser(userId);
  return boards[0] ? `/boards/${boards[0].id}` : '/';
}

function isBoardPath(value) {
  return typeof value === 'string' && /^\/boards\/[^/?#]+$/.test(value);
}

function isSharedPath(value) {
  return typeof value === 'string' && /^\/shared\/[^/?#]+$/.test(value);
}

function withQuery(basePath, key, value) {
  const url = new URL(basePath, CONFIG.appOrigin);
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function parseManifest(value, expectedLength) {
  if (typeof value !== 'string' || !value.trim()) {
    return Array.from({ length: expectedLength }, () => ({}));
  }

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    const error = new Error('Uploaded image metadata could not be read.');
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(parsed)) {
    const error = new Error('Uploaded image metadata must be an array.');
    error.statusCode = 400;
    throw error;
  }

  return Array.from({ length: expectedLength }, (_unused, index) => (
    isPlainObject(parsed[index]) ? parsed[index] : {}
  ));
}

function createUploadMiddleware(config) {
  return multer({
    storage: multer.diskStorage({
      destination: (request, _file, callback) => {
        try {
          const destination = path.join(config.uploadsDir, request.params.boardId);
          fs.mkdirSync(destination, { recursive: true });
          callback(null, destination);
        } catch (error) {
          callback(error);
        }
      },
      filename: (_request, file, callback) => {
        callback(null, createUploadName(file.originalname));
      },
    }),
    limits: {
      files: 40,
      fileSize: MAX_UPLOAD_FILE_SIZE,
    },
    fileFilter: (_request, file, callback) => {
      const validation = validateUploadCandidate({
        fileName: file.originalname,
        mimeType: file.mimetype,
      });

      if (validation.ok) {
        callback(null, true);
        return;
      }

      const error = new Error(validation.message);
      error.statusCode = 400;
      callback(error);
    },
  });
}

function cleanupUploadedFiles(files) {
  for (const file of files) {
    if (!file?.path) {
      continue;
    }

    try {
      fs.unlinkSync(file.path);
    } catch {
      // Ignore file cleanup errors after failed uploads.
    }
  }
}

function createUploadName(originalName) {
  const extension = path.extname(originalName || '').toLowerCase();
  const safeExtension = extension && extension.length <= 12 ? extension : '';
  return `${Date.now()}-${crypto.randomUUID()}${safeExtension}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asyncHandler(fn) {
  return (request, response, next) => {
    Promise.resolve(fn(request, response, next)).catch(next);
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const app = await createApp();

  app.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`Moodboard server listening on http://127.0.0.1:${CONFIG.port}`);
  });
}
