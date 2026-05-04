import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LEGACY_BOARD_PATH = path.join(DATA_DIR, 'board.json');
const BOARDS_DIR = path.join(DATA_DIR, 'boards');
const BOARDS_INDEX_PATH = path.join(BOARDS_DIR, 'index.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PORT = Number(process.env.PORT || 3001);
const LAYOUT_IDS = ['pile', 'fan', 'grid'];
const ALLOWED_LAYOUT_IDS = new Set(LAYOUT_IDS);
const DEFAULT_LAYOUT_ID = 'pile';
const BOARD_VERSION = 2;
const INDEX_VERSION = 1;

export async function createApp() {
  const app = express();

  await ensureWorkspace();

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (request, _file, callback) => {
        try {
          await ensureWorkspace();
          await assertBoardExists(request.params.boardId);

          const destination = path.join(UPLOADS_DIR, request.params.boardId);
          await fs.mkdir(destination, { recursive: true });
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
      fileSize: 25 * 1024 * 1024,
    },
    fileFilter: (_request, file, callback) => {
      if (file.mimetype.startsWith('image/')) {
        callback(null, true);
        return;
      }

      callback(new Error('Only image files can be added to the mood board.'));
    },
  });

  app.use(express.json({ limit: '4mb' }));
  app.use('/uploads', express.static(UPLOADS_DIR));

  app.get('/api/boards', async (_request, response, next) => {
    try {
      const result = await readBoardsIndex();
      response.json({ boards: result.index.boards });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/boards', async (_request, response, next) => {
    try {
      const indexResult = await readBoardsIndex();
      const created = createBoardRecord(indexResult.index.nextBoardNumber);
      const nextIndex = addBoardToIndex(indexResult.index, created.board);

      await writeBoardFile(created.board);
      await writeBoardsIndex(nextIndex);

      response.status(201).json({
        board: created.board,
        boards: nextIndex.boards,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/boards/:boardId', async (request, response, next) => {
    try {
      const result = await readBoardById(request.params.boardId);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/boards/:boardId/uploads', async (request, response, next) => {
    try {
      await assertBoardExists(request.params.boardId);
    } catch (error) {
      next(error);
      return;
    }

    upload.array('images')(request, response, async (uploadError) => {
      if (uploadError) {
        next(uploadError);
        return;
      }

      try {
        const files = request.files || [];

        if (!Array.isArray(files) || files.length === 0) {
          response.status(400).json({ message: 'Drop one or more image files to continue.' });
          return;
        }

        const manifest = parseManifest(request.body.manifest);
        const assets = files.map((file, index) => createUploadedAsset(file, manifest[index], request.params.boardId));

        response.status(201).json({ assets });
      } catch (error) {
        next(error);
      }
    });
  });

  app.put('/api/boards/:boardId', async (request, response, next) => {
    try {
      if (!isPlainObject(request.body)) {
        response.status(400).json({ message: 'Board payload must be a JSON object.' });
        return;
      }

      const currentResult = await readBoardById(request.params.boardId);
      const nextBoard = normalizeBoard(request.body, {
        id: currentResult.board.id,
        name: currentResult.board.name,
        version: currentResult.board.version,
      }, { preserveLegacy: false });

      nextBoard.id = currentResult.board.id;
      nextBoard.name = currentResult.board.name;
      nextBoard.updatedAt = new Date().toISOString();

      await cleanupRemovedUploads(currentResult.board.assets, nextBoard.assets);
      await saveBoardRecord(nextBoard);

      response.json({ board: nextBoard });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/boards/:boardId/clear', async (request, response, next) => {
    try {
      const currentResult = await readBoardById(request.params.boardId);
      const nextBoard = {
        ...currentResult.board,
        activeLayout: DEFAULT_LAYOUT_ID,
        assets: [],
        layouts: createEmptyLayouts(),
        updatedAt: new Date().toISOString(),
      };

      await cleanupRemovedUploads(currentResult.board.assets, []);
      await saveBoardRecord(nextBoard);

      response.json({ board: nextBoard });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/boards/:boardId', async (request, response, next) => {
    try {
      const targetBoardId = request.params.boardId;
      const currentBoardId = typeof request.query.currentBoardId === 'string' && request.query.currentBoardId.trim()
        ? request.query.currentBoardId
        : targetBoardId;
      const indexResult = await readBoardsIndex();
      const targetSummary = findBoardSummary(indexResult.index, targetBoardId);

      if (!targetSummary) {
        response.status(404).json({ message: 'That board could not be found.' });
        return;
      }

      const targetResult = await readBoardFromSummary(targetSummary);
      await cleanupRemovedUploads(targetResult.board.assets, []);
      await fs.unlink(getBoardFilePath(targetBoardId)).catch(() => {});
      await removeUploadDirectory(targetBoardId);

      let nextIndex = {
        ...indexResult.index,
        boards: sortBoardSummaries(indexResult.index.boards.filter((board) => board.id !== targetBoardId)),
      };
      let responseBoard = null;

      if (currentBoardId === targetBoardId || nextIndex.boards.length === 0) {
        const created = createBoardRecord(nextIndex.nextBoardNumber);
        nextIndex = addBoardToIndex(nextIndex, created.board);
        await writeBoardFile(created.board);
        responseBoard = created.board;
      } else {
        const activeSummary = findBoardSummary(nextIndex, currentBoardId) || nextIndex.boards[0];
        const activeResult = await readBoardFromSummary(activeSummary);
        responseBoard = activeResult.board;
      }

      await writeBoardsIndex(nextIndex);

      response.json({
        board: responseBoard,
        boards: nextIndex.boards,
        deletedBoardId: targetBoardId,
      });
    } catch (error) {
      next(error);
    }
  });

  if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get(/^(?!\/api|\/uploads).*/, (_request, response) => {
      response.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      response.status(400).json({ message: error.message });
      return;
    }

    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500
      ? 'Something went wrong while updating the mood board.'
      : error.message;

    response.status(statusCode).json({ message });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const app = await createApp();

  app.listen(PORT, () => {
    console.log(`Moodboard server listening on http://localhost:${PORT}`);
  });
}

async function ensureWorkspace() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(BOARDS_DIR, { recursive: true });

  if (existsSync(BOARDS_INDEX_PATH)) {
    return;
  }

  await initializeWorkspace();
}

async function initializeWorkspace() {
  if (existsSync(LEGACY_BOARD_PATH)) {
    const legacyBoard = await readLegacyBoard();
    const migratedBoard = normalizeBoard(legacyBoard, {
      id: typeof legacyBoard?.id === 'string' && legacyBoard.id.trim() ? legacyBoard.id : createBoardId(),
      name: 'Board 1',
      version: 1,
    }, { preserveLegacy: true });

    migratedBoard.name = 'Board 1';

    const index = createBoardsIndex([createBoardSummary(migratedBoard)], 2);

    await writeBoardFile(migratedBoard);
    await writeBoardsIndex(index);
    return;
  }

  const created = createBoardRecord(1);
  const index = createBoardsIndex([createBoardSummary(created.board)], 2);

  await writeBoardFile(created.board);
  await writeBoardsIndex(index);
}

async function readBoardsIndex() {
  try {
    const raw = await fs.readFile(BOARDS_INDEX_PATH, 'utf8');
    return {
      index: normalizeBoardsIndex(JSON.parse(raw)),
      warning: null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      await ensureWorkspace();
      return readBoardsIndex();
    }

    if (error.name === 'SyntaxError') {
      return recoverBoardsIndex();
    }

    throw error;
  }
}

async function recoverBoardsIndex() {
  const backupName = `index.corrupt-${Date.now()}.json`;
  const backupPath = path.join(BOARDS_DIR, backupName);

  await fs.rename(BOARDS_INDEX_PATH, backupPath).catch(() => {});

  const rebuilt = await rebuildBoardsIndex();
  await writeBoardsIndex(rebuilt);

  return {
    index: rebuilt,
    warning: `The boards index was unreadable, so it was rebuilt. Backup: ${backupName}.`,
  };
}

async function rebuildBoardsIndex() {
  const entries = await fs.readdir(BOARDS_DIR, { withFileTypes: true }).catch(() => []);
  const boards = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json' || entry.name.startsWith('index.corrupt-')) {
      continue;
    }

    const filePath = path.join(BOARDS_DIR, entry.name);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const board = normalizeBoard(JSON.parse(raw), {
        id: path.basename(entry.name, '.json'),
        name: null,
        version: 1,
      }, { preserveLegacy: true });

      if (!board.name) {
        board.name = `Board ${boards.length + 1}`;
      }

      boards.push(createBoardSummary(board));
    } catch {
      continue;
    }
  }

  if (boards.length) {
    return createBoardsIndex(sortBoardSummaries(boards), getNextBoardNumber(boards));
  }

  if (existsSync(LEGACY_BOARD_PATH)) {
    const legacyBoard = await readLegacyBoard();
    const migratedBoard = normalizeBoard(legacyBoard, {
      id: typeof legacyBoard?.id === 'string' && legacyBoard.id.trim() ? legacyBoard.id : createBoardId(),
      name: 'Board 1',
      version: 1,
    }, { preserveLegacy: true });

    migratedBoard.name = 'Board 1';
    await writeBoardFile(migratedBoard);

    return createBoardsIndex([createBoardSummary(migratedBoard)], 2);
  }

  const created = createBoardRecord(1);
  await writeBoardFile(created.board);

  return createBoardsIndex([createBoardSummary(created.board)], 2);
}

async function readBoardById(boardId) {
  const indexResult = await readBoardsIndex();
  const summary = findBoardSummary(indexResult.index, boardId);

  if (!summary) {
    const error = new Error('That board could not be found.');
    error.statusCode = 404;
    throw error;
  }

  return readBoardFromSummary(summary);
}

async function readBoardFromSummary(summary) {
  const boardPath = getBoardFilePath(summary.id);

  try {
    const raw = await fs.readFile(boardPath, 'utf8');
    const board = normalizeBoard(JSON.parse(raw), {
      id: summary.id,
      name: summary.name,
      version: summary.version || BOARD_VERSION,
    }, { preserveLegacy: true });

    board.id = summary.id;
    board.name = summary.name;

    return {
      board,
      warning: null,
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') {
      if (error.name === 'SyntaxError') {
        const backupName = `${summary.id}.corrupt-${Date.now()}.json`;
        await fs.rename(boardPath, path.join(BOARDS_DIR, backupName)).catch(() => {});
      }

      const recoveredBoard = createBoard({
        id: summary.id,
        name: summary.name,
        updatedAt: new Date().toISOString(),
      });

      await saveBoardRecord(recoveredBoard);

      return {
        board: recoveredBoard,
        warning: 'This board file could not be read, so a fresh board was created in its place.',
      };
    }

    throw error;
  }
}

async function saveBoardRecord(board) {
  const normalizedBoard = normalizeBoard(board, {
    id: board.id,
    name: board.name,
    version: BOARD_VERSION,
  }, { preserveLegacy: false });
  const indexResult = await readBoardsIndex();
  const nextIndex = upsertBoardSummary(indexResult.index, normalizedBoard);

  await writeBoardFile(normalizedBoard);
  await writeBoardsIndex(nextIndex);

  return nextIndex;
}

async function writeBoardsIndex(index) {
  await fs.mkdir(BOARDS_DIR, { recursive: true });
  await fs.writeFile(BOARDS_INDEX_PATH, JSON.stringify(normalizeBoardsIndex(index), null, 2));
}

async function writeBoardFile(board) {
  await fs.mkdir(BOARDS_DIR, { recursive: true });
  await fs.writeFile(getBoardFilePath(board.id), JSON.stringify(normalizeBoard(board, {
    id: board.id,
    name: board.name,
    version: BOARD_VERSION,
  }, { preserveLegacy: false }), null, 2));
}

async function readLegacyBoard() {
  try {
    const raw = await fs.readFile(LEGACY_BOARD_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return createBoard({
      id: 'default-board',
      name: 'Board 1',
    });
  }
}

async function assertBoardExists(boardId) {
  const indexResult = await readBoardsIndex();

  if (!findBoardSummary(indexResult.index, boardId)) {
    const error = new Error('That board could not be found.');
    error.statusCode = 404;
    throw error;
  }
}

function createBoardRecord(boardNumber) {
  const board = createBoard({
    id: createBoardId(),
    name: `Board ${boardNumber}`,
  });

  return { board };
}

function createBoard(defaults = {}) {
  const updatedAt = normalizeTimestamp(defaults.updatedAt);

  return {
    id: defaults.id || createBoardId(),
    name: defaults.name || 'Board 1',
    version: BOARD_VERSION,
    activeLayout: DEFAULT_LAYOUT_ID,
    updatedAt,
    assets: [],
    layouts: createEmptyLayouts(updatedAt),
  };
}

function createBoardsIndex(boards, nextBoardNumber) {
  return normalizeBoardsIndex({
    version: INDEX_VERSION,
    nextBoardNumber,
    boards,
  });
}

function normalizeBoardsIndex(index) {
  const source = isPlainObject(index) ? index : {};
  const boards = Array.isArray(source.boards)
    ? sortBoardSummaries(source.boards.map(normalizeBoardSummary))
    : [];

  return {
    version: Number.isInteger(source.version) ? source.version : INDEX_VERSION,
    nextBoardNumber: Math.max(
      normalizeNumber(source.nextBoardNumber, 1),
      getNextBoardNumber(boards),
    ),
    boards,
  };
}

function normalizeBoardSummary(summary) {
  const source = isPlainObject(summary) ? summary : {};

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : createBoardId(),
    name: typeof source.name === 'string' && source.name.trim() ? source.name : 'Board',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    itemCount: Math.max(0, normalizeNumber(source.itemCount, 0)),
  };
}

function normalizeBoard(board, defaults = {}) {
  const options = arguments[2] || {};
  const source = isPlainObject(board) ? board : {};
  const fallback = createBoard(defaults);
  const activeLayout = ALLOWED_LAYOUT_IDS.has(source.activeLayout)
    ? source.activeLayout
    : (ALLOWED_LAYOUT_IDS.has(source.arrangeMode) ? source.arrangeMode : fallback.activeLayout);
  const updatedAt = normalizeTimestamp(source.updatedAt, fallback.updatedAt);
  const assets = Array.isArray(source.assets)
    ? source.assets.map(normalizeAsset)
    : (Array.isArray(source.items) ? source.items.map(legacyItemToAsset) : []);
  const normalized = {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : fallback.id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name : fallback.name,
    version: Number.isInteger(source.version) ? source.version : fallback.version,
    activeLayout,
    updatedAt,
    assets,
  };
  const isLegacyOnly = !isPlainObject(source.layouts)
    && !Array.isArray(source.assets)
    && ('arrangeMode' in source || Array.isArray(source.items));

  if (options.preserveLegacy && isLegacyOnly) {
    return {
      ...normalized,
      version: BOARD_VERSION,
      layouts: createEmptyLayouts(updatedAt),
    };
  }

  return {
    ...normalized,
    version: BOARD_VERSION,
    layouts: normalizeLayoutMap(source.layouts, updatedAt),
  };
}

function createEmptyLayouts(updatedAt = new Date().toISOString()) {
  return Object.fromEntries(
    LAYOUT_IDS.map((layoutId) => [layoutId, createLayoutState([], updatedAt)]),
  );
}

function normalizeLayoutMap(layouts, updatedAt) {
  const source = isPlainObject(layouts) ? layouts : {};

  return Object.fromEntries(
    LAYOUT_IDS.map((layoutId) => [
      layoutId,
      normalizeLayoutState(source[layoutId], updatedAt),
    ]),
  );
}

function normalizeLayoutState(layout, updatedAt) {
  const source = isPlainObject(layout) ? layout : {};

  return {
    updatedAt: normalizeTimestamp(source.updatedAt, updatedAt),
    items: Array.isArray(source.items) ? source.items.map(normalizeLayoutItem) : [],
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

function createBoardSummary(board) {
  return {
    id: board.id,
    name: board.name,
    updatedAt: board.updatedAt,
    itemCount: countBoardAssets(board),
  };
}

function addBoardToIndex(index, board) {
  return normalizeBoardsIndex({
    ...index,
    boards: [createBoardSummary(board), ...index.boards.filter((entry) => entry.id !== board.id)],
    nextBoardNumber: Math.max(index.nextBoardNumber, extractBoardNumber(board.name) + 1),
  });
}

function upsertBoardSummary(index, board) {
  return normalizeBoardsIndex({
    ...index,
    boards: [
      createBoardSummary(board),
      ...index.boards.filter((entry) => entry.id !== board.id),
    ],
  });
}

function sortBoardSummaries(boards) {
  return [...boards].sort((left, right) => {
    const rightTime = Date.parse(right.updatedAt);
    const leftTime = Date.parse(left.updatedAt);

    if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    return right.name.localeCompare(left.name);
  });
}

function getNextBoardNumber(boards) {
  const highest = boards.reduce((max, board) => Math.max(max, extractBoardNumber(board.name)), 0);
  return highest + 1;
}

function extractBoardNumber(name) {
  const match = /^Board\s+(\d+)$/i.exec(name || '');
  return match ? Number(match[1]) : 0;
}

function findBoardSummary(index, boardId) {
  return index.boards.find((board) => board.id === boardId) || null;
}

function createUploadedAsset(file, manifestEntry, boardId) {
  const manifest = isPlainObject(manifestEntry) ? manifestEntry : {};
  const originalWidth = normalizePositiveNumber(manifest.originalWidth, 240);
  const originalHeight = normalizePositiveNumber(manifest.originalHeight, 180);

  return {
    id: crypto.randomUUID(),
    fileName: file.originalname,
    src: `/uploads/${boardId}/${file.filename}`,
    originalWidth,
    originalHeight,
  };
}

function parseManifest(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function cleanupRemovedUploads(previousAssets, nextAssets) {
  const nextSources = new Set(getUploadSources(nextAssets));
  const removedSources = [...new Set(
    getUploadSources(previousAssets)
      .filter((src) => !nextSources.has(src)),
  )];

  await Promise.all(
    removedSources.map(async (src) => {
      const filePath = resolveUploadPath(src);

      if (!filePath) {
        return;
      }

      await fs.unlink(filePath).catch(() => {});
      await removeEmptyUploadParent(path.dirname(filePath));
    }),
  );
}

function getUploadSources(assets) {
  return (Array.isArray(assets) ? assets : [])
    .map((asset) => asset?.src)
    .filter((src) => typeof src === 'string' && src.startsWith('/uploads/'));
}

function resolveUploadPath(src) {
  if (typeof src !== 'string' || !src.startsWith('/uploads/')) {
    return null;
  }

  const relative = src.replace(/^\/uploads\//, '');
  const safePath = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');

  return path.join(UPLOADS_DIR, safePath);
}

async function removeUploadDirectory(boardId) {
  const targetDirectory = path.join(UPLOADS_DIR, boardId);
  await fs.rm(targetDirectory, { recursive: true, force: true }).catch(() => {});
}

async function removeEmptyUploadParent(directoryPath) {
  if (directoryPath === UPLOADS_DIR) {
    return;
  }

  const relative = path.relative(UPLOADS_DIR, directoryPath);

  if (!relative || relative.startsWith('..') || relative.includes(path.sep)) {
    return;
  }

  const entries = await fs.readdir(directoryPath).catch(() => null);

  if (entries && entries.length === 0) {
    await fs.rmdir(directoryPath).catch(() => {});
  }
}

function getBoardFilePath(boardId) {
  return path.join(BOARDS_DIR, `${boardId}.json`);
}

function createBoardId() {
  return `board-${crypto.randomUUID()}`;
}

function createUploadName(originalName) {
  const extension = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function normalizeAsset(asset) {
  const source = isPlainObject(asset) ? asset : {};

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : crypto.randomUUID(),
    fileName: typeof source.fileName === 'string' ? source.fileName : 'Untitled image',
    src: typeof source.src === 'string' ? source.src : '',
    originalWidth: normalizePositiveNumber(source.originalWidth, 240),
    originalHeight: normalizePositiveNumber(source.originalHeight, 180),
  };
}

function legacyItemToAsset(item) {
  const source = isPlainObject(item) ? item : {};

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : crypto.randomUUID(),
    fileName: typeof source.fileName === 'string' ? source.fileName : 'Untitled image',
    src: typeof source.src === 'string' ? source.src : '',
    originalWidth: normalizePositiveNumber(source.originalWidth || source.width, 240),
    originalHeight: normalizePositiveNumber(source.originalHeight || source.height, 180),
  };
}

function createLayoutState(items, updatedAt = new Date().toISOString()) {
  return {
    updatedAt: normalizeTimestamp(updatedAt),
    items: Array.isArray(items) ? items.map(normalizeLayoutItem) : [],
  };
}

function countBoardAssets(board) {
  return Array.isArray(board?.assets) ? board.assets.length : 0;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTimestamp(value, fallback = new Date().toISOString()) {
  return typeof value === 'string' && value ? value : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
