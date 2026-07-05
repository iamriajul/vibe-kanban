import { BellIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useBrowserNotificationPreference } from '@/shared/hooks/useBrowserNotificationPreference';
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from '@/shared/lib/browserNotifications';
import {
  playWorkspaceAttentionNotificationSoundPreview,
  subscribeToWorkspaceAttentionServiceWorkerMessages,
  subscribeToWorkspaceAttentionPush,
  unsubscribeFromWorkspaceAttentionPush,
} from '@/shared/lib/workspaceAttentionNotifications';

const PROMPT_DISMISSED_STORAGE_KEY =
  'vibe-kanban.workspace-attention.notification-prompt.dismissed';

interface AppWorkspaceAttentionNotificationsProps {
  hostId?: string | null;
}

function readPromptDismissed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(PROMPT_DISMISSED_STORAGE_KEY) === 'true';
}

export function AppWorkspaceAttentionNotifications({
  hostId: _hostId,
}: AppWorkspaceAttentionNotificationsProps) {
  const { userId } = useAuth();
  const {
    enabled: browserNotificationsEnabled,
    setEnabled: setBrowserNotificationsEnabled,
  } =
    useBrowserNotificationPreference(userId);
  const [browserPermission, setBrowserPermission] =
    useState<BrowserNotificationPermission>(() =>
      getBrowserNotificationPermission()
    );
  const [promptDismissed, setPromptDismissed] = useState(readPromptDismissed);

  useEffect(() => subscribeToWorkspaceAttentionServiceWorkerMessages(), []);

  useEffect(() => {
    const permission = getBrowserNotificationPermission();
    setBrowserPermission(permission);

    if (
      !browserNotificationsEnabled ||
      permission !== 'granted'
    ) {
      void unsubscribeFromWorkspaceAttentionPush();
      return;
    }

    void subscribeToWorkspaceAttentionPush();
  }, [browserNotificationsEnabled]);

  const handleEnableNotifications = useCallback(async () => {
    playWorkspaceAttentionNotificationSoundPreview();

    const permission = await requestBrowserNotificationPermission();
    setBrowserPermission(permission);
    setBrowserNotificationsEnabled(permission === 'granted');
  }, [setBrowserNotificationsEnabled]);

  const handleDismissPrompt = useCallback(() => {
    setPromptDismissed(true);

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PROMPT_DISMISSED_STORAGE_KEY, 'true');
    }
  }, []);

  const shouldShowPrompt =
    !browserNotificationsEnabled &&
    browserPermission === 'default' &&
    !promptDismissed;

  return (
    <>
      {shouldShowPrompt && (
        <div className="fixed bottom-base right-base z-50 w-[min(360px,calc(100vw-2rem))] rounded-md border border-border bg-primary p-base shadow-lg">
          <div className="flex items-start gap-base">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
              <BellIcon className="size-icon-base" weight="bold" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-high">
                Enable browser notifications
              </p>
              <p className="mt-half text-sm text-low">
                Get notified when a workspace needs attention.
              </p>
              <div className="mt-base flex items-center gap-half">
                <button
                  type="button"
                  onClick={handleEnableNotifications}
                  className="rounded-sm bg-brand px-base py-half text-sm font-medium text-white transition-colors hover:bg-brand/90"
                >
                  Enable
                </button>
                <button
                  type="button"
                  onClick={handleDismissPrompt}
                  className="rounded-sm px-base py-half text-sm text-low transition-colors hover:bg-secondary hover:text-normal"
                >
                  Not now
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDismissPrompt}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-low transition-colors hover:bg-secondary hover:text-normal"
              aria-label="Dismiss browser notification prompt"
            >
              <XIcon className="size-icon-xs" weight="bold" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
