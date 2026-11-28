import assert from 'node:assert/strict';
import {
  isBackupSessionUnlocked,
  lockBackupSession,
  requireBackupSessionPassphrase,
  unlockBackupSession,
} from '../src/lib/backupSession';

async function run() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let sessionChangeEvents = 0;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        assert.equal(event.type, 'holoo:backup-session-changed');
        sessionChangeEvents += 1;
        return true;
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => { throw new Error('backup session must not read localStorage'); },
      setItem: () => { throw new Error('backup session must not persist passphrases'); },
      removeItem: () => { throw new Error('backup session must not mutate localStorage'); },
    },
  });

  try {
    lockBackupSession();
    assert.equal(isBackupSessionUnlocked(), false);
    assert.throws(() => requireBackupSessionPassphrase(), /قفل پشتیبان/);

    unlockBackupSession('SessionOnly#1405');
    assert.equal(isBackupSessionUnlocked(), true);
    assert.equal(requireBackupSessionPassphrase(), 'SessionOnly#1405');

    unlockBackupSession('Replacement#1405');
    assert.equal(requireBackupSessionPassphrase(), 'Replacement#1405',
      'unlocking again must replace the active in-memory passphrase');

    lockBackupSession();
    assert.equal(isBackupSessionUnlocked(), false);
    assert.throws(() => requireBackupSessionPassphrase(), /قفل پشتیبان/);
    assert.equal(sessionChangeEvents, 4,
      'lock and unlock transitions must notify the UI');

    console.log('Backup session lifecycle: 8 assertions passed');
  } finally {
    lockBackupSession();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
