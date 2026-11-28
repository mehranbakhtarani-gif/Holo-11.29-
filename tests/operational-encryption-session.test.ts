import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { createOperationalDataSalt } from '../src/lib/operationalRecordEncryption';
import { lockBackupSession, unlockBackupSession } from '../src/lib/backupSession';

const previous = {
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory };
  fakeWindow.indexedDB = indexedDB;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  try {
    const session = await import('../src/lib/operationalEncryptionSession');
    session.lockOperationalDataSession();
    lockBackupSession();
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    assert.throws(() => session.captureOperationalDataKeyLease(), /locked/);

    const passphrase = 'OperationalSession#1405';
    unlockBackupSession(passphrase);
    await session.unlockOperationalDataSession(createOperationalDataSalt());
    assert.equal(session.isOperationalDataSessionUnlocked(), true);
    const lease = session.captureOperationalDataKeyLease();
    assert.equal(lease.key.extractable, false);
    session.assertOperationalDataKeyLease(lease);

    // Replacing the backup vault secret invalidates the old operational key too.
    unlockBackupSession('ReplacementSession#1405');
    assert.throws(() => session.assertOperationalDataKeyLease(lease), /expired/);
    await session.unlockOperationalDataSession(createOperationalDataSalt());
    const replacementLease = session.captureOperationalDataKeyLease();
    session.assertOperationalDataKeyLease(replacementLease);

    // Locking the existing backup vault synchronously invalidates the operational key.
    lockBackupSession();
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    assert.throws(() => session.assertOperationalDataKeyLease(lease), /expired/);
    assert.throws(() => session.captureOperationalDataKeyLease(), /locked/);

    unlockBackupSession(passphrase);
    await session.unlockOperationalDataSession(createOperationalDataSalt());
    const secondLease = session.captureOperationalDataKeyLease();
    session.lockOperationalDataSession();
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    assert.throws(() => session.assertOperationalDataKeyLease(secondLease), /expired/);

    // A later backup-vault lock also invalidates a freshly derived operational key.
    await session.unlockOperationalDataSession(createOperationalDataSalt());
    const thirdLease = session.captureOperationalDataKeyLease();
    lockBackupSession();
    assert.throws(() => session.assertOperationalDataKeyLease(thirdLease), /expired/);

    console.log('Operational encryption session: 12 assertions passed');
  } finally {
    lockBackupSession();
    if (previous.crypto) Object.defineProperty(globalThis, 'crypto', previous.crypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (previous.window) Object.defineProperty(globalThis, 'window', previous.window);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
