import assert from 'node:assert/strict';
import {
  DEFAULT_BACKUP_SESSION_INACTIVITY_MS,
  installBackupSessionAutoLock,
} from '../src/lib/backupSessionLifecycle';
import { isBackupSessionUnlocked, lockBackupSession, unlockBackupSession } from '../src/lib/backupSession';

async function run() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fakeWindow = new EventTarget();
  const fakeDocument = Object.assign(new EventTarget(), { hidden: false });
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const cleared: number[] = [];
  const environment = {
    window: fakeWindow as unknown as Window,
    document: fakeDocument as unknown as Document,
    setTimeout: (callback: () => void, delay: number) => {
      assert.equal(delay, DEFAULT_BACKUP_SESSION_INACTIVITY_MS);
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      const id = handle as number;
      cleared.push(id);
      timers.delete(id);
    },
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

  try {
    lockBackupSession();
    const dispose = installBackupSessionAutoLock(DEFAULT_BACKUP_SESSION_INACTIVITY_MS, environment);
    assert.equal(timers.size, 0, 'a locked vault must not schedule an inactivity timer');

    unlockBackupSession('AutoLock#1405');
    assert.equal(timers.size, 1, 'unlock must start the inactivity countdown');
    const firstTimer = [...timers.keys()][0];

    fakeWindow.dispatchEvent(new Event('pointerdown'));
    assert.equal(timers.size, 1, 'user activity must replace rather than duplicate the timer');
    assert.ok(cleared.includes(firstTimer), 'activity must clear the previous timer');

    const activeTimer = [...timers.entries()][0];
    activeTimer[1]();
    assert.equal(isBackupSessionUnlocked(), false, 'inactivity must lock the backup vault');
    assert.equal(timers.size, 0, 'locking must clear the pending timer');

    unlockBackupSession('HiddenLock#1405');
    fakeDocument.hidden = true;
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    assert.equal(isBackupSessionUnlocked(), false, 'hiding the document must lock immediately');

    fakeDocument.hidden = false;
    unlockBackupSession('PageHide#1405');
    fakeWindow.dispatchEvent(new Event('pagehide'));
    assert.equal(isBackupSessionUnlocked(), false, 'pagehide must lock before the page is discarded');

    unlockBackupSession('Cleanup#1405');
    assert.equal(timers.size, 1);
    dispose();
    assert.equal(timers.size, 0, 'cleanup must clear the inactivity timer');
    fakeWindow.dispatchEvent(new Event('pointerdown'));
    assert.equal(timers.size, 0, 'cleanup must detach activity listeners');
    lockBackupSession();

    console.log('Backup session auto-lock lifecycle: 12 assertions passed');
  } finally {
    lockBackupSession();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
