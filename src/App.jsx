import { startTransition, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_UPLOAD_METADATA,
  validateUploadCandidate,
} from '../shared/uploadValidation.js';
import {
  clearBoard as clearBoardRequest,
  createBoard as createBoardRequest,
  deleteBoard as deleteBoardRequest,
  disableShare as disableShareRequest,
  enableShare as enableShareRequest,
  fetchBoard as fetchBoardRequest,
  fetchBoards,
  fetchSession,
  fetchSharedBoard,
  logout as logoutRequest,
  regenerateShare as regenerateShareRequest,
  requestMagicLink,
  saveBoard as saveBoardRequest,
  uploadImage,
} from './api';
import { ARRANGE_OPTIONS, getNextZIndex } from './arrange';
import {
  appendAssetsToLayouts,
  countBoardAssets,
  DEFAULT_LAYOUT_ID,
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
const UPLOAD_DONE_DISMISS_DELAY = 1400;
const UPLOAD_ERROR_DISMISS_DELAY = 4800;

export default function App() {
  const boardRef = useRef(null);
  const boardsMenuRef = useRef(null);
  const shareMenuRef = useRef(null);
  const dragDepthRef = useRef(0);
  const interactionRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const uploadCleanupTimersRef = useRef(new Map());
  const skipNextAutosaveRef = useRef(true);
  const boardSnapshotRef = useRef(null);
  const boardsRef = useRef([]);
  const currentBoardIdRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const localChangeVersionRef = useRef(0);
  const lastSavedVersionRef = useRef(0);

  const [route, setRoute] = useState(() => getCurrentRoute());
  const [sessionState, setSessionState] = useState({ isLoading: true, user: null });
  const [board, setBoard] = useState(null);
  const [sharedBoard, setSharedBoard] = useState(null);
  const [sharedLayoutId, setSharedLayoutId] = useState(DEFAULT_LAYOUT_ID);
  const [boards, setBoards] = useState([]);
  const [currentBoardId, setCurrentBoardId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [boardTitleDraft, setBoardTitleDraft] = useState('');
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [uploadItems, setUploadItems] = useState([]);
  const [isBoardActionPending, setIsBoardActionPending] = useState(false);
  const [isBoardsMenuOpen, setIsBoardsMenuOpen] = useState(false);
  const [isShareMenuOpen, setIsShareMenuOpen] = useState(false);
  const [missingIds, setMissingIds] = useState([]);
  const [status, setStatus] = useState({ type: 'loading', message: 'Checking session...' });
  const [email, setEmail] = useState('');
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [magicLinkState, setMagicLinkState] = useState({ sentTo: '', previewUrl: null, expiresAt: null });

  const isOwnerView = Boolean(sessionState.user) && route.type === 'board';
  const isSharedView = route.type === 'shared';
  const readOnly = isSharedView;
  const activeBoard = readOnly ? sharedBoard : board;
  const activeLayoutId = readOnly ? sharedLayoutId : activeBoard?.activeLayout;
  const visibleItems = getRenderableItems(activeBoard, activeLayoutId);
  const sortedItems = [...visibleItems].sort((left, right) => left.zIndex - right.zIndex);
  const isUploading = uploadItems.some((item) => item.status === 'queued' || item.status === 'uploading');
  const isBusy = isUploading || isBoardActionPending;

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
    setBoardTitleDraft(board?.name || '');
  }, [board?.id, board?.name]);

  useEffect(() => {
    function handlePopState() {
      setRoute(getCurrentRoute());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    let isCancelled = false;

    async function loadSession() {
      try {
        const result = await fetchSession();

        if (isCancelled) {
          return;
        }

        setSessionState({
          isLoading: false,
          user: result.user,
        });
        setStatus(null);
      } catch (error) {
        if (isCancelled) {
          return;
        }

        setSessionState({
          isLoading: false,
          user: null,
        });
        setStatus({ type: 'error', message: error.message });
      }
    }

    loadSession();

    return () => {
      isCancelled = true;
      loadRequestIdRef.current += 1;
      window.clearTimeout(autosaveTimerRef.current);
      window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => () => {
    for (const timerId of uploadCleanupTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }

    uploadCleanupTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (sessionState.isLoading) {
      setStatus({ type: 'loading', message: 'Checking session...' });
      return;
    }

    if (isSharedView) {
      if (sharedBoard && route.shareToken === getShareTokenFromBoard(sharedBoard)) {
        return;
      }

      void loadSharedRoute(route.shareToken);
      return;
    }

    setSharedBoard(null);
    setSharedLayoutId(DEFAULT_LAYOUT_ID);

    if (!sessionState.user) {
      clearOwnerWorkspace();
      setStatus(route.authError ? { type: 'error', message: route.authError } : null);
      return;
    }

    if (route.type === 'board' && board?.id === route.boardId && currentBoardId === route.boardId) {
      return;
    }

    void loadOwnerRoute();
  }, [
    sessionState.isLoading,
    sessionState.user,
    route.type,
    route.boardId,
    route.shareToken,
    route.authError,
  ]);

  useEffect(() => {
    function handlePointerMove(event) {
      if (!isOwnerView) {
        return;
      }

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
  }, [isOwnerView]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!isOwnerView || !selectedItemId || isTypingTarget(event.target)) {
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
  }, [isOwnerView, selectedItemId]);

  useEffect(() => {
    if (!isBoardsMenuOpen && !isShareMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (isBoardsMenuOpen && !boardsMenuRef.current?.contains(event.target)) {
        setIsBoardsMenuOpen(false);
      }

      if (isShareMenuOpen && !shareMenuRef.current?.contains(event.target)) {
        setIsShareMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsBoardsMenuOpen(false);
        setIsShareMenuOpen(false);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isBoardsMenuOpen, isShareMenuOpen]);

  useEffect(() => {
    if (!isOwnerView || !board || !currentBoardId) {
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
        setTransientStatus({ type: 'saved', message: 'Saved' });
      } catch (error) {
        setStatus({ type: 'error', message: `Autosave failed. ${error.message}` });
      }
    }, AUTOSAVE_DELAY);

    return () => window.clearTimeout(autosaveTimerRef.current);
  }, [board, currentBoardId, isOwnerView]);

  async function loadOwnerRoute() {
    const requestId = ++loadRequestIdRef.current;

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: 'Loading boards...' });

    try {
      const result = await fetchBoards();

      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      const targetBoardId = pickInitialBoardId(result.boards, route.boardId);

      if (!targetBoardId) {
        setStatus({ type: 'error', message: 'No boards were available to load.' });
        return;
      }

      if (route.type !== 'board' || route.boardId !== targetBoardId) {
        navigateTo(toBoardPath(targetBoardId), { replace: true });
        return;
      }

      await openBoard(targetBoardId, {
        boardsOverride: result.boards,
        loadingMessage: 'Loading board...',
        historyMode: 'replace',
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

  async function loadSharedRoute(shareToken) {
    if (!shareToken) {
      setStatus({ type: 'error', message: 'That shared board link is missing.' });
      setSharedBoard(null);
      return;
    }

    const requestId = ++loadRequestIdRef.current;

    setIsBoardActionPending(true);
    setStatus({ type: 'loading', message: 'Loading shared board...' });

    try {
      const result = await fetchSharedBoard(shareToken);

      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      const prepared = prepareBoardForClient(result.board, getBoardViewport(boardRef.current));
      interactionRef.current = null;
      dragDepthRef.current = 0;
      setBoard(null);
      setBoards([]);
      setCurrentBoardId(null);
      setIsDraggingFiles(false);
      setIsBoardsMenuOpen(false);
      setIsShareMenuOpen(false);
      setSelectedItemId(null);
      setMissingIds([]);
      clearUploadIndicators();
      setSharedBoard(prepared.board);
      setSharedLayoutId(prepared.board.activeLayout || DEFAULT_LAYOUT_ID);
      setStatus(null);
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }

      setSharedBoard(null);
      setStatus({ type: 'error', message: error.message });
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsBoardActionPending(false);
      }
    }
  }

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
        historyMode: options.historyMode || 'none',
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
    setIsShareMenuOpen(false);
    setSelectedItemId(null);
    setMissingIds([]);
    clearUploadIndicators();
    setSharedBoard(null);
    setBoard(nextBoard);
    setCurrentBoardId(nextBoard.id);
    setBoards((currentBoards) => {
      const baseBoards = options.boardsOverride || currentBoards;
      return mergeBoardSummary(baseBoards, nextBoard);
    });

    if (options.historyMode === 'push') {
      navigateTo(toBoardPath(nextBoard.id), { replace: false });
    } else if (options.historyMode === 'replace') {
      navigateTo(toBoardPath(nextBoard.id), { replace: true });
    }

    setStatus(options.warning ? { type: 'warning', message: options.warning } : null);
  }

  function applyServerBoardUpdate(nextBoard, options = {}) {
    window.clearTimeout(autosaveTimerRef.current);
    skipNextAutosaveRef.current = true;
    localChangeVersionRef.current = 0;
    lastSavedVersionRef.current = 0;

    setBoard(nextBoard);
    setBoards((currentBoards) => mergeBoardSummary(currentBoards, nextBoard));

    if (options.message) {
      setTransientStatus({ type: 'saved', message: options.message });
    }
  }

  async function persistCurrentBoardNow() {
    const activeBoardSnapshot = boardSnapshotRef.current;
    const activeBoardId = currentBoardIdRef.current;

    if (!isOwnerView || !activeBoardSnapshot || !activeBoardId || !hasUnsavedChanges()) {
      return true;
    }

    window.clearTimeout(autosaveTimerRef.current);

    try {
      await saveBoardRequest(activeBoardId, activeBoardSnapshot);
      lastSavedVersionRef.current = Math.max(lastSavedVersionRef.current, localChangeVersionRef.current);
      updateBoardSummary(activeBoardSnapshot);
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

    await openBoard(boardId, {
      loadingMessage: 'Loading board...',
      historyMode: 'push',
    });
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
      applyLoadedBoard(result.board, {
        boardsOverride: result.boards,
        historyMode: 'push',
      });
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
      applyLoadedBoard(result.board, { historyMode: 'replace' });
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
      applyLoadedBoard(result.board, {
        boardsOverride: result.boards,
        historyMode: 'replace',
      });
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
    if (!isOwnerView) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);

    const files = Array.from(event.dataTransfer.files || []);

    if (!files.length) {
      return;
    }

    if (!board || !currentBoardId) {
      return;
    }

    const uploadBatch = files.map((file) => ({
      entryId: crypto.randomUUID(),
      file,
    }));

    setUploadItems((currentItems) => [
      ...currentItems,
      ...uploadBatch.map(({ entryId, file }) => createUploadItem(entryId, file.name)),
    ]);

    const validUploads = [];
    let rejectedCount = 0;

    for (const batchEntry of uploadBatch) {
      const validation = validateUploadCandidate({
        fileName: batchEntry.file.name,
        mimeType: batchEntry.file.type,
        size: batchEntry.file.size,
      });

      if (!validation.ok) {
        rejectedCount += 1;
        updateUploadItem(batchEntry.entryId, {
          status: 'error',
          errorMessage: validation.message,
        });
        scheduleUploadItemRemoval(batchEntry.entryId, UPLOAD_ERROR_DISMISS_DELAY);
        continue;
      }

      validUploads.push(batchEntry);
    }

    if (!validUploads.length) {
      setStatus({
        type: 'error',
        message: rejectedCount === 1 ? 'That file could not be added.' : 'Those files could not be added.',
      });
      return;
    }

    try {
      const manifests = await Promise.all(validUploads.map(({ file }) => loadImageMetadata(file)));
      const results = await Promise.all(validUploads.map(async (batchEntry, index) => {
        updateUploadItem(batchEntry.entryId, {
          status: 'uploading',
          progress: 0,
          errorMessage: '',
        });

        try {
          const result = await uploadImage(currentBoardId, batchEntry.file, manifests[index], {
            onProgress: (progress) => {
              updateUploadItem(batchEntry.entryId, {
                status: 'uploading',
                progress,
              });
            },
          });
          const asset = result?.assets?.[0];

          if (!asset) {
            throw new Error('The image upload finished without returning a new board item.');
          }

          updateUploadItem(batchEntry.entryId, {
            status: 'done',
            progress: 100,
          });
          scheduleUploadItemRemoval(batchEntry.entryId, UPLOAD_DONE_DISMISS_DELAY);

          startTransition(() => {
            setBoard((currentBoard) => {
              if (!currentBoard) {
                return currentBoard;
              }

              return appendAssetsToLayouts(
                currentBoard,
                [asset],
                getBoardViewport(boardRef.current),
              );
            });
          });

          return { ok: true, asset };
        } catch (error) {
          updateUploadItem(batchEntry.entryId, {
            status: 'error',
            errorMessage: error.message,
          });
          scheduleUploadItemRemoval(batchEntry.entryId, UPLOAD_ERROR_DISMISS_DELAY);

          return { ok: false, error };
        }
      }));
      const successfulAssets = results
        .filter((result) => result.ok)
        .map((result) => result.asset);

      if (successfulAssets.length > 0) {
        setSelectedItemId(successfulAssets[successfulAssets.length - 1].id);
        setTransientStatus({
          type: 'saved',
          message: `${successfulAssets.length} image${successfulAssets.length === 1 ? '' : 's'} added`,
        });
      } else {
        setStatus({ type: 'error', message: 'No images were added. Check the upload errors and try again.' });
      }
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    }
  }

  function handleArrange(mode) {
    if (readOnly) {
      setSharedLayoutId(mode);
      return;
    }

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
    if (!isOwnerView || !containsFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragLeave(event) {
    if (!isOwnerView || !containsFiles(event.dataTransfer)) {
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
    if (!readOnly) {
      setSelectedItemId(null);
    }
  }

  function startInteraction(event, item, mode) {
    if (readOnly || !board) {
      return;
    }

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

  function handleBoardTitleCommit() {
    if (!board) {
      return;
    }

    const nextName = normalizeBoardTitle(boardTitleDraft, board, boards);
    setBoardTitleDraft(nextName);

    if (nextName === board.name) {
      return;
    }

    startTransition(() => {
      setBoard((currentBoard) => {
        if (!currentBoard) {
          return currentBoard;
        }

        return {
          ...currentBoard,
          name: nextName,
        };
      });
    });
  }

  function handleBoardTitleKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setBoardTitleDraft(board?.name || '');
      event.currentTarget.blur();
    }
  }

  function updateUploadItem(entryId, patch) {
    setUploadItems((currentItems) => currentItems.map((item) => (
      item.id === entryId
        ? { ...item, ...patch }
        : item
    )));
  }

  function scheduleUploadItemRemoval(entryId, delay) {
    const currentTimerId = uploadCleanupTimersRef.current.get(entryId);

    if (currentTimerId) {
      window.clearTimeout(currentTimerId);
    }

    const nextTimerId = window.setTimeout(() => {
      uploadCleanupTimersRef.current.delete(entryId);
      setUploadItems((currentItems) => currentItems.filter((item) => item.id !== entryId));
    }, delay);

    uploadCleanupTimersRef.current.set(entryId, nextTimerId);
  }

  function clearUploadIndicators() {
    for (const timerId of uploadCleanupTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }

    uploadCleanupTimersRef.current.clear();
    setUploadItems([]);
  }

  function hasUnsavedChanges() {
    return localChangeVersionRef.current > lastSavedVersionRef.current;
  }

  async function handleSendMagicLink(event) {
    event.preventDefault();

    if (!email.trim()) {
      setStatus({ type: 'error', message: 'Enter your email to continue.' });
      return;
    }

    setIsSendingMagicLink(true);
    setStatus({ type: 'loading', message: 'Sending magic link...' });

    try {
      const result = await requestMagicLink(email, getRedirectPathForRoute(route));
      setMagicLinkState({
        sentTo: email.trim(),
        previewUrl: result.previewUrl,
        expiresAt: result.expiresAt,
      });
      setStatus(null);
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsSendingMagicLink(false);
    }
  }

  async function handleLogout() {
    await persistCurrentBoardNow();
    setIsBoardActionPending(true);

    try {
      await logoutRequest();
      clearOwnerWorkspace();
      setSessionState({ isLoading: false, user: null });
      navigateTo('/', { replace: false });
      setStatus(null);
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleEnableShare() {
    if (!currentBoardId) {
      return;
    }

    setIsBoardActionPending(true);

    try {
      const result = await enableShareRequest(currentBoardId);
      applyServerBoardUpdate(result.board, { message: 'Share link ready' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleDisableShare() {
    if (!currentBoardId) {
      return;
    }

    setIsBoardActionPending(true);

    try {
      const result = await disableShareRequest(currentBoardId);
      applyServerBoardUpdate(result.board, { message: 'Share link disabled' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleRegenerateShare() {
    if (!currentBoardId) {
      return;
    }

    setIsBoardActionPending(true);

    try {
      const result = await regenerateShareRequest(currentBoardId);
      applyServerBoardUpdate(result.board, { message: 'Share link refreshed' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message });
    } finally {
      setIsBoardActionPending(false);
    }
  }

  async function handleCopyShareLink() {
    const shareUrl = board?.sharing?.shareUrl;

    if (!shareUrl) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        window.prompt('Copy this share link', shareUrl);
      }

      setTransientStatus({ type: 'saved', message: 'Share link copied' });
    } catch {
      window.prompt('Copy this share link', shareUrl);
    }
  }

  function clearOwnerWorkspace() {
    window.clearTimeout(autosaveTimerRef.current);
    skipNextAutosaveRef.current = true;
    interactionRef.current = null;
    dragDepthRef.current = 0;
    localChangeVersionRef.current = 0;
    lastSavedVersionRef.current = 0;
    setBoard(null);
    setBoards([]);
    setCurrentBoardId(null);
    setSelectedItemId(null);
    setMissingIds([]);
    setIsBoardsMenuOpen(false);
    setIsShareMenuOpen(false);
    setIsDraggingFiles(false);
    clearUploadIndicators();
  }

  if (!sessionState.isLoading && !sessionState.user && !isSharedView) {
    return (
      <main className="app-shell app-shell--login">
        <section className="login-panel">
          <div className="login-panel__copy">
            <span className="login-panel__eyebrow">Moodboard</span>
            <h1>Sign in with a magic link</h1>
            <p>Your boards stay private until you share a read-only link.</p>
          </div>

          <form className="login-form" onSubmit={handleSendMagicLink}>
            <label className="login-form__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="login-form__input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={isSendingMagicLink}
            />
            <button className="login-form__button" type="submit" disabled={isSendingMagicLink}>
              {isSendingMagicLink ? 'Sending...' : 'Send Magic Link'}
            </button>
          </form>

          {magicLinkState.sentTo ? (
            <div className="login-panel__note">
              <strong>Check your inbox for {magicLinkState.sentTo}.</strong>
              <span>The sign-in link expires at {formatShortTimestamp(magicLinkState.expiresAt)}.</span>
              {magicLinkState.previewUrl ? (
                <a className="login-panel__link" href={magicLinkState.previewUrl}>
                  Open the local preview link
                </a>
              ) : null}
            </div>
          ) : (
            <div className="login-panel__note">
              <span>Use the same email any time and we’ll send a fresh sign-in link.</span>
            </div>
          )}

          {status ? (
            <p className={`login-panel__status is-${status.type}`}>{status.message}</p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className={`app-shell ${readOnly ? 'app-shell--readonly' : ''}`}>
      <div className="toolbar">
        <div className="toolbar__actions">
          {isOwnerView ? (
            <>
              <div ref={shareMenuRef} className="boards-menu-anchor">
                <button
                  className={`toolbar__button ${isShareMenuOpen ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => {
                    setIsBoardsMenuOpen(false);
                    setIsShareMenuOpen((currentValue) => !currentValue);
                  }}
                >
                  Share
                </button>

                {isShareMenuOpen ? (
                  <div className="boards-menu share-menu">
                    <div className="boards-menu__header">
                      <span className="boards-menu__eyebrow">Read-only link</span>
                      <strong>{board?.sharing?.enabled ? 'Sharing enabled' : 'Private board'}</strong>
                    </div>

                    {board?.sharing?.enabled ? (
                      <>
                        <p className="share-menu__url">{board.sharing.shareUrl}</p>
                        <div className="boards-menu__actions">
                          <button
                            className="boards-menu__action"
                            type="button"
                            onClick={handleCopyShareLink}
                            disabled={isBusy}
                          >
                            Copy Link
                          </button>
                          <button
                            className="boards-menu__action"
                            type="button"
                            onClick={handleRegenerateShare}
                            disabled={isBusy}
                          >
                            Regenerate Link
                          </button>
                          <button
                            className="boards-menu__action"
                            type="button"
                            onClick={handleDisableShare}
                            disabled={isBusy}
                          >
                            Disable Link
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="boards-menu__actions">
                        <button
                          className="boards-menu__action"
                          type="button"
                          onClick={handleEnableShare}
                          disabled={isBusy || !board}
                        >
                          Create Share Link
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div ref={boardsMenuRef} className="boards-menu-anchor">
                <button
                  className={`toolbar__button ${isBoardsMenuOpen ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => {
                    setIsShareMenuOpen(false);
                    setIsBoardsMenuOpen((currentValue) => !currentValue);
                  }}
                >
                  Boards
                </button>

                {isBoardsMenuOpen ? (
                  <div className="boards-menu">
                    <div className="boards-menu__header">
                      <span className="boards-menu__eyebrow">Current board</span>
                      <input
                        className="boards-menu__title-input"
                        type="text"
                        value={boardTitleDraft}
                        onChange={(event) => setBoardTitleDraft(event.target.value)}
                        onBlur={handleBoardTitleCommit}
                        onKeyDown={handleBoardTitleKeyDown}
                        placeholder="Board name"
                        disabled={isBusy || !board}
                        aria-label="Board title"
                      />
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
                      <button
                        className="boards-menu__action"
                        type="button"
                        onClick={handleLogout}
                        disabled={isBusy}
                      >
                        Log Out
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
            </>
          ) : null}

          {ARRANGE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`toolbar__button ${activeLayoutId === option.id ? 'is-active' : ''}`}
              type="button"
              onClick={() => handleArrange(option.id)}
              disabled={!activeBoard}
            >
              {option.label}
            </button>
          ))}

          {isSharedView && !sessionState.user ? (
            <button
              className="toolbar__button"
              type="button"
              onClick={() => navigateTo('/', { replace: false })}
            >
              Sign In
            </button>
          ) : null}
        </div>
      </div>

      <section
        ref={boardRef}
        className={`board-surface ${isDraggingFiles ? 'is-dragging' : ''} ${readOnly ? 'is-readonly' : ''}`}
        onPointerDown={handleBackgroundPointerDown}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragState}
        onDrop={handleDrop}
      >
        {isSharedView ? (
          <div className="readonly-pill">Read only</div>
        ) : null}

        {sortedItems.map((item) => {
          const isSelected = !readOnly && selectedItemId === item.id;
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
              onPointerDown={readOnly ? undefined : (event) => startInteraction(event, item, 'drag')}
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

        {activeBoard && countBoardAssets(activeBoard) === 0 ? (
          <div className="empty-state">
            <p>{activeBoard.name}</p>
            <span>{readOnly ? 'This shared board is empty.' : 'Drop images anywhere.'}</span>
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

      {uploadItems.length > 0 ? (
        <div className="upload-panel" aria-live="polite">
          {uploadItems.map((item) => (
            <div key={item.id} className={`upload-panel__item is-${item.status}`}>
              <div className="upload-panel__header">
                <span className="upload-panel__name">{item.fileName}</span>
                <span className="upload-panel__status">{getUploadItemStatusLabel(item)}</span>
              </div>
              <div className="upload-panel__track">
                <div
                  className="upload-panel__fill"
                  style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}
                />
              </div>
              {item.errorMessage ? (
                <small className="upload-panel__error">{item.errorMessage}</small>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {status ? (
        <div className={`status-pill is-${status.type}`}>
          {status.message}
        </div>
      ) : null}
    </main>
  );
}

function getRenderableItems(board, layoutId) {
  if (!board) {
    return [];
  }

  if (!layoutId || board.activeLayout === layoutId) {
    return getVisibleItems(board);
  }

  const assetsById = new Map((board.assets || []).map((asset) => [asset.id, asset]));

  return getLayoutItems(board, layoutId)
    .map((item) => {
      const asset = assetsById.get(item.id);
      return asset ? { ...asset, ...item } : null;
    })
    .filter(Boolean);
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
    try {
      const bitmap = await createImageBitmap(file);
      const metadata = {
        originalWidth: bitmap.width,
        originalHeight: bitmap.height,
      };

      bitmap.close();
      return metadata;
    } catch {
      // Fall through to the Image-based path below.
    }
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
  } catch {
    return { ...DEFAULT_UPLOAD_METADATA };
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

function getCurrentRoute() {
  const currentUrl = new URL(window.location.href);
  const normalizedPath = currentUrl.pathname.replace(/\/+$/, '') || '/';
  const boardMatch = /^\/boards\/([^/]+)$/.exec(normalizedPath);
  const sharedMatch = /^\/shared\/([^/]+)$/.exec(normalizedPath);

  if (boardMatch) {
    return {
      type: 'board',
      boardId: decodeURIComponent(boardMatch[1]),
      authError: currentUrl.searchParams.get('authError'),
    };
  }

  if (sharedMatch) {
    return {
      type: 'shared',
      shareToken: decodeURIComponent(sharedMatch[1]),
      authError: currentUrl.searchParams.get('authError'),
    };
  }

  return {
    type: 'root',
    authError: currentUrl.searchParams.get('authError'),
  };
}

function navigateTo(pathname, options = {}) {
  const currentUrl = new URL(window.location.href);
  const nextUrl = new URL(pathname, currentUrl.origin);

  if (nextUrl.pathname === currentUrl.pathname && nextUrl.search === currentUrl.search) {
    return;
  }

  if (options.replace) {
    window.history.replaceState({}, '', nextUrl);
  } else {
    window.history.pushState({}, '', nextUrl);
  }

  window.dispatchEvent(new PopStateEvent('popstate'));
}

function toBoardPath(boardId) {
  return `/boards/${encodeURIComponent(boardId)}`;
}

function pickInitialBoardId(boards, requestedBoardId) {
  if (!Array.isArray(boards) || boards.length === 0) {
    return null;
  }

  const requestedBoard = boards.find((entry) => entry.id === requestedBoardId);
  return requestedBoard?.id || boards[0].id;
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
    sharing: board.sharing,
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

function getRedirectPathForRoute(route) {
  if (route.type === 'board') {
    return `/boards/${encodeURIComponent(route.boardId)}`;
  }

  if (route.type === 'shared') {
    return `/shared/${encodeURIComponent(route.shareToken)}`;
  }

  return '/';
}

function getShareTokenFromBoard(board) {
  const shareUrl = board?.sharing?.shareUrl;

  if (typeof shareUrl !== 'string') {
    return null;
  }

  const match = /\/shared\/([^/?#]+)/.exec(shareUrl);
  return match ? decodeURIComponent(match[1]) : null;
}

function formatShortTimestamp(value) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return 'soon';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
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

function createUploadItem(id, fileName) {
  return {
    id,
    fileName: fileName || 'Untitled image',
    progress: 0,
    status: 'queued',
    errorMessage: '',
  };
}

function getUploadItemStatusLabel(item) {
  if (item.status === 'done') {
    return 'Done';
  }

  if (item.status === 'error') {
    return 'Error';
  }

  if (item.status === 'uploading') {
    return `${Math.max(0, Math.min(100, Math.round(item.progress)))}%`;
  }

  return 'Queued';
}

function normalizeBoardTitle(value, board, boards) {
  const trimmed = typeof value === 'string' ? value.trim() : '';

  if (trimmed) {
    return trimmed;
  }

  return getDefaultBoardNameForClient(board, boards);
}

function getDefaultBoardNameForClient(board, boards) {
  const currentName = board?.name || '';
  const currentMatch = /^Board\s+(\d+)$/i.exec(currentName);

  if (currentMatch) {
    return `Board ${currentMatch[1]}`;
  }

  const highestBoardNumber = (Array.isArray(boards) ? boards : []).reduce((highest, boardSummary) => {
    const match = /^Board\s+(\d+)$/i.exec(boardSummary?.name || '');
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);

  return `Board ${highestBoardNumber + 1}`;
}
