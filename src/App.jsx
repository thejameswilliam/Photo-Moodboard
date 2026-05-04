import { startTransition, useEffect, useRef, useState } from 'react';

import {
  clearBoard as clearBoardRequest,
  createBoard as createBoardRequest,
  deleteBoard as deleteBoardRequest,
  fetchBoard as fetchBoardRequest,
  fetchBoards,
  saveBoard as saveBoardRequest,
  uploadImages,
} from './api';
import { ARRANGE_OPTIONS, getNextZIndex } from './arrange';
import {
  appendAssetsToLayouts,
  countBoardAssets,
  getLayoutItems,
  getVisibleItems,
  prepareBoardForClient,
  removeAssetIdsFromBoard,
  setActiveLayout,
  updateBoardLayoutItems,
} from './boardLayouts';

const AUTOSAVE_DELAY = 450;
const TOOLBAR_PADDING_TOP = 54;
const MIN_ITEM_WIDTH = 96;
const MIN_ITEM_HEIGHT = 96;
const MAX_SCALE = 6;

export default function App() {
  const boardRef = useRef(null);
  const boardsMenuRef = useRef(null);
  const dragDepthRef = useRef(0);
  const interactionRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const skipNextAutosaveRef = useRef(true);
  const boardSnapshotRef = useRef(null);
  const boardsRef = useRef([]);
  const currentBoardIdRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const localChangeVersionRef = useRef(0);
  const lastSavedVersionRef = useRef(0);

  const [board, setBoard] = useState(null);
  const [boards, setBoards] = useState([]);
  const [currentBoardId, setCurrentBoardId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isBoardActionPending, setIsBoardActionPending] = useState(false);
  const [isBoardsMenuOpen, setIsBoardsMenuOpen] = useState(false);
  const [missingIds, setMissingIds] = useState([]);
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading boards...' });

  useEffect(() => {
    boardSnapshotRef.current = board;
  }, [board]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  useEffect(() => {
    currentBoardIdRef.current = currentBoardId;
  }, [currentBoardId]);

  useEffect(() => {
    let isCancelled = false;

    async function loadWorkspace() {
      try {
        const result = await fetchBoards();

        if (isCancelled) {
          return;
        }

        const initialBoardId = pickInitialBoardId(result.boards);

        if (!initialBoardId) {
          setStatus({ type: 'error', message: 'No boards were available to load.' });
          return;
        }

        await openBoard(initialBoardId, {
          boardsOverride: result.boards,
          loadingMessage: 'Loading board...',
        });
      } catch (error) {
        if (isCancelled) {
          return;
        }

        setStatus({ type: 'error', message: error.message });
      }
    }

    loadWorkspace();

    return () => {
      isCancelled = true;
      loadRequestIdRef.current += 1;
      window.clearTimeout(autosaveTimerRef.current);
      window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function handlePointerMove(event) {
      const interaction = interactionRef.current;

      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();

      startTransition(() => {
        setBoard((currentBoard) => {
          if (!currentBoard) {
            return currentBoard;
          }

          const nextItems = getLayoutItems(currentBoard).map((item) => {
            if (item.id !== interaction.itemId) {
              return item;
            }

            if (interaction.mode === 'drag') {
              const deltaX = event.clientX - interaction.startPointer.x;
              const deltaY = event.clientY - interaction.startPointer.y;

              return {
                ...item,
                x: round(interaction.startItem.x + deltaX),
                y: round(interaction.startItem.y + deltaY),
                zIndex: interaction.startItem.zIndex,
              };
            }

            if (interaction.mode === 'resize') {
              const nextDistance = Math.max(
                48,
                Math.hypot(event.clientX - interaction.center.x, event.clientY - interaction.center.y),
              );
              const scale = clamp(nextDistance / interaction.startDistance, 0.2, MAX_SCALE);
              const nextWidth = Math.max(MIN_ITEM_WIDTH, interaction.startItem.width * scale);
              const nextHeight = Math.max(MIN_ITEM_HEIGHT, interaction.startItem.height * scale);

              return {
                ...item,
                width: round(nextWidth),
                height: round(nextHeight),
                x: round(interaction.center.x - nextWidth / 2),
                y: round(interaction.center.y - nextHeight / 2),
                zIndex: interaction.startItem.zIndex,
              };
            }

            const currentAngle = Math.atan2(
              event.clientY - interaction.center.y,
              event.clientX - interaction.center.x,
            );
            const deltaAngle = (currentAngle - interaction.startAngle) * (180 / Math.PI);

            return {
              ...item,
              rotation: round(normalizeAngle(interaction.startItem.rotation + deltaAngle)),
              zIndex: interaction.startItem.zIndex,
            };
          });

          return updateBoardLayoutItems(currentBoard, currentBoard.activeLayout, nextItems);
        });
      });
    }

    function handlePointerRelease(event) {
      if (interactionRef.current?.pointerId === event.pointerId) {
        interactionRef.current = null;
      }
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerRelease);
    window.addEventListener('pointercancel', handlePointerRelease);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!selectedItemId || isTypingTarget(event.target)) {
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      event.preventDefault();
      removeItem(selectedItemId);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedItemId]);

  useEffect(() => {
    if (!isBoardsMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!boardsMenuRef.current?.contains(event.target)) {
        setIsBoardsMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsBoardsMenuOpen(false);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBoardsMenuOpen]);

  useEffect(() => {
    if (!board || !currentBoardId) {
      return undefined;
    }

    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      localChangeVersionRef.current = 0;
      lastSavedVersionRef.current = 0;
      return undefined;
    }

    const saveVersion = localChangeVersionRef.current + 1;
    localChangeVersionRef.current = saveVersion;

    updateBoardSummary(board);
    window.clearTimeout(autosaveTimerRef.current);
    setStatus((currentStatus) => (
      currentStatus?.type === 'error'
        ? currentStatus
        : { type: 'saving', message: 'Saving layout...' }
    ));

    autosaveTimerRef.current = window.setTimeout(async () => {
      try {
        await saveBoardRequest(currentBoardId, board);
        lastSavedVersionRef.current = Math.max(lastSavedVersionRef.current, saveVersion);
        setTransientStatus({ type: 'saved', message: 'Saved locally' });
      } catch (error) {
        setStatus({ type: 'error', message: `Autosave failed. ${error.message}` });
      }
    }, AUTOSAVE_DELAY);

    return () => window.clearTimeout(autosaveTimerRef.current);
  }, [board, currentBoardId]);

  async function openBoard(boardId, options = {}) {
    const requestId = ++loadRequestIdRef.current;

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: options.loadingMessage || 'Loading board...' });

    try {
      const result = await fetchBoardRequest(boardId);

      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      const prepared = prepareBoardForClient(result.board, getBoardViewport(boardRef.current));
      let nextBoard = prepared.board;
      let nextWarning = result.warning;

      if (prepared.changed) {
        try {
          const saveResult = await saveBoardRequest(boardId, prepared.board);
          nextBoard = saveResult.board;
        } catch (error) {
          nextWarning = appendWarning(
            result.warning,
            `Saved layout upgrade is ready locally but could not be written yet. ${error.message}`,
          );
        }
      }

      applyLoadedBoard(nextBoard, {
        boardsOverride: options.boardsOverride,
        warning: nextWarning,
      });
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      setStatus({ type: 'error', message: error.message });
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsBoardActionPending(false);
      }
    }
  }

  function applyLoadedBoard(nextBoard, options = {}) {
    window.clearTimeout(autosaveTimerRef.current);
    skipNextAutosaveRef.current = true;
    interactionRef.current = null;
    dragDepthRef.current = 0;
    localChangeVersionRef.current = 0;
    lastSavedVersionRef.current = 0;

    setIsDraggingFiles(false);
    setIsBoardsMenuOpen(false);
    setSelectedItemId(null);
    setMissingIds([]);
    setBoard(nextBoard);
    setCurrentBoardId(nextBoard.id);
    setBoards((currentBoards) => {
      const baseBoards = options.boardsOverride || currentBoards;
      return mergeBoardSummary(baseBoards, nextBoard);
    });
    replaceBoardIdInUrl(nextBoard.id);
    setStatus(options.warning ? { type: 'warning', message: options.warning } : null);
  }

  async function persistCurrentBoardNow() {
    const activeBoard = boardSnapshotRef.current;
    const activeBoardId = currentBoardIdRef.current;

    if (!activeBoard || !activeBoardId || !hasUnsavedChanges()) {
      return true;
    }

    window.clearTimeout(autosaveTimerRef.current);

    try {
      await saveBoardRequest(activeBoardId, activeBoard);
      lastSavedVersionRef.current = Math.max(lastSavedVersionRef.current, localChangeVersionRef.current);
      updateBoardSummary(activeBoard);
      return true;
    } catch (error) {
      setStatus({ type: 'error', message: `Autosave failed. ${error.message}` });
      return false;
    }
  }

  async function handleSwitchBoard(boardId) {
    if (!boardId || boardId === currentBoardId) {
      setIsBoardsMenuOpen(false);
      return;
    }

    const didPersist = await persistCurrentBoardNow();

    if (!didPersist) {
      return;
    }

    await openBoard(boardId, { loadingMessage: 'Loading board...' });
  }

  async function handleCreateBoard() {
    const didPersist = await persistCurrentBoardNow();

    if (!didPersist) {
      return;
    }

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: 'Creating board...' });

    try {
      const result = await createBoardRequest();
      applyLoadedBoard(result.board, { boardsOverride: result.boards });
      setTransientStatus({ type: 'saved', message: `${result.board.name} created` });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleClearBoard() {
    if (!board || !currentBoardId) {
      return;
    }

    const shouldClear = window.confirm(`Clear everything from ${board.name}?`);

    if (!shouldClear) {
      return;
    }

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: `Clearing ${board.name}...` });

    try {
      const result = await clearBoardRequest(currentBoardId);
      applyLoadedBoard(result.board);
      setTransientStatus({ type: 'saved', message: `${result.board.name} cleared` });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleDeleteBoard(boardId) {
    if (!boardId) {
      return;
    }

    const isDeletingCurrentBoard = boardId === currentBoardId;
    const boardSummary = boards.find((entry) => entry.id === boardId);
    const shouldDelete = window.confirm(
      isDeletingCurrentBoard
        ? `Delete ${boardSummary?.name || 'this board'}? A new blank board will open immediately.`
        : `Delete ${boardSummary?.name || 'this board'}?`,
    );

    if (!shouldDelete) {
      return;
    }

    if (!isDeletingCurrentBoard) {
      const didPersist = await persistCurrentBoardNow();

      if (!didPersist) {
        return;
      }
    }

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: 'Deleting board...' });

    try {
      const result = await deleteBoardRequest(boardId, currentBoardId);
      applyLoadedBoard(result.board, { boardsOverride: result.boards });
      setTransientStatus({
        type: 'saved',
        message: isDeletingCurrentBoard ? 'Board deleted. New board ready.' : 'Board deleted',
      });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);

    const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith('image/'));

    if (!files.length) {
      setStatus({ type: 'error', message: 'Only image files can be added to the board.' });
      return;
    }

    if (!board || !currentBoardId) {
      return;
    }

    try {
      setIsUploading(true);
      setStatus({ type: 'uploading', message: `Adding ${files.length} image${files.length === 1 ? '' : 's'}...` });

      const manifest = await Promise.all(files.map(loadImageMetadata));
      const result = await uploadImages(currentBoardId, files, manifest);

      startTransition(() => {
        setBoard((currentBoard) => {
          if (!currentBoard) {
            return currentBoard;
          }

          return appendAssetsToLayouts(
            currentBoard,
            result.assets,
            getBoardViewport(boardRef.current),
          );
        });
      });

      const newestItem = result.assets[result.assets.length - 1];
      setSelectedItemId(newestItem?.id || null);
      setTransientStatus({
        type: 'saved',
        message: `${files.length} image${files.length === 1 ? '' : 's'} added`,
      });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsUploading(false);
    }
  }

  function handleArrange(mode) {
    if (!board || mode === board.activeLayout) {
      return;
    }

    startTransition(() => {
      setBoard((currentBoard) => {
        if (!currentBoard) {
          return currentBoard;
        }

        return setActiveLayout(currentBoard, mode, getBoardViewport(boardRef.current));
      });
    });

    interactionRef.current = null;
    setSelectedItemId(null);
  }

  function handleDragState(event) {
    if (!containsFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
  }

  function handleDragEnter(event) {
    if (!containsFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragLeave(event) {
    if (!containsFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current -= 1;

    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
    }
  }

  function handleBackgroundPointerDown() {
    setSelectedItemId(null);
  }

  function startInteraction(event, item, mode) {
    event.preventDefault();
    event.stopPropagation();

    const lifted = liftItem(getLayoutItems(board), item.id);
    const activeItem = lifted.item || item;

    setSelectedItemId(item.id);

    if (lifted.didChange) {
      startTransition(() => {
        setBoard((currentBoard) => {
          if (!currentBoard) {
            return currentBoard;
          }

          return updateBoardLayoutItems(currentBoard, currentBoard.activeLayout, lifted.items);
        });
      });
    }

    const center = {
      x: activeItem.x + activeItem.width / 2,
      y: activeItem.y + activeItem.height / 2,
    };

    interactionRef.current = {
      mode,
      itemId: item.id,
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startItem: activeItem,
      center,
      startAngle: Math.atan2(event.clientY - center.y, event.clientX - center.x),
      startDistance: Math.max(1, Math.hypot(event.clientX - center.x, event.clientY - center.y)),
    };
  }

  function removeItem(itemId) {
    setSelectedItemId((currentId) => (currentId === itemId ? null : currentId));
    setMissingIds((currentIds) => currentIds.filter((id) => id !== itemId));

    startTransition(() => {
      setBoard((currentBoard) => {
        if (!currentBoard) {
          return currentBoard;
        }

        return removeAssetIdsFromBoard(currentBoard, [itemId]);
      });
    });
  }

  function markImageMissing(itemId, isMissing) {
    setMissingIds((currentIds) => {
      if (isMissing) {
        return currentIds.includes(itemId) ? currentIds : [...currentIds, itemId];
      }

      return currentIds.filter((id) => id !== itemId);
    });
  }

  function setTransientStatus(nextStatus) {
    window.clearTimeout(statusTimerRef.current);
    setStatus(nextStatus);

    statusTimerRef.current = window.setTimeout(() => {
      setStatus((currentStatus) => (currentStatus === nextStatus ? null : currentStatus));
    }, 1600);
  }

  function updateBoardSummary(nextBoard) {
    setBoards((currentBoards) => mergeBoardSummary(currentBoards, nextBoard));
  }

  function hasUnsavedChanges() {
    return localChangeVersionRef.current > lastSavedVersionRef.current;
  }

  const isBusy = isUploading || isBoardActionPending;
  const sortedItems = [...getVisibleItems(board)].sort((left, right) => left.zIndex - right.zIndex);

  return (
    <main className="app-shell">
      <div className="toolbar">
        <div className="toolbar__actions">
          <div ref={boardsMenuRef} className="boards-menu-anchor">
            <button
              className={`toolbar__button ${isBoardsMenuOpen ? 'is-active' : ''}`}
              type="button"
              onClick={() => setIsBoardsMenuOpen((currentValue) => !currentValue)}
            >
              Boards
            </button>

            {isBoardsMenuOpen ? (
              <div className="boards-menu">
                <div className="boards-menu__header">
                  <span className="boards-menu__eyebrow">Current board</span>
                  <strong>{board?.name || 'Loading...'}</strong>
                </div>

                <div className="boards-menu__actions">
                  <button
                    className="boards-menu__action"
                    type="button"
                    onClick={handleCreateBoard}
                    disabled={isBusy}
                  >
                    New Board
                  </button>
                  <button
                    className="boards-menu__action"
                    type="button"
                    onClick={handleClearBoard}
                    disabled={isBusy || !board}
                  >
                    Clear Board
                  </button>
                </div>

                <div className="boards-menu__list">
                  {boards.map((boardSummary) => (
                    <div
                      key={boardSummary.id}
                      className={`boards-menu__row ${boardSummary.id === currentBoardId ? 'is-active' : ''}`}
                    >
                      <button
                        className="boards-menu__board"
                        type="button"
                        onClick={() => handleSwitchBoard(boardSummary.id)}
                        disabled={isBusy}
                      >
                        <span>{boardSummary.name}</span>
                        <small>{boardSummary.itemCount} item{boardSummary.itemCount === 1 ? '' : 's'}</small>
                      </button>

                      <button
                        className="boards-menu__delete"
                        type="button"
                        aria-label={`Delete ${boardSummary.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteBoard(boardSummary.id);
                        }}
                        disabled={isBusy}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {ARRANGE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`toolbar__button ${board?.activeLayout === option.id ? 'is-active' : ''}`}
              type="button"
              onClick={() => handleArrange(option.id)}
              disabled={!board}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <section
        ref={boardRef}
        className={`board-surface ${isDraggingFiles ? 'is-dragging' : ''}`}
        onPointerDown={handleBackgroundPointerDown}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragState}
        onDrop={handleDrop}
      >
        {sortedItems.map((item) => {
          const isSelected = selectedItemId === item.id;
          const isMissing = missingIds.includes(item.id);

          return (
            <article
              key={item.id}
              className={`board-item ${isSelected ? 'is-selected' : ''} ${isMissing ? 'is-missing' : ''}`}
              style={{
                width: `${item.width}px`,
                height: `${item.height}px`,
                transform: `translate(${item.x}px, ${item.y}px) rotate(${item.rotation}deg)`,
                zIndex: item.zIndex,
              }}
              onPointerDown={(event) => startInteraction(event, item, 'drag')}
            >
              {isMissing ? (
                <div className="board-item__missing">
                  <span>Missing file</span>
                  <small>{item.fileName}</small>
                </div>
              ) : (
                <img
                  className="board-item__image"
                  src={item.src}
                  alt={item.fileName}
                  draggable="false"
                  onLoad={() => markImageMissing(item.id, false)}
                  onError={() => markImageMissing(item.id, true)}
                />
              )}

              {isSelected ? (
                <>
                  <button
                    className="item-control item-control--delete"
                    type="button"
                    aria-label={`Remove ${item.fileName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeItem(item.id);
                    }}
                  >
                    ×
                  </button>
                  <button
                    className="item-control item-control--rotate"
                    type="button"
                    aria-label={`Rotate ${item.fileName}`}
                    onPointerDown={(event) => startInteraction(event, item, 'rotate')}
                  />
                  <button
                    className="item-control item-control--resize"
                    type="button"
                    aria-label={`Resize ${item.fileName}`}
                    onPointerDown={(event) => startInteraction(event, item, 'resize')}
                  />
                </>
              ) : null}
            </article>
          );
        })}

        {board && countBoardAssets(board) === 0 ? (
          <div className="empty-state">
            <p>{board.name}</p>
            <span>Drop images anywhere.</span>
          </div>
        ) : null}

        {isDraggingFiles ? (
          <div className="drop-overlay">
            <div>
              <strong>Drop to scatter</strong>
              <span>Your images will land in the saved {board?.activeLayout || 'pile'} layout.</span>
            </div>
          </div>
        ) : null}
      </section>

      {status ? (
        <div className={`status-pill is-${status.type}`}>
          {status.message}
        </div>
      ) : null}
    </main>
  );
}

function getBoardViewport(boardElement) {
  const rect = boardElement?.getBoundingClientRect();

  return {
    width: rect?.width || window.innerWidth,
    height: rect?.height || window.innerHeight,
    paddingTop: TOOLBAR_PADDING_TOP,
  };
}

function containsFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

async function loadImageMetadata(file) {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file);
    const metadata = {
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
    };

    bitmap.close();
    return metadata;
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
      nextImage.src = objectUrl;
    });

    return {
      originalWidth: image.naturalWidth,
      originalHeight: image.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function liftItem(items, itemId) {
  const highestZIndex = getNextZIndex(items);
  let changed = false;
  let liftedItem = null;

  const liftedItems = items.map((item) => {
    if (item.id !== itemId) {
      return item;
    }

    const nextZIndex = item.zIndex >= highestZIndex ? item.zIndex : highestZIndex + 1;

    if (nextZIndex !== item.zIndex) {
      changed = true;
    }

    liftedItem = {
      ...item,
      zIndex: nextZIndex,
    };

    return liftedItem;
  });

  return {
    didChange: changed,
    item: liftedItem,
    items: liftedItems,
  };
}

function pickInitialBoardId(boards) {
  if (!Array.isArray(boards) || boards.length === 0) {
    return null;
  }

  const requestedBoardId = getBoardIdFromUrl();
  const requestedBoard = boards.find((board) => board.id === requestedBoardId);

  return requestedBoard?.id || boards[0].id;
}

function getBoardIdFromUrl() {
  const currentUrl = new URL(window.location.href);
  return currentUrl.searchParams.get('board');
}

function replaceBoardIdInUrl(boardId) {
  const currentUrl = new URL(window.location.href);

  if (boardId) {
    currentUrl.searchParams.set('board', boardId);
  } else {
    currentUrl.searchParams.delete('board');
  }

  window.history.replaceState({}, '', currentUrl);
}

function appendWarning(currentWarning, nextWarning) {
  if (currentWarning && nextWarning) {
    return `${currentWarning} ${nextWarning}`;
  }

  return currentWarning || nextWarning || null;
}

function mergeBoardSummary(boards, board) {
  const nextBoards = Array.isArray(boards) ? boards : [];
  const summary = toBoardSummary(board);

  return sortBoardSummaries([
    summary,
    ...nextBoards.filter((entry) => entry.id !== summary.id),
  ]);
}

function toBoardSummary(board) {
  return {
    id: board.id,
    name: board.name,
    updatedAt: board.updatedAt,
    itemCount: countBoardAssets(board),
  };
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(angle) {
  const wrapped = ((angle + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
