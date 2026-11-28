import { isBackupSessionUnlocked, lockBackupSession } from './backupSession';

export const DEFAULT_BACKUP_SESSION_INACTIVITY_MS = 5 * 60 * 1000;

interface AutoLockEnvironment {
  window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener'> & { hidden: boolean };
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * Locks the backup vault after inactivity and whenever the document is hidden
 * or the page is being discarded. Returns a cleanup function for app unmount.
 */
export function installBackupSessionAutoLock(
  inactivityMs = DEFAULT_BACKUP_SESSION_INACTIVITY_MS,
  environment: AutoLockEnvironment = {
    window,
    document,
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): () => void {
  if (!Number.isFinite(inactivityMs) || inactivityMs <= 0) {
    throw new Error('مدت قفل خودکار نشست باید عددی مثبت باشد.');
  }

  let timer: unknown;
  let disposed = false;
  const clearTimer = () => {
    if (timer !== undefined) {
      environment.clearTimeout(timer);
      timer = undefined;
    }
  };
  const lock = () => {
    clearTimer();
    if (isBackupSessionUnlocked()) lockBackupSession();
  };
  const scheduleLock = () => {
    clearTimer();
    if (disposed || environment.document.hidden || !isBackupSessionUnlocked()) return;
    timer = environment.setTimeout(lock, inactivityMs);
  };
  const onActivity = () => scheduleLock();
  const onSessionChanged = () => {
    if (isBackupSessionUnlocked()) scheduleLock();
    else clearTimer();
  };
  const onVisibilityChanged = () => {
    if (environment.document.hidden) lock();
    else scheduleLock();
  };
  const onPageHide = () => lock();

  const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
  for (const eventName of activityEvents) {
    environment.window.addEventListener(eventName, onActivity, { passive: true });
  }
  environment.window.addEventListener('holoo:backup-session-changed', onSessionChanged);
  environment.window.addEventListener('pagehide', onPageHide);
  environment.document.addEventListener('visibilitychange', onVisibilityChanged);
  onSessionChanged();

  return () => {
    disposed = true;
    clearTimer();
    for (const eventName of activityEvents) {
      environment.window.removeEventListener(eventName, onActivity);
    }
    environment.window.removeEventListener('holoo:backup-session-changed', onSessionChanged);
    environment.window.removeEventListener('pagehide', onPageHide);
    environment.document.removeEventListener('visibilitychange', onVisibilityChanged);
  };
}
