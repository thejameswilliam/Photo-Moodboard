const PAPER_MIN = 132;
const MAX_INITIAL_AREA_RATIO = 4;

export const ARRANGE_OPTIONS = [
  { id: 'pile', label: 'Pile' },
  { id: 'fan', label: 'Fan' },
  { id: 'grid', label: 'Grid' },
];

export function arrangeItems(items, mode, viewport, options = {}) {
  const nextMode = isArrangeMode(mode) ? mode : 'pile';
  const safeViewport = {
    width: Math.max(320, viewport?.width || 0),
    height: Math.max(320, viewport?.height || 0),
    paddingTop: Math.max(0, viewport?.paddingTop || 0),
  };
  const zIndexStart = Number.isFinite(options.zIndexStart) ? options.zIndexStart : 1;
  let arrangedItems;

  if (nextMode === 'fan') {
    arrangedItems = arrangeFan(items, safeViewport, zIndexStart);
  } else if (nextMode === 'grid') {
    arrangedItems = arrangeGrid(items, safeViewport, zIndexStart);
  } else {
    arrangedItems = arrangePile(items, safeViewport, zIndexStart);
  }

  if (options.limitSizeVariance && nextMode === 'pile') {
    return limitArrangedItemSizes(arrangedItems, options.referenceItems);
  }

  return arrangedItems;
}

export function getNextZIndex(items) {
  return items.reduce((highest, item) => Math.max(highest, item.zIndex || 0), 0);
}

export function isArrangeMode(value) {
  return value === 'pile' || value === 'fan' || value === 'grid';
}

function arrangePile(items, viewport, zIndexStart) {
  const count = items.length;
  const centerX = viewport.width / 2;
  const centerY = viewport.paddingTop + (viewport.height - viewport.paddingTop) / 2;
  const radiusX = clamp(viewport.width * 0.16 + count * 8, 70, viewport.width * 0.24);
  const radiusY = clamp((viewport.height - viewport.paddingTop) * 0.12 + count * 6, 54, viewport.height * 0.18);
  const baseLongSide = clamp(Math.min(viewport.width, viewport.height) * 0.18, 108, 176);

  return items.map((item, index) => {
    const variedLongSide = baseLongSide + randomBetween(-20, 14);
    const size = scaleToLongSide(item, variedLongSide);
    const x = centerX - size.width / 2 + randomBetween(-radiusX, radiusX);
    const y = centerY - size.height / 2 + randomBetween(-radiusY, radiusY);

    return {
      ...item,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      rotation: round(randomBetween(-18, 18)),
      zIndex: zIndexStart + index,
    };
  });
}

function arrangeFan(items, viewport, zIndexStart) {
  const count = items.length;
  const usableHeight = viewport.height - viewport.paddingTop;
  const centerX = viewport.width / 2;
  const centerY = viewport.paddingTop + usableHeight * 0.52;
  const targetHeight = clamp(usableHeight * 0.28, 112, 196);
  const sizedItems = items.map((item) => scaleToHeight(item, targetHeight));
  const pairGap = clamp(viewport.width * 0.01, 10, 18);
  const baseSteps = sizedItems.slice(1).map((size, index) => (
    ((sizedItems[index].width + size.width) / 2) * 0.84 + pairGap
  ));
  const desiredSpan = baseSteps.reduce((sum, step) => sum + step, 0);
  const maxSpan = Math.max(120, viewport.width - 124);
  const compression = desiredSpan > 0 ? Math.min(1, maxSpan / desiredSpan) : 1;
  const steps = baseSteps.map((step) => step * compression);
  const totalSpan = steps.reduce((sum, step) => sum + step, 0);
  const rotationSpread = clamp(count * 6, 22, 52);
  const arcDepth = clamp(targetHeight * 0.38, 42, 88);
  const firstCenterX = centerX - totalSpan / 2;
  let currentCenterX = firstCenterX;

  return items.map((item, index) => {
    const progress = count > 1 ? index / (count - 1) : 0.5;
    const centered = progress - 0.5;
    const size = sizedItems[index];
    const x = currentCenterX - size.width / 2 + randomBetween(-4, 4);
    const y = centerY + Math.pow(Math.abs(centered), 1.15) * arcDepth - size.height / 2 + randomBetween(-5, 5);
    const rotation = centered * rotationSpread * 1.55 + randomBetween(-1.2, 1.2);

    currentCenterX += steps[index] || 0;

    return {
      ...item,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      rotation: round(rotation),
      zIndex: zIndexStart + index,
    };
  });
}

function arrangeGrid(items, viewport, zIndexStart) {
  const count = items.length;
  const gap = 6;
  const outerMargin = 18;
  const topMargin = 18;
  const usableWidth = Math.max(160, viewport.width - outerMargin * 2);
  const idealColumnWidth = clamp(Math.min(viewport.width, viewport.height) * 0.14, 112, 154);
  const columns = Math.max(1, Math.min(
    count,
    Math.floor((usableWidth + gap) / (idealColumnWidth + gap)),
  ));
  const columnWidth = Math.max(96, (usableWidth - gap * (columns - 1)) / columns);
  const totalWidth = columnWidth * columns + gap * (columns - 1);
  const startX = Math.max(outerMargin, (viewport.width - totalWidth) / 2);
  const columnHeights = Array(columns).fill(viewport.paddingTop + topMargin);

  return items.map((item, index) => {
    const column = getShortestColumnIndex(columnHeights);
    const size = fitToWidth(item, columnWidth);
    const x = startX + column * (columnWidth + gap);
    const y = columnHeights[column];

    columnHeights[column] += size.height + gap;

    return {
      ...item,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      rotation: 0,
      zIndex: zIndexStart + index,
    };
  });
}

function scaleToLongSide(item, targetLongSide) {
  const originalWidth = Math.max(PAPER_MIN, item.originalWidth || item.width || PAPER_MIN);
  const originalHeight = Math.max(PAPER_MIN, item.originalHeight || item.height || PAPER_MIN);
  const longSide = Math.max(originalWidth, originalHeight);
  const scale = clamp(targetLongSide / longSide, 0.18, 5);

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function scaleToHeight(item, targetHeight) {
  const originalWidth = getPositiveDimension(item.originalWidth || item.width || PAPER_MIN);
  const originalHeight = getPositiveDimension(item.originalHeight || item.height || PAPER_MIN);
  const scale = clamp(targetHeight / originalHeight, 0.18, 5);

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function getPositiveDimension(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PAPER_MIN;
}

function fitWithin(item, maxWidth, maxHeight) {
  const originalWidth = Math.max(PAPER_MIN, item.originalWidth || item.width || PAPER_MIN);
  const originalHeight = Math.max(PAPER_MIN, item.originalHeight || item.height || PAPER_MIN);
  const scale = Math.min(maxWidth / originalWidth, maxHeight / originalHeight);

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function fitToWidth(item, targetWidth) {
  const originalWidth = Math.max(PAPER_MIN, item.originalWidth || item.width || PAPER_MIN);
  const originalHeight = Math.max(PAPER_MIN, item.originalHeight || item.height || PAPER_MIN);
  const scale = targetWidth / originalWidth;

  return {
    width: round(originalWidth * scale),
    height: round(originalHeight * scale),
  };
}

function scaleSize(size, scale) {
  return {
    width: round(size.width * scale),
    height: round(size.height * scale),
  };
}

function limitArrangedItemSizes(arrangedItems, referenceItems = []) {
  const referenceAreas = getReferenceAreas(referenceItems, arrangedItems);

  if (!referenceAreas.length) {
    return arrangedItems;
  }

  const medianArea = getMedian(referenceAreas);
  const areaClampFromMedian = Math.sqrt(MAX_INITIAL_AREA_RATIO);
  const minArea = medianArea / areaClampFromMedian;
  const maxArea = medianArea * areaClampFromMedian;

  return arrangedItems.map((item) => {
    const currentArea = Math.max(1, item.width * item.height);

    if (currentArea >= minArea && currentArea <= maxArea) {
      return item;
    }

    const targetArea = clamp(currentArea, minArea, maxArea);
    const scale = Math.sqrt(targetArea / currentArea);
    const nextWidth = round(item.width * scale);
    const nextHeight = round(item.height * scale);
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;

    return {
      ...item,
      width: nextWidth,
      height: nextHeight,
      x: round(centerX - nextWidth / 2),
      y: round(centerY - nextHeight / 2),
    };
  });
}

function getReferenceAreas(referenceItems, arrangedItems) {
  const fromReferenceItems = referenceItems
    .map((item) => Math.max(0, normalizeArea(item.width, item.height)))
    .filter(Boolean);

  if (fromReferenceItems.length) {
    return fromReferenceItems;
  }

  return arrangedItems
    .map((item) => Math.max(0, normalizeArea(item.width, item.height)))
    .filter(Boolean);
}

function normalizeArea(width, height) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);

  if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedHeight)) {
    return 0;
  }

  return normalizedWidth * normalizedHeight;
}

function getMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function getShortestColumnIndex(columnHeights) {
  let index = 0;

  for (let currentIndex = 1; currentIndex < columnHeights.length; currentIndex += 1) {
    if (columnHeights[currentIndex] < columnHeights[index]) {
      index = currentIndex;
    }
  }

  return index;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}
