import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const BOARD_VERSION = 2;
const LAYOUT_IDS = ['pile', 'fan', 'grid'];
const DEFAULT_LAYOUT_ID = 'pile';

export function createStore(config) {
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const db = new Database(config.sqlitePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      redirect_path TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      board_json TEXT NOT NULL,
      share_token TEXT,
      share_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS board_assets (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT,
      original_width INTEGER NOT NULL,
      original_height INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
    CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links(expires_at);
    CREATE INDEX IF NOT EXISTS idx_boards_owner_user_id ON boards(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_boards_share_token ON boards(share_token);
    CREATE INDEX IF NOT EXISTS idx_board_assets_board_id ON board_assets(board_id);
  `);

  cleanupExpiredAuthRecords();
  importLegacyBoardsIfNeeded();

  return {
    cleanupExpiredAuthRecords,
    getSessionById,
    getUserById,
    createMagicLink,
    consumeMagicLink,
    createSession,
    deleteSession,
    listBoardsForUser,
    createBoardForUser,
    getBoardForUser,
    saveBoardForUser,
    clearBoardForUser,
    deleteBoardForUser,
    createOrEnableShareLink,
    disableShareLink,
    regenerateShareLink,
    getSharedBoardByToken,
    createAssetsForBoard,
    getAssetResponse,
    getBoardOwnership,
    getBoardById,
  };

  function inTransaction(fn) {
    db.exec('BEGIN');

    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function cleanupExpiredAuthRecords() {
    const nowValue = now();

    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowValue);
    db.prepare('DELETE FROM magic_links WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(nowValue);
  }

  function getSessionById(sessionId) {
    if (!sessionId) {
      return null;
    }

    cleanupExpiredAuthRecords();

    const sessionRow = db.prepare(`
      SELECT sessions.id, sessions.user_id, sessions.expires_at, sessions.created_at,
             users.email, users.created_at AS user_created_at, users.last_login_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
    `).get(sessionId);

    if (!sessionRow) {
      return null;
    }

    if (Date.parse(sessionRow.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionRow.id);
      return null;
    }

    return {
      id: sessionRow.id,
      expiresAt: sessionRow.expires_at,
      user: {
        id: sessionRow.user_id,
        email: sessionRow.email,
        createdAt: sessionRow.user_created_at,
        lastLoginAt: sessionRow.last_login_at,
      },
    };
  }

  function getUserById(userId) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return row ? mapUser(row) : null;
  }

  function createMagicLink(emailInput, redirectPath) {
    const email = normalizeEmail(emailInput);

    if (!email || !isValidEmail(email)) {
      throw createHttpError(400, 'Enter a valid email address to continue.');
    }

    cleanupExpiredAuthRecords();

    const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const token = createToken(32);
    const tokenHash = sha256(token);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + config.magicLinkTtlMs).toISOString();
    const magicLinkId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO magic_links (id, user_id, email, token_hash, redirect_path, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      magicLinkId,
      userRow?.id || null,
      email,
      tokenHash,
      normalizeRedirectPath(redirectPath),
      expiresAt,
      createdAt,
    );

    return {
      token,
      email,
      redirectPath: normalizeRedirectPath(redirectPath),
      expiresAt,
    };
  }

  function consumeMagicLink(token) {
    cleanupExpiredAuthRecords();

    const tokenHash = sha256(token);
    const magicLinkRow = db.prepare('SELECT * FROM magic_links WHERE token_hash = ?').get(tokenHash);

    if (!magicLinkRow) {
      throw createHttpError(400, 'That magic link is invalid or has already been used.');
    }

    if (magicLinkRow.consumed_at) {
      throw createHttpError(400, 'That magic link has already been used.');
    }

    if (Date.parse(magicLinkRow.expires_at) <= Date.now()) {
      throw createHttpError(400, 'That magic link has expired. Request a new one.');
    }

    return inTransaction(() => {
      let userRow = magicLinkRow.user_id
        ? db.prepare('SELECT * FROM users WHERE id = ?').get(magicLinkRow.user_id)
        : null;

      if (!userRow) {
        userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(magicLinkRow.email);
      }

      if (!userRow) {
        const userId = crypto.randomUUID();
        const createdAt = now();

        db.prepare(`
          INSERT INTO users (id, email, created_at, last_login_at)
          VALUES (?, ?, ?, NULL)
        `).run(userId, magicLinkRow.email, createdAt);

        userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      }

      const claimedBoardIds = claimLegacyBoards(userRow.id);
      const loginAt = now();

      db.prepare(`
        UPDATE users
        SET last_login_at = ?
        WHERE id = ?
      `).run(loginAt, userRow.id);

      db.prepare(`
        UPDATE magic_links
        SET consumed_at = ?, user_id = ?
        WHERE id = ?
      `).run(loginAt, userRow.id, magicLinkRow.id);

      const refreshedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id);

      return {
        user: mapUser(refreshedUser),
        redirectPath: normalizeRedirectPath(magicLinkRow.redirect_path),
        claimedBoardIds,
      };
    });
  }

  function createSession(userId) {
    const sessionId = createToken(24);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + config.sessionDurationMs).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, userId, expiresAt, createdAt);

    return {
      id: sessionId,
      expiresAt,
    };
  }

  function deleteSession(sessionId) {
    if (!sessionId) {
      return;
    }

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  function listBoardsForUser(userId) {
    return db.prepare(`
      SELECT boards.id, boards.name, boards.updated_at, boards.share_enabled, boards.share_token,
             COUNT(board_assets.id) AS item_count
      FROM boards
      LEFT JOIN board_assets ON board_assets.board_id = boards.id
      WHERE boards.owner_user_id = ?
      GROUP BY boards.id
      ORDER BY boards.updated_at DESC, boards.name ASC
    `).all(userId).map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      itemCount: Number(row.item_count) || 0,
      sharing: {
        enabled: Boolean(row.share_enabled),
        shareUrl: row.share_enabled && row.share_token
          ? `${config.appOrigin}/shared/${row.share_token}`
          : null,
      },
    }));
  }

  function createBoardForUser(userId) {
    const nextBoardNumber = getNextBoardNumberForUser(userId);
    const createdAt = now();
    const boardId = `board-${crypto.randomUUID()}`;
    const boardDocument = createEmptyBoardDocument(createdAt);

    db.prepare(`
      INSERT INTO boards (id, owner_user_id, name, board_json, share_token, share_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      boardId,
      userId,
      `Board ${nextBoardNumber}`,
      JSON.stringify(boardDocument),
      createdAt,
      createdAt,
    );

    return getBoardForUser(userId, boardId);
  }

  function getBoardForUser(userId, boardId) {
    const boardRow = getOwnedBoardRow(userId, boardId);
    return buildBoardPayload(boardRow, getAssetRowsForBoard(boardId), null);
  }

  function getBoardById(boardId) {
    const boardRow = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    return boardRow ? buildBoardPayload(boardRow, getAssetRowsForBoard(boardId), null) : null;
  }

  function getBoardOwnership(boardId) {
    const row = db.prepare('SELECT id, owner_user_id FROM boards WHERE id = ?').get(boardId);
    return row || null;
  }

  function saveBoardForUser(userId, boardId, boardPayload) {
    const boardRow = getOwnedBoardRow(userId, boardId);
    const existingAssets = getAssetRowsForBoard(boardId);
    const desiredAssets = normalizeIncomingAssets(boardPayload?.assets);
    const desiredAssetIds = new Set(desiredAssets.map((asset) => asset.id));
    const unknownAssetIds = desiredAssets
      .map((asset) => asset.id)
      .filter((assetId) => !existingAssets.some((asset) => asset.id === assetId));

    if (unknownAssetIds.length > 0) {
      throw createHttpError(400, 'One or more images are no longer available on this board.');
    }

    const nextUpdatedAt = now();
    const nextDocument = normalizeBoardDocument(boardPayload, nextUpdatedAt, desiredAssetIds);

    inTransaction(() => {
      db.prepare(`
        UPDATE boards
        SET board_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(nextDocument), nextUpdatedAt, boardId);

      const removedAssets = existingAssets.filter((asset) => !desiredAssetIds.has(asset.id));

      for (const asset of removedAssets) {
        db.prepare('DELETE FROM board_assets WHERE id = ?').run(asset.id);
      }

      deleteAssetFiles(removedAssets);
    });

    return getBoardForUser(userId, boardId);
  }

  function clearBoardForUser(userId, boardId) {
    const boardRow = getOwnedBoardRow(userId, boardId);
    const existingAssets = getAssetRowsForBoard(boardId);
    const nextUpdatedAt = now();

    inTransaction(() => {
      db.prepare('DELETE FROM board_assets WHERE board_id = ?').run(boardId);
      db.prepare(`
        UPDATE boards
        SET board_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(createEmptyBoardDocument(nextUpdatedAt)), nextUpdatedAt, boardId);
      deleteAssetFiles(existingAssets);
    });

    return getBoardForUser(userId, boardId);
  }

  function deleteBoardForUser(userId, boardId, currentBoardId) {
    const boardRow = getOwnedBoardRow(userId, boardId);
    const boardAssets = getAssetRowsForBoard(boardId);

    inTransaction(() => {
      db.prepare('DELETE FROM board_assets WHERE board_id = ?').run(boardId);
      db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
      deleteAssetFiles(boardAssets);
    });

    const remainingBoards = listBoardsForUser(userId);
    let responseBoard = null;

    if (currentBoardId === boardId || remainingBoards.length === 0) {
      responseBoard = createBoardForUser(userId);
    } else {
      const fallbackBoardId = remainingBoards.find((board) => board.id === currentBoardId)?.id
        || remainingBoards[0].id;
      responseBoard = getBoardForUser(userId, fallbackBoardId);
    }

    return {
      board: responseBoard,
      boards: listBoardsForUser(userId),
      deletedBoardId: boardId,
    };
  }

  function createOrEnableShareLink(userId, boardId) {
    const boardRow = getOwnedBoardRow(userId, boardId);
    const shareToken = boardRow.share_token || createShareToken();

    db.prepare(`
      UPDATE boards
      SET share_token = ?, share_enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(shareToken, now(), boardId);

    return getBoardForUser(userId, boardId);
  }

  function disableShareLink(userId, boardId) {
    getOwnedBoardRow(userId, boardId);

    db.prepare(`
      UPDATE boards
      SET share_enabled = 0, updated_at = ?
      WHERE id = ?
    `).run(now(), boardId);

    return getBoardForUser(userId, boardId);
  }

  function regenerateShareLink(userId, boardId) {
    getOwnedBoardRow(userId, boardId);

    db.prepare(`
      UPDATE boards
      SET share_token = ?, share_enabled = 1, updated_at = ?
      WHERE id = ?
    `).run(createShareToken(), now(), boardId);

    return getBoardForUser(userId, boardId);
  }

  function getSharedBoardByToken(shareToken) {
    const boardRow = db.prepare(`
      SELECT *
      FROM boards
      WHERE share_enabled = 1 AND share_token = ?
    `).get(shareToken);

    if (!boardRow) {
      throw createHttpError(404, 'That shared board could not be found.');
    }

    return buildBoardPayload(boardRow, getAssetRowsForBoard(boardRow.id), shareToken);
  }

  function createAssetsForBoard(userId, boardId, files, manifest) {
    getOwnedBoardRow(userId, boardId);
    const createdAt = now();
    const insertedAssets = [];

    inTransaction(() => {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const metadata = normalizeManifestEntry(manifest[index]);
        const assetId = crypto.randomUUID();
        const storagePath = path.join(boardId, file.filename).replaceAll(path.sep, '/');

        db.prepare(`
          INSERT INTO board_assets (
            id, board_id, file_name, storage_path, mime_type, original_width, original_height, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          assetId,
          boardId,
          file.originalname,
          storagePath,
          file.mimetype || null,
          metadata.originalWidth,
          metadata.originalHeight,
          createdAt,
        );

        insertedAssets.push({
          id: assetId,
          fileName: file.originalname,
          src: buildAssetUrl(assetId, null),
          originalWidth: metadata.originalWidth,
          originalHeight: metadata.originalHeight,
        });
      }
    });

    return insertedAssets;
  }

  function getAssetResponse(assetId, options = {}) {
    const assetRow = db.prepare(`
      SELECT board_assets.*, boards.owner_user_id, boards.share_token, boards.share_enabled
      FROM board_assets
      JOIN boards ON boards.id = board_assets.board_id
      WHERE board_assets.id = ?
    `).get(assetId);

    if (!assetRow) {
      throw createHttpError(404, 'That image could not be found.');
    }

    const isOwner = options.userId && assetRow.owner_user_id === options.userId;
    const hasShareAccess = options.shareToken
      && Boolean(assetRow.share_enabled)
      && assetRow.share_token === options.shareToken;

    if (!isOwner && !hasShareAccess) {
      throw createHttpError(403, 'You do not have permission to view that image.');
    }

    return {
      filePath: path.join(config.uploadsDir, assetRow.storage_path),
      mimeType: assetRow.mime_type,
      fileName: assetRow.file_name,
    };
  }

  function importLegacyBoardsIfNeeded() {
    const existingBoardCount = db.prepare('SELECT COUNT(*) AS count FROM boards').get().count;

    if (Number(existingBoardCount) > 0) {
      return;
    }

    const legacyBoardFiles = getLegacyBoardFiles(config.legacyBoardsDir, config.legacyBoardPath);

    if (!legacyBoardFiles.length) {
      return;
    }

    inTransaction(() => {
      for (const filePath of legacyBoardFiles) {
        const raw = safeReadJson(filePath);

        if (!raw) {
          continue;
        }

        const normalizedBoard = normalizeLegacyBoard(raw, path.basename(filePath, '.json'));
        const createdAt = normalizeTimestamp(raw.updatedAt || raw.createdAt || now());

        db.prepare(`
          INSERT INTO boards (id, owner_user_id, name, board_json, share_token, share_enabled, created_at, updated_at)
          VALUES (?, NULL, ?, ?, NULL, 0, ?, ?)
        `).run(
          normalizedBoard.id,
          normalizedBoard.name,
          JSON.stringify({
            version: BOARD_VERSION,
            activeLayout: normalizedBoard.activeLayout,
            layouts: normalizedBoard.layouts,
          }),
          createdAt,
          normalizedBoard.updatedAt,
        );

        const insertAsset = db.prepare(`
          INSERT INTO board_assets (
            id, board_id, file_name, storage_path, mime_type, original_width, original_height, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const asset of normalizedBoard.assets) {
          insertAsset.run(
            asset.id,
            normalizedBoard.id,
            asset.fileName,
            normalizeLegacyStoragePath(asset.src, normalizedBoard.id),
            null,
            asset.originalWidth,
            asset.originalHeight,
            createdAt,
          );
        }
      }
    });
  }

  function claimLegacyBoards(userId) {
    const unclaimedRows = db.prepare('SELECT id FROM boards WHERE owner_user_id IS NULL').all();

    if (!unclaimedRows.length) {
      return [];
    }

    db.prepare('UPDATE boards SET owner_user_id = ? WHERE owner_user_id IS NULL').run(userId);
    return unclaimedRows.map((row) => row.id);
  }

  function getOwnedBoardRow(userId, boardId) {
    const boardRow = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);

    if (!boardRow) {
      throw createHttpError(404, 'That board could not be found.');
    }

    if (boardRow.owner_user_id !== userId) {
      throw createHttpError(403, 'You do not have permission to access that board.');
    }

    return boardRow;
  }

  function getAssetRowsForBoard(boardId) {
    return db.prepare(`
      SELECT *
      FROM board_assets
      WHERE board_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(boardId);
  }

  function buildBoardPayload(boardRow, assetRows, shareToken) {
    const boardDocument = parseBoardJson(boardRow.board_json, boardRow.updated_at);
    const assets = assetRows.map((asset) => ({
      id: asset.id,
      fileName: asset.file_name,
      src: buildAssetUrl(asset.id, shareToken),
      originalWidth: Number(asset.original_width) || 240,
      originalHeight: Number(asset.original_height) || 180,
    }));

    return {
      id: boardRow.id,
      name: boardRow.name,
      version: BOARD_VERSION,
      activeLayout: boardDocument.activeLayout,
      updatedAt: boardRow.updated_at,
      assets,
      layouts: boardDocument.layouts,
      sharing: {
        enabled: Boolean(boardRow.share_enabled),
        shareUrl: boardRow.share_enabled && boardRow.share_token
          ? `${config.appOrigin}/shared/${boardRow.share_token}`
          : null,
      },
    };
  }

  function buildAssetUrl(assetId, shareToken) {
    if (shareToken) {
      return `/api/assets/${assetId}?share=${encodeURIComponent(shareToken)}`;
    }

    return `/api/assets/${assetId}`;
  }

  function getNextBoardNumberForUser(userId) {
    const names = db.prepare('SELECT name FROM boards WHERE owner_user_id = ?').all(userId);
    const highest = names.reduce((max, row) => {
      const match = /^Board\s+(\d+)$/i.exec(row.name || '');
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);

    return highest + 1;
  }

  function deleteAssetFiles(assetRows) {
    for (const assetRow of assetRows) {
      const absolutePath = path.join(config.uploadsDir, assetRow.storage_path);

      try {
        fs.unlinkSync(absolutePath);
      } catch {
        // Ignore missing files during cleanup.
      }

      tryRemoveEmptyParent(path.dirname(absolutePath));
    }
  }

  function tryRemoveEmptyParent(directoryPath) {
    if (directoryPath === config.uploadsDir) {
      return;
    }

    try {
      const entries = fs.readdirSync(directoryPath);

      if (entries.length === 0) {
        fs.rmdirSync(directoryPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function parseBoardJson(value, updatedAt) {
  const parsed = safeParseJson(value);
  return normalizeBoardDocument(parsed, updatedAt);
}

function normalizeBoardDocument(source, updatedAt = now(), validAssetIds = null) {
  const safeSource = isPlainObject(source) ? source : {};
  const layouts = {};

  for (const layoutId of LAYOUT_IDS) {
    layouts[layoutId] = normalizeLayoutState(
      safeSource.layouts?.[layoutId],
      normalizeTimestamp(updatedAt),
      validAssetIds,
    );
  }

  return {
    version: BOARD_VERSION,
    activeLayout: LAYOUT_IDS.includes(safeSource.activeLayout) ? safeSource.activeLayout : DEFAULT_LAYOUT_ID,
    layouts,
  };
}

function normalizeLayoutState(layout, updatedAt, validAssetIds) {
  const source = isPlainObject(layout) ? layout : {};

  return {
    updatedAt: normalizeTimestamp(source.updatedAt || updatedAt),
    items: Array.isArray(source.items)
      ? source.items
        .map((item) => normalizeLayoutItem(item))
        .filter((item) => !validAssetIds || validAssetIds.has(item.id))
      : [],
  };
}

function normalizeLayoutItem(item) {
  const source = isPlainObject(item) ? item : {};

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : crypto.randomUUID(),
    x: normalizeNumber(source.x, 0),
    y: normalizeNumber(source.y, 0),
    width: normalizePositiveNumber(source.width, 180),
    height: normalizePositiveNumber(source.height, 180),
    rotation: normalizeNumber(source.rotation, 0),
    zIndex: normalizeNumber(source.zIndex, 1),
  };
}

function createEmptyBoardDocument(updatedAt = now()) {
  return {
    version: BOARD_VERSION,
    activeLayout: DEFAULT_LAYOUT_ID,
    layouts: Object.fromEntries(
      LAYOUT_IDS.map((layoutId) => [
        layoutId,
        { updatedAt: normalizeTimestamp(updatedAt), items: [] },
      ]),
    ),
  };
}

function normalizeIncomingAssets(assets) {
  const seen = new Set();

  return Array.isArray(assets)
    ? assets
      .map((asset) => ({
        id: typeof asset?.id === 'string' && asset.id.trim() ? asset.id : '',
      }))
      .filter((asset) => asset.id && !seen.has(asset.id) && seen.add(asset.id))
    : [];
}

function normalizeManifestEntry(entry) {
  return {
    originalWidth: normalizePositiveNumber(entry?.originalWidth, 240),
    originalHeight: normalizePositiveNumber(entry?.originalHeight, 180),
  };
}

function normalizeLegacyBoard(rawBoard, fallbackId) {
  const layouts = normalizeBoardDocument(rawBoard, rawBoard?.updatedAt || now()).layouts;
  const activeLayout = LAYOUT_IDS.includes(rawBoard?.activeLayout)
    ? rawBoard.activeLayout
    : (LAYOUT_IDS.includes(rawBoard?.arrangeMode) ? rawBoard.arrangeMode : DEFAULT_LAYOUT_ID);
  const assets = Array.isArray(rawBoard?.assets)
    ? rawBoard.assets.map(normalizeLegacyAsset).filter(Boolean)
    : (Array.isArray(rawBoard?.items) ? rawBoard.items.map(normalizeLegacyAsset).filter(Boolean) : []);

  return {
    id: typeof rawBoard?.id === 'string' && rawBoard.id.trim() ? rawBoard.id : fallbackId,
    name: typeof rawBoard?.name === 'string' && rawBoard.name.trim() ? rawBoard.name : 'Board 1',
    updatedAt: normalizeTimestamp(rawBoard?.updatedAt || now()),
    activeLayout,
    layouts,
    assets,
  };
}

function normalizeLegacyAsset(asset) {
  if (!isPlainObject(asset)) {
    return null;
  }

  return {
    id: typeof asset.id === 'string' && asset.id.trim() ? asset.id : crypto.randomUUID(),
    fileName: typeof asset.fileName === 'string' ? asset.fileName : 'Untitled image',
    src: typeof asset.src === 'string' ? asset.src : '',
    originalWidth: normalizePositiveNumber(asset.originalWidth, 240),
    originalHeight: normalizePositiveNumber(asset.originalHeight, 180),
  };
}

function normalizeLegacyStoragePath(src, boardId) {
  if (typeof src === 'string' && src.startsWith('/uploads/')) {
    return src.replace(/^\/uploads\//, '');
  }

  return `${boardId}/${path.basename(src || `${crypto.randomUUID()}.bin`)}`;
}

function getLegacyBoardFiles(legacyBoardsDir, legacyBoardPath) {
  if (fs.existsSync(legacyBoardsDir)) {
    return fs.readdirSync(legacyBoardsDir)
      .filter((name) => name.endsWith('.json') && name !== 'index.json' && !name.startsWith('index.corrupt-'))
      .map((name) => path.join(legacyBoardsDir, name));
  }

  if (legacyBoardPath && fs.existsSync(legacyBoardPath)) {
    return [legacyBoardPath];
  }

  return [];
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeRedirectPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    return '/';
  }

  if (value.startsWith('//')) {
    return '/';
  }

  return value;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function mapUser(userRow) {
  return {
    id: userRow.id,
    email: userRow.email,
    createdAt: userRow.created_at,
    lastLoginAt: userRow.last_login_at,
  };
}

function createToken(size) {
  return crypto.randomBytes(size).toString('base64url');
}

function createShareToken() {
  return createToken(18);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function now() {
  return new Date().toISOString();
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTimestamp(value) {
  return typeof value === 'string' && value ? value : now();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
