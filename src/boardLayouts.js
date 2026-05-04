import { arrangeItems, ARRANGE_OPTIONS, getNextZIndex } from './arrange.js';

export const BOARD_SCHEMA_VERSION = 2;
export const DEFAULT_LAYOUT_ID = 'pile';
export const LAYOUT_IDS = ARRANGE_OPTIONS.map((option) => option.id);

export function createEmptyLayouts(updatedAt = timestamp()) {
  return Object.fromEntries(
    LAYOUT_IDS.map((layoutId) => [layoutId, createLayoutState([], updatedAt)]),
  );
}

export function prepareBoardForClient(board, viewport) {
  if (needsFullMigration(board)) {
    return {
      board: migrateBoardToSavedLayouts(board, viewport),
      changed: true,
    };
  }

  return repairSavedLayouts(board, viewport);
}

export function getVisibleItems(board) {
  const assetsById = new Map((board?.assets || []).map((asset) => [asset.id, asset]));
  const layoutItems = getLayoutItems(board);

  return layoutItems
    .map((item) => {
      const asset = assetsById.get(item.id);

      if (!asset) {
        return null;
      }

      return {
        ...asset,
        ...item,
      };
    })
    .filter(Boolean);
}

export function getLayoutItems(board, layoutId = board?.activeLayout || DEFAULT_LAYOUT_ID) {
  return Array.isArray(board?.layouts?.[layoutId]?.items) ? board.layouts[layoutId].items : [];
}

export function appendAssetsToLayouts(board, newAssets, viewport) {
  const normalizedNewAssets = newAssets.map(normalizeAsset);
  const nextTimestamp = timestamp();
  const layouts = {};
  const assets = [...(board.assets || []), ...normalizedNewAssets];

  for (const layoutId of LAYOUT_IDS) {
    const existingItems = getLayoutItems(board, layoutId);
    const appendedItems = arrangeAppendedItems(
      existingItems,
      normalizedNewAssets,
      layoutId,
      viewport,
    );

    layouts[layoutId] = createLayoutState(
      [...existingItems, ...appendedItems],
      nextTimestamp,
    );
  }

  return {
    ...board,
    version: BOARD_SCHEMA_VERSION,
    assets,
    layouts,
    updatedAt: nextTimestamp,
  };
}

export function updateBoardLayoutItems(board, layoutId, items) {
  const nextTimestamp = timestamp();

  return {
    ...board,
    layouts: {
      ...board.layouts,
      [layoutId]: createLayoutState(items, nextTimestamp),
    },
    updatedAt: nextTimestamp,
  };
}

export function setActiveLayout(board, layoutId, viewport) {
  const ensuredBoard = ensureLayoutExists(board, layoutId, viewport);

  if (ensuredBoard.activeLayout === layoutId) {
    return ensuredBoard;
  }

  return {
    ...ensuredBoard,
    activeLayout: layoutId,
    updatedAt: timestamp(),
  };
}

export function removeAssetIdsFromBoard(board, assetIds) {
  const idsToRemove = new Set(assetIds);
  const nextTimestamp = timestamp();
  const layouts = {};

  for (const layoutId of LAYOUT_IDS) {
    layouts[layoutId] = createLayoutState(
      getLayoutItems(board, layoutId).filter((item) => !idsToRemove.has(item.id)),
      nextTimestamp,
    );
  }

  return {
    ...board,
    assets: (board.assets || []).filter((asset) => !idsToRemove.has(asset.id)),
    layouts,
    updatedAt: nextTimestamp,
  };
}

export function clearBoardLayouts(board) {
  return {
    ...board,
    activeLayout: DEFAULT_LAYOUT_ID,
    assets: [],
    layouts: createEmptyLayouts(),
    updatedAt: timestamp(),
  };
}

export function countBoardAssets(board) {
  return Array.isArray(board?.assets) ? board.assets.length : 0;
}

export function isLayoutId(value) {
  return LAYOUT_IDS.includes(value);
}

function repairSavedLayouts(board, viewport) {
  const normalizedBoard = normalizeSavedLayoutsBoard(board);
  const layouts = {};
  let changed = normalizedBoard.version !== BOARD_SCHEMA_VERSION;

  for (const layoutId of LAYOUT_IDS) {
    const result = repairSingleLayout(
      normalizedBoard.layouts?.[layoutId],
      normalizedBoard.assets,
      layoutId,
      viewport,
    );

    layouts[layoutId] = result.layout;
    changed = changed || result.changed;
  }

  const nextBoard = {
    ...normalizedBoard,
    version: BOARD_SCHEMA_VERSION,
    layouts,
  };

  return {
    board: nextBoard,
    changed,
  };
}

function repairSingleLayout(layout, assets, layoutId, viewport) {
  if (!layout || !Array.isArray(layout.items)) {
    return {
      layout: buildLayoutFromAssets(assets, layoutId, viewport),
      changed: assets.length > 0 || !layout,
    };
  }

  const assetIds = new Set(assets.map((asset) => asset.id));
  const seenIds = new Set();
  const keptItems = [];
  let changed = false;

  for (const item of layout.items) {
    const normalizedItem = normalizeLayoutItem(item);

    if (!assetIds.has(normalizedItem.id) || seenIds.has(normalizedItem.id)) {
      changed = true;
      continue;
    }

    seenIds.add(normalizedItem.id);
    keptItems.push(normalizedItem);
  }

  const missingAssets = assets.filter((asset) => !seenIds.has(asset.id));
  const appendedItems = arrangeAppendedItems(
    keptItems,
    missingAssets,
    layoutId,
    viewport,
  );

  if (appendedItems.length) {
    changed = true;
  }

  return {
    layout: createLayoutState(
      [...keptItems, ...appendedItems],
      changed ? timestamp() : normalizeTimestamp(layout.updatedAt),
    ),
    changed,
  };
}

function migrateBoardToSavedLayouts(board, viewport) {
  const normalizedBoard = normalizeLegacyCompatibleBoard(board);
  const nextTimestamp = timestamp();

  return {
    id: normalizedBoard.id,
    name: normalizedBoard.name,
    version: BOARD_SCHEMA_VERSION,
    activeLayout: normalizedBoard.activeLayout,
    updatedAt: nextTimestamp,
    assets: normalizedBoard.assets,
    layouts: Object.fromEntries(
      LAYOUT_IDS.map((layoutId) => [
        layoutId,
        buildLayoutFromAssets(normalizedBoard.assets, layoutId, viewport, nextTimestamp),
      ]),
    ),
  };
}

function buildLayoutFromAssets(assets, layoutId, viewport, updatedAt = timestamp()) {
  const arrangedItems = arrangeItems(assets, layoutId, viewport, {
    limitSizeVariance: true,
    referenceItems: [],
  }).map(toLayoutItem);

  return createLayoutState(arrangedItems, updatedAt);
}

function ensureLayoutExists(board, layoutId, viewport) {
  const layout = board.layouts?.[layoutId];

  if (layout && Array.isArray(layout.items) && layout.items.length >= (board.assets || []).length) {
    return board;
  }

  const result = repairSavedLayouts(board, viewport);
  return result.board;
}

function normalizeSavedLayoutsBoard(board) {
  const normalized = normalizeLegacyCompatibleBoard(board);

  return {
    ...normalized,
    version: Number.isInteger(normalized.version) ? normalized.version : BOARD_SCHEMA_VERSION,
    layouts: isPlainObject(normalized.layouts) ? normalized.layouts : createEmptyLayouts(normalized.updatedAt),
  };
}

function normalizeLegacyCompatibleBoard(board) {
  const source = isPlainObject(board) ? board : {};
  const activeLayout = isLayoutId(source.activeLayout)
    ? source.activeLayout
    : (isLayoutId(source.arrangeMode) ? source.arrangeMode : DEFAULT_LAYOUT_ID);
  const assets = Array.isArray(source.assets)
    ? source.assets.map(normalizeAsset)
    : (Array.isArray(source.items) ? source.items.map(legacyItemToAsset) : []);

  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : `board-${crypto.randomUUID()}`,
    name: typeof source.name === 'string' && source.name.trim() ? source.name : 'Board',
    version: Number.isInteger(source.version) ? source.version : 1,
    activeLayout,
    updatedAt: normalizeTimestamp(source.updatedAt),
    assets,
    layouts: source.layouts,
  };
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

function toLayoutItem(item) {
  return normalizeLayoutItem(item);
}

function arrangeAppendedItems(existingItems, appendedAssets, layoutId, viewport) {
  if (!appendedAssets.length) {
    return [];
  }

  if (!existingItems.length) {
    return arrangeItems(appendedAssets, layoutId, viewport, {
      zIndexStart: 1,
      limitSizeVariance: true,
      referenceItems: [],
    }).map(toLayoutItem);
  }

  if (layoutId === 'fan') {
    return appendFanItems(existingItems, appendedAssets, viewport);
  }

  if (layoutId === 'grid') {
    return appendGridItems(existingItems, appendedAssets, viewport);
  }

  return arrangeItems(appendedAssets, layoutId, viewport, {
    zIndexStart: getNextZIndex(existingItems) + 1,
    limitSizeVariance: true,
    referenceItems: existingItems,
  }).map(toLayoutItem);
}

function appendFanItems(existingItems, appendedAssets, viewport) {
  const usableHeight = Math.max(320, viewport?.height || 0) - Math.max(0, viewport?.paddingTop || 0);
  const defaultTargetHeight = clamp(usableHeight * 0.28, 112, 196);
  const targetHeight = getMedian(existingItems.map((item) => item.height).filter(Boolean)) || defaultTargetHeight;
  const baselineCenterY = getMedian(existingItems.map((item) => item.y + item.height / 2).filter(Number.isFinite))
    || (Math.max(0, viewport?.paddingTop || 0) + usableHeight / 2);
  const rightEdge = Math.max(...existingItems.map((item) => item.x + item.width));
  const lastRotation = Math.max(...existingItems.map((item) => item.rotation || 0), 0);
  const gap = clamp((viewport?.width || 0) * 0.018, 18, 30);
  const depthStep = clamp(targetHeight * 0.16, 14, 28);
  let nextZIndex = getNextZIndex(existingItems) + 1;
  let currentX = rightEdge + gap;

  return appendedAssets.map((asset, index) => {
    const size = scaleAssetToHeight(asset, targetHeight);
    const offsetIndex = index + 1;
    const x = currentX;
    const y = baselineCenterY - size.height / 2 + Math.pow(offsetIndex, 1.08) * depthStep * 0.4;
    const rotation = clamp(lastRotation + offsetIndex * 5, -75, 75);

    currentX += size.width * 0.82 + gap;

    return toLayoutItem({
      id: asset.id,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      rotation: round(rotation),
      zIndex: nextZIndex++,
    });
  });
}

function appendGridItems(existingItems, appendedAssets, viewport) {
  const columnWidth = getMedian(existingItems.map((item) => item.width).filter(Boolean))
    || clamp(Math.min(viewport?.width || 0, viewport?.height || 0) * 0.14, 112, 154);
  const columns = inferGridColumns(existingItems, columnWidth, viewport);
  const gap = inferGridGap(columns, columnWidth);
  const sectionStartY = Math.max(
    ...existingItems.map((item) => item.y + item.height),
    Math.max(0, viewport?.paddingTop || 0) + 18,
  ) + gap;
  const columnHeights = columns.map(() => sectionStartY);
  let nextZIndex = getNextZIndex(existingItems) + 1;

  return appendedAssets.map((asset) => {
    const columnIndex = getShortestColumnIndex(columnHeights);
    const size = fitAssetToWidth(asset, columnWidth);
    const x = columns[columnIndex];
    const y = columnHeights[columnIndex];

    columnHeights[columnIndex] += size.height + gap;

    return toLayoutItem({
      id: asset.id,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      rotation: 0,
      zIndex: nextZIndex++,
    });
  });
}

function inferGridColumns(existingItems, columnWidth, viewport) {
  const sortedX = [...existingItems]
    .map((item) => item.x)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const tolerance = Math.max(10, columnWidth * 0.2);
  const columns = [];

  for (const x of sortedX) {
    const lastX = columns[columns.length - 1];

    if (typeof lastX !== 'number' || Math.abs(x - lastX) > tolerance) {
      columns.push(x);
    }
  }

  if (columns.length) {
    return columns;
  }

  const fallbackGap = 6;
  const outerMargin = 18;
  const usableWidth = Math.max(160, (viewport?.width || 0) - outerMargin * 2);
  const columnCount = Math.max(1, Math.floor((usableWidth + fallbackGap) / (columnWidth + fallbackGap)));
  const totalWidth = columnWidth * columnCount + fallbackGap * (columnCount - 1);
  const startX = Math.max(outerMargin, ((viewport?.width || 0) - totalWidth) / 2);

  return Array.from({ length: columnCount }, (_value, index) => (
    startX + index * (columnWidth + fallbackGap)
  ));
}

function inferGridGap(columns, columnWidth) {
  if (columns.length < 2) {
    return 6;
  }

  const gaps = [];

  for (let index = 1; index < columns.length; index += 1) {
    const gap = columns[index] - columns[index - 1] - columnWidth;

    if (gap > 0) {
      gaps.push(gap);
    }
  }

  return getMedian(gaps) || 6;
}

function scaleAssetToHeight(asset, targetHeight) {
  const originalWidth = normalizePositiveNumber(asset.originalWidth || asset.width, 240);
  const originalHeight = normalizePositiveNumber(asset.originalHeight || asset.height, 180);
  const scale = targetHeight / originalHeight;

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function fitAssetToWidth(asset, targetWidth) {
  const originalWidth = normalizePositiveNumber(asset.originalWidth || asset.width, 240);
  const originalHeight = normalizePositiveNumber(asset.originalHeight || asset.height, 180);
  const scale = targetWidth / originalWidth;

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function getMedian(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function getShortestColumnIndex(columnHeights) {
  let shortestIndex = 0;

  for (let index = 1; index < columnHeights.length; index += 1) {
    if (columnHeights[index] < columnHeights[shortestIndex]) {
      shortestIndex = index;
    }
  }

  return shortestIndex;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
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

function createLayoutState(items, updatedAt = timestamp()) {
  return {
    updatedAt: normalizeTimestamp(updatedAt),
    items: Array.isArray(items) ? items.map(normalizeLayoutItem) : [],
  };
}

function needsFullMigration(board) {
  return !isPlainObject(board?.layouts) || normalizeLegacyCompatibleBoard(board).version < BOARD_SCHEMA_VERSION;
}

function normalizeTimestamp(value) {
  return typeof value === 'string' && value ? value : timestamp();
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestamp() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
