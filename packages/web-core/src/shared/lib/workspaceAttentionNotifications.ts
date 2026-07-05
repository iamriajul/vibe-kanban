import { playSound } from '@/shared/lib/utils';
import { SoundFile } from 'shared/types';

const SERVICE_WORKER_URL = '/vibe-kanban-notifications-sw.js';
const SOUND_DEDUPE_PREFIX = 'vibe-kanban.workspace-attention.sound';
const SOUND_DEDUPE_TTL_MS = 60 * 1000;
const DEFAULT_NOTIFICATION_SOUND = SoundFile.ABSTRACT_SOUND1;

export interface WorkspaceAttentionNotificationPayload {
  eventId: string;
  scopeKey: string;
  workspaceId: string;
  attentionVersion: string;
  title: string;
  body: string;
  deeplinkPath: string;
  showNotification: boolean;
  soundUrl?: string;
}

interface WorkspaceAttentionStatePayload {
  scopeKey: string;
  workspaceId: string;
  needsAttention: boolean;
  attentionVersion: string;
}

interface WebPushConfig {
  enabled: boolean;
  public_key: string;
}

function supportsNotificationWorker(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'Notification' in window
  );
}

function hasGrantedNotificationPermission(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
  );
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output.buffer;
}

async function readApiData<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message ?? 'Request failed');
  }

  return result.data as T;
}

export async function getWorkspaceNotificationWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!supportsNotificationWorker()) {
    return null;
  }

  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing?.active?.scriptURL.endsWith(SERVICE_WORKER_URL)) {
      return existing;
    }

    const registration = await navigator.serviceWorker.register(
      SERVICE_WORKER_URL,
      { scope: '/' }
    );
    await navigator.serviceWorker.ready;
    return registration;
  } catch (error) {
    console.warn('Failed to register notification service worker:', error);
    return null;
  }
}

export async function subscribeToWorkspaceAttentionPush(): Promise<boolean> {
  if (!hasGrantedNotificationPermission()) {
    return false;
  }

  const registration = await getWorkspaceNotificationWorkerRegistration();
  if (!registration || !('PushManager' in window)) {
    return false;
  }

  try {
    const config = await readApiData<WebPushConfig>(
      await fetch('/api/web-push/config')
    );
    if (!config.enabled || !config.public_key) {
      return false;
    }

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(config.public_key),
      }));

    await fetch('/api/web-push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    }).then((response) => readApiData<void>(response));

    return true;
  } catch (error) {
    console.warn('Failed to subscribe to workspace attention push:', error);
    return false;
  }
}

export async function unsubscribeFromWorkspaceAttentionPush(): Promise<void> {
  const registration = await getWorkspaceNotificationWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    return;
  }

  try {
    await fetch('/api/web-push/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    }).then((response) => readApiData<void>(response));
  } catch (error) {
    console.warn('Failed to delete workspace attention push subscription:', error);
  }

  await subscription.unsubscribe();
}

async function postToNotificationWorker(message: unknown): Promise<boolean> {
  const registration = await getWorkspaceNotificationWorkerRegistration();
  const worker =
    registration?.active ?? registration?.waiting ?? registration?.installing;

  if (!worker) {
    return false;
  }

  worker.postMessage(message);
  return true;
}

export async function notifyWorkspaceAttention(
  payload: WorkspaceAttentionNotificationPayload
): Promise<boolean> {
  return postToNotificationWorker({
    type: 'WORKSPACE_ATTENTION_EVENT',
    payload,
  });
}

export async function syncWorkspaceAttentionState(
  payload: WorkspaceAttentionStatePayload
): Promise<boolean> {
  return postToNotificationWorker({
    type: 'WORKSPACE_ATTENTION_STATE',
    payload,
  });
}

export function playWorkspaceAttentionNotificationSoundPreview(
  soundFile: SoundFile = DEFAULT_NOTIFICATION_SOUND
): void {
  void playSound(`/api/sounds/${soundFile}`).catch((error) => {
    console.warn('Failed to unlock workspace attention notification sound:', error);
  });
}

function shouldPlaySound(eventId: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const storageKey = `${SOUND_DEDUPE_PREFIX}.${eventId}`;
  const now = Date.now();
  const previous = Number(window.localStorage.getItem(storageKey) ?? '0');

  if (Number.isFinite(previous) && now - previous < SOUND_DEDUPE_TTL_MS) {
    return false;
  }

  window.localStorage.setItem(storageKey, String(now));
  return true;
}

export function subscribeToWorkspaceAttentionServiceWorkerMessages() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }

  const handleMessage = (event: MessageEvent) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'WORKSPACE_ATTENTION_OPEN') {
      const deeplinkPath = String(message.deeplinkPath ?? '');
      if (deeplinkPath) {
        window.location.assign(deeplinkPath);
      }
      return;
    }

    if (message.type !== 'WORKSPACE_ATTENTION_PLAY_SOUND') {
      return;
    }

    const eventId = String(message.eventId ?? '');
    const soundUrl = String(message.soundUrl ?? '');
    if (!eventId || !soundUrl || !shouldPlaySound(eventId)) {
      return;
    }

    void playSound(soundUrl).catch((error) => {
      console.warn('Failed to play workspace attention sound:', error);
    });
  };

  navigator.serviceWorker.addEventListener('message', handleMessage);

  return () => {
    navigator.serviceWorker.removeEventListener('message', handleMessage);
  };
}
