async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.message || 'The request could not be completed.');
  }

  return payload;
}

export function fetchSession() {
  return requestJson('/api/session');
}

export function requestMagicLink(email, redirectPath) {
  return requestJson('/api/auth/magic-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, redirectPath }),
  });
}

export function logout() {
  return requestJson('/api/auth/logout', {
    method: 'POST',
  });
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

export function fetchSharedBoard(shareToken) {
  return requestJson(`/api/shared/${encodeURIComponent(shareToken)}`);
}

export function uploadImage(boardId, file, manifest, options = {}) {
  const formData = new FormData();
  formData.append('images', file);
  formData.append('manifest', JSON.stringify([manifest]));

  return requestUploadJson(`/api/boards/${encodeURIComponent(boardId)}/uploads`, {
    body: formData,
    onProgress: options.onProgress,
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

  const query = params.toString();

  return requestJson(`/api/boards/${encodeURIComponent(boardId)}${query ? `?${query}` : ''}`, {
    method: 'DELETE',
  });
}

export function enableShare(boardId) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}/share`, {
    method: 'POST',
  });
}

export function disableShare(boardId) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}/share`, {
    method: 'DELETE',
  });
}

export function regenerateShare(boardId) {
  return requestJson(`/api/boards/${encodeURIComponent(boardId)}/share/regenerate`, {
    method: 'POST',
  });
}

function requestUploadJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open(options.method || 'POST', url);
    xhr.responseType = 'text';
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      if (!options.onProgress || !event.lengthComputable) {
        return;
      }

      const nextProgress = Math.min(100, Math.round((event.loaded / event.total) * 100));
      options.onProgress(nextProgress);
    });

    xhr.addEventListener('load', () => {
      const payload = parseJsonResponse(xhr.responseText);

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload?.message || 'The upload could not be completed.'));
    });

    xhr.addEventListener('error', () => {
      reject(new Error('The upload could not be completed.'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('The upload was interrupted.'));
    });

    xhr.send(options.body);
  });
}

function parseJsonResponse(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
