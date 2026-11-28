import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { createOperationalDataSalt } from '../src/lib/operationalRecordEncryption';
import { lockBackupSession, unlockBackupSession } from '../src/lib/backupSession';

const previous = {
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  broadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory };
  fakeWindow.indexedDB = indexedDB;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
  try {
    const session = await import('../src/lib/operationalEncryptionSession');
    session.lockOperationalDataSession();
    lockBackupSession();
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    assert.throws(() => session.captureOperationalDataKeyLease(), /locked/);

    const passphrase = 'OperationalSession#1405';
    unlockBackupSession(passphrase);
    const operationalDb = await import('../src/lib/operationalDb');
    const descriptor = await operationalDb.initializeOperationalKeyDescriptor('workspace-session-01');
    const persistedDescriptor = await operationalDb.loadOperationalKeyDescriptor('workspace-session-01');
    assert.deepEqual(persistedDescriptor, descriptor);
    operationalDb.setOperationalRestoreBarrier(true);
    await assert.rejects(
      () => session.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-session-01'),
      /blocked while workspace restore is active/,
      'restore barrier must prevent operational key unlock'
    );
    operationalDb.setOperationalRestoreBarrier(false);
    await assert.rejects(
      () => operationalDb.initializeOperationalKeyDescriptor('workspace-session-01'),
      /already registered|از قبل ثبت شده/
    );
    assert.deepEqual(
      await operationalDb.loadOperationalKeyDescriptor('workspace-session-01'),
      descriptor
    );
    await assert.rejects(
      () => session.unlockOperationalDataSessionFromDescriptor(descriptor, 'another-workspace'),
      /invalid or belongs to another workspace/
    );
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    await session.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-session-01');
    assert.equal(session.isOperationalDataSessionUnlocked(), true);
    const staleDerivation = session.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-session-01');
    session.lockOperationalDataSession();
    await assert.rejects(staleDerivation, /superseded by another session change/);
    assert.equal(session.isOperationalDataSessionUnlocked(), false);
    await session.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-session-01');
    const lease = session.captureOperationalDataKeyLease();
    assert.equal(lease.key.extractable, false);
    session.assertOperationalDataKeyLease(lease);
    operationalDb.setOperationalRestoreBarrier(true);
    assert.throws(
      () => session.captureOperationalDataKeyLease(),
      /blocked while workspace restore is active/,
      'restore barrier must prevent new operational data-key leases'
    );
    assert.throws(
      () => session.assertOperationalDataKeyLease(lease),
      /blocked while workspace restore is active/,
      'restore barrier must fence already captured operational data-key leases'
    );
    operationalDb.setOperationalRestoreBarrier(false);

    const sessionCodec = await import('../src/lib/operationalRecordSessionCodec');
    const recordContext = {
      workspaceId: 'workspace-session-01',
      store: 'vouchers' as const,
      recordId: 'voucher-0001',
    };
    const recordValue = { number: 'V-1405-001', debit: 125000, credit: 125000 };
    const encryptedRecord = await sessionCodec.encryptOperationalRecordForActiveSession(
      recordValue,
      recordContext
    );
    assert.equal(lease.workspaceId, 'workspace-session-01');
    await assert.rejects(
      () => sessionCodec.encryptOperationalRecordForActiveSession(recordValue, {
        ...recordContext,
        workspaceId: 'workspace-attacker',
      }),
      /workspace does not match/,
      'an unlocked workspace key must not encrypt records under another workspace identity'
    );
    await assert.rejects(
      () => sessionCodec.decryptOperationalRecordForActiveSession(encryptedRecord, {
        ...recordContext,
        workspaceId: 'workspace-attacker',
      }),
      /workspace does not match/,
      'an unlocked workspace key must not decrypt records under another workspace identity'
    );
    assert.deepEqual(
      await sessionCodec.decryptOperationalRecordForActiveSession(encryptedRecord, recordContext),
      recordValue
    );
    await assert.rejects(
      () => sessionCodec.decryptOperationalRecordForActiveSession(encryptedRecord, {
        ...recordContext,
        recordId: 'voucher-other',
      }),
      /metadata or identity is invalid/
    );

    await assert.rejects(
      () => session.rewrapOperationalWorkspaceKey('workspace-session-01', 'short'),
      /at least 10/,
      'weak replacement passphrases must not rotate the operational key'
    );
    assert.deepEqual(
      await operationalDb.loadOperationalKeyDescriptor('workspace-session-01'),
      descriptor,
      'failed key rotation must preserve the existing descriptor'
    );
    operationalDb.setOperationalRestoreBarrier(true);
    await assert.rejects(
      () => session.rewrapOperationalWorkspaceKey(
        'workspace-session-01',
        'ReplacementSession#1405'
      ),
      /مسدود است/,
      'restore barrier must prevent operational key rotation'
    );
    operationalDb.setOperationalRestoreBarrier(false);

    // Re-wrap the same DEK under a new passphrase using a durable compare-and-swap.
    const rotatedDescriptor = await session.rewrapOperationalWorkspaceKey(
      'workspace-session-01',
      ' ReplacementSession#1405 '
    );
    assert.equal(rotatedDescriptor.keyId, descriptor.keyId);
    assert.notEqual(rotatedDescriptor.saltB64, descriptor.saltB64);
    assert.notEqual(rotatedDescriptor.wrappedKeyB64, descriptor.wrappedKeyB64);
    assert.deepEqual(
      await operationalDb.loadOperationalKeyDescriptor('workspace-session-01'),
      rotatedDescriptor
    );
    // Replacing the backup vault secret invalidates the old operational key too.
    unlockBackupSession('ReplacementSession#1405');
    assert.throws(() => session.assertOperationalDataKeyLease(lease), /expired/);
    await assert.rejects(
      () => session.unlockOperationalDataSessionFromDescriptor(descriptor, 'workspace-session-01'),
      /operation|decrypt|authentication/i,
      'the previous passphrase must no longer unwrap the rotated descriptor'
    );
    await session.unlockOperationalDataSessionFromDescriptor(rotatedDescriptor, 'workspace-session-01');
    assert.equal(session.isOperationalDataSessionUnlocked(), true);
    assert.deepEqual(
      await sessionCodec.decryptOperationalRecordForActiveSession(encryptedRecord, recordContext),
      recordValue,
      'passphrase rotation must preserve the original workspace DEK and all existing ciphertext'
    );
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

    console.log('Operational encryption session: 35 assertions passed');
  } finally {
    lockBackupSession();
    if (previous.crypto) Object.defineProperty(globalThis, 'crypto', previous.crypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (previous.window) Object.defineProperty(globalThis, 'window', previous.window);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previous.broadcastChannel) Object.defineProperty(globalThis, 'BroadcastChannel', previous.broadcastChannel);
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
