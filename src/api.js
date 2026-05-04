async function requestJson(url, options) {
  const response = await fetch(url, options);
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.message || 'The request could not be completed.');
  }

  return payload;
}

export function fetchBoards() {
  return requestJson('/api/boards');
}

export function createBoard() {
  return requestJson('/api/boards', {
    method: 'POST',
  });
}

export function fetchBoard(boardId) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}`);
}

export function uploadImages(boardId, files, manifest) {
  const formData = new FormData();

  files.forEach((file) => {
    formData.append('images', file);
  });

  formData.append('manifest', JSON.stringify(manifest));

  return requestJson(`/api/boards/${encodeURIComponent(boardId)}/uploads`, {
    method: 'POST',
    body: formData,
  });
}

export function saveBoard(boardId, board) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(board),
  });
}

export function clearBoard(boardId) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}/clear`, {
    method: 'POST',
  });
}

export function deleteBoard(boardId, currentBoardId) {
  const params = new URLSearchParams();

  if (currentBoardId) {
    params.set('currentBoardId', currentBoardId);
  }

  return requestJson(`/api/boards/${encodeURIComponent(boardId)}?${params.toString()}`, {
    method: 'DELETE',
  });
}
