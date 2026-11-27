export interface OfflineSwSnapshot {
  supported: boolean;
  registered: boolean;
  controlling: boolean;
  offlineReady: boolean;
  needRefresh: boolean;
  registrationError: string | null;
  lastCheckedAt: string | null;
}

type Listener = (state: OfflineSwSnapshot) => void;

let currentState: OfflineSwSnapshot = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  registered: false,
  controlling:
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    Boolean(navigator.serviceWorker.controller),
  offlineReady: false,
  needRefresh: false,
  registrationError: null,
  lastCheckedAt: null,
};

let updateSwFn: ((reloadPage?: boolean) => Promise<void>) | null = null;
const listeners = new Set<Listener>();

function emit() {
  const copy = { ...currentState };
  listeners.forEach((fn) => fn(copy));
}

export function setOfflineSwState(patch: Partial<OfflineSwSnapshot>): void {
  currentState = {
    ...currentState,
    ...patch,
    lastCheckedAt: new Date().toISOString(),
  };
  emit();
}

export function setOfflineSwUpdater(fn: (reloadPage?: boolean) => Promise<void>): void {
  updateSwFn = fn;
}

export function getOfflineSwState(): OfflineSwSnapshot {
  return { ...currentState };
}

export function subscribeOfflineSwState(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...currentState });
  return () => {
    listeners.delete(listener);
  };
}

export async function triggerSwUpdateCheck(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    if (regs.length > 0) {
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
      setOfflineSwState({
        registered: true,
        controlling: Boolean(navigator.serviceWorker.controller),
      });
      return true;
    }
    if (updateSwFn) {
      await updateSwFn(false);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function applyPendingSwRefresh(): Promise<void> {
  if (updateSwFn) {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      throw new Error('سرویس به‌روزرسانی در این مرورگر در دسترس نیست.');
    }

    // Resolve only after the new worker takes control. The PWA register
    // handler then reloads the page; a timeout keeps the banner visible
    // instead of reporting a false success.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
        if (error) reject(error);
        else resolve();
      };
      const handleControllerChange = () => finish();
      const timeout = window.setTimeout(
        () => finish(new Error('فعال‌سازی نسخه جدید تأیید نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.')),
        30000
      );

      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      void updateSwFn!(true).catch((err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });
  } else if (typeof window !== 'undefined') {
    window.location.reload();
  } else {
    throw new Error('امکان بازنشانی برنامه در این محیط وجود ندارد.');
  }
}

/**
 * Controlled PWA Update Activator:
 * Executes an optional pre-update safety backup hook BEFORE activating a waiting Service Worker,
 * ensuring local accounting data is preserved even if a migration or partial update occurs.
 */
export async function safeApplySwUpdateWithBackup(
  createSafetyBackup?: () => Promise<boolean> | boolean
): Promise<{ backupCreated: boolean; applied: boolean; error?: string }> {
  let backupCreated = false;
  try {
    if (createSafetyBackup) {
      backupCreated = Boolean(await createSafetyBackup());
      if (!backupCreated) {
        return {
          backupCreated: false,
          applied: false,
          error: 'پشتیبان ایمنی ذخیره نشد؛ برای جلوگیری از خطر اطلاعات، بروزرسانی انجام نشد.',
        };
      }
    }
    await applyPendingSwRefresh();
    return { backupCreated, applied: true };
  } catch (err) {
    return {
      backupCreated,
      applied: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Warms up essential runtime assets into Cache Storage so the app opens seamlessly when offline.
 */
export async function warmOfflineCacheNow(): Promise<{ cachedCount: number; cacheName: string }> {
  const cacheName = 'apex-offline-shell-manual-v1';
  if (typeof caches === 'undefined') {
    return { cachedCount: 0, cacheName };
  }
  const base = (import.meta.env?.BASE_URL || './').replace(/\/?$/, '/');
  const urlsToWarm = [
    base,
    `${base}index.html`,
    `${base}icon.svg`,
    `${base}pwa-192x192.png`,
    `${base}pwa-512x512.png`,
    `${base}apple-touch-icon.png`,
    `${base}manifest.webmanifest`,
  ];
  let cachedCount = 0;
  try {
    const cache = await caches.open(cacheName);
    await Promise.all(
      urlsToWarm.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok) {
            await cache.put(url, res.clone());
            cachedCount += 1;
          }
        } catch {
          // ignore individual asset fetch errors when already offline
        }
      })
    );
  } catch {
    // ignore cache storage errors
  }
  return { cachedCount, cacheName };
}
