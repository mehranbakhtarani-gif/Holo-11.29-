import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertBackupSessionLease,
  captureBackupSessionLease,
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
    assert.throws(() => assertBackupSessionLease(replacementLease), /نشست رمزگذاری/,
      'locking must invalidate in-flight work before it can commit');
    assert.throws(() => requireBackupSessionPassphrase(), /قفل پشتیبان/);

    unlockBackupSession('SessionOnly#1405');
    const activeLease = captureBackupSessionLease();
    assert.equal(activeLease.passphrase, 'SessionOnly#1405');
    assert.equal(isBackupSessionUnlocked(), true);
    assert.equal(requireBackupSessionPassphrase(), 'SessionOnly#1405');

    unlockBackupSession('Replacement#1405');
    assert.throws(() => assertBackupSessionLease(activeLease), /نشست رمزگذاری/,
      'replacing an unlocked session must invalidate in-flight work');
    const replacementLease = captureBackupSessionLease();
    assert.equal(requireBackupSessionPassphrase(), 'Replacement#1405',
      'unlocking again must replace the active in-memory passphrase');

    lockBackupSession();
    assert.equal(isBackupSessionUnlocked(), false);
    assert.throws(() => requireBackupSessionPassphrase(), /قفل پشتیبان/);
    assert.equal(sessionChangeEvents, 4,
      'lock and unlock transitions must notify the UI');

    const accountingContext = readFileSync(
      new URL('../src/context/AccountingContext.tsx', import.meta.url),
      'utf8'
    );
    const logoutBody = accountingContext.match(/const logout = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[showToast\]\);/)?.[1];
    assert.ok(logoutBody, 'account logout handler must remain discoverable');
    assert.ok(
      logoutBody.indexOf('lockBackupVault();') >= 0 &&
      logoutBody.indexOf('lockBackupVault();') < logoutBody.indexOf('await signOutAccount();'),
      'backup vault must lock before sign-out can fail'
    );

    console.log('Backup session lifecycle and async lease invalidation: 13 assertions passed');
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
