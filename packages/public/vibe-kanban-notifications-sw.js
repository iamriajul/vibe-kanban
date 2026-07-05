const DB_NAME = 'vibe-kanban-notifications';
const DB_VERSION = 1;
const DEDUPE_STORE = 'dedupe';
const STATE_STORE = 'workspace-state';
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEDUPE_STORE)) {
        db.createObjectStore(DEDUPE_STORE);
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let callbackResult;

      tx.oncomplete = () => resolve(callbackResult);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);

      callbackResult = callback(store);
    });
  } finally {
    db.close();
  }
}

function getValue(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putValue(store, key, value) {
  return new Promise((resolve, reject) => {
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteValue(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function claimWorkspaceAttentionEvent(payload) {
  const now = Date.now();
  const stateKey = `${payload.scopeKey}:${payload.workspaceId}`;
  const eventKey = `${stateKey}:${payload.attentionVersion}`;

  return withStore(DEDUPE_STORE, 'readwrite', async (store) => {
    const existingEvent = await getValue(store, eventKey);
    if (existingEvent && now - existingEvent.createdAt < DEDUPE_TTL_MS) {
      return false;
    }

    await putValue(store, eventKey, { createdAt: now });
    return true;
  }).then(async (claimed) => {
    if (!claimed) {
      return false;
    }

    await withStore(STATE_STORE, 'readwrite', async (store) => {
      await putValue(store, stateKey, {
        needsAttention: true,
        attentionVersion: payload.attentionVersion,
        updatedAt: now,
      });
    });

    return true;
  });
}

async function updateWorkspaceAttentionState(payload) {
  const stateKey = `${payload.scopeKey}:${payload.workspaceId}`;

  await withStore(STATE_STORE, 'readwrite', async (store) => {
    if (payload.needsAttention) {
      await putValue(store, stateKey, {
        needsAttention: true,
        attentionVersion: payload.attentionVersion,
        updatedAt: Date.now(),
      });
    } else {
      await deleteValue(store, stateKey);
    }
  });
}

async function postSoundToOneClient(payload) {
  const clientList = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  const target =
    clientList.find((client) => client.focused) ?? clientList[0] ?? null;

  if (!target) {
    return;
  }

  target.postMessage({
    type: 'WORKSPACE_ATTENTION_PLAY_SOUND',
    soundUrl: payload.soundUrl,
    eventId: payload.eventId,
  });
}

function normalizePushPayload(event) {
  if (!event.data) {
    return null;
  }

  try {
    return event.data.json();
  } catch {
    return null;
  }
}

async function showWorkspaceAttentionPush(payload) {
  if (!payload || payload.type !== 'workspace_attention') {
    return;
  }

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/favicon.png',
    tag: payload.event_id,
    data: {
      deeplinkPath: payload.deeplink_path,
    },
  });

  if (payload.sound_url) {
    await postSoundToOneClient({
      soundUrl: payload.sound_url,
      eventId: payload.event_id,
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'WORKSPACE_ATTENTION_STATE') {
    event.waitUntil(updateWorkspaceAttentionState(message.payload));
    return;
  }

  if (message.type !== 'WORKSPACE_ATTENTION_EVENT') {
    return;
  }

  event.waitUntil(
    (async () => {
      const payload = message.payload;
      const claimed = await claimWorkspaceAttentionEvent(payload);
      if (!claimed) {
        return;
      }

      if (payload.showNotification) {
        await self.registration.showNotification(payload.title, {
          body: payload.body,
          icon: '/favicon.png',
          tag: payload.eventId,
          data: {
            deeplinkPath: payload.deeplinkPath,
          },
        });
      }

      if (payload.soundUrl) {
        await postSoundToOneClient(payload);
      }
    })()
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(showWorkspaceAttentionPush(normalizePushPayload(event)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const deeplinkPath = event.notification.data?.deeplinkPath ?? '/';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          client.postMessage({
            type: 'WORKSPACE_ATTENTION_OPEN',
            deeplinkPath,
          });
          return;
        }
      }

      await self.clients.openWindow(deeplinkPath);
    })()
  );
});
