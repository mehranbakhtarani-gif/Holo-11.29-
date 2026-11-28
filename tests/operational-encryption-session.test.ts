import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { createOperationalDataSalt } from '../src/lib/operationalRecordEncryption';
import { queryEncryptedOperationalStore, writeEncryptedOperationalStoresAtomically } from '../src/lib/encryptedOperationalIndexedDb';
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
    const staleWorkspaceBootstrap = session.unlockOperationalDataSessionForWorkspace('workspace-session-01');
    session.lockOperationalDataSession();
    await assert.rejects(
      staleWorkspaceBootstrap,
      /superseded by another session change/,
      'locking during descriptor loading must fence the entire asynchronous workspace bootstrap'
    );
    assert.equal(
      session.isOperationalDataSessionUnlocked(),
      false,
      'a stale workspace bootstrap must not reopen a key after cleanup'
    );
    const restoreBlockedBootstrap = session.unlockOperationalDataSessionForWorkspace('workspace-session-01');
    operationalDb.setOperationalRestoreBarrier(true);
    await assert.rejects(
      restoreBlockedBootstrap,
      /Operational key unlock is blocked while workspace restore is active|بازیابی پشتیبان در حال انجام یا نیازمند ادامه است/,
      'a restore barrier raised during descriptor loading must abort workspace key bootstrap'
    );
    assert.equal(
      session.isOperationalDataSessionUnlocked(),
      false,
      'a restore-blocked bootstrap must never publish an operational key'
    );
    operationalDb.setOperationalRestoreBarrier(false);
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

    // Exercise the opt-in encrypted IndexedDB adapter against the real v5 keyPaths.
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('holoo_apex_operational_db_v1', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const written = await writeEncryptedOperationalStoresAtomically(
        rawDb,
        'workspace-session-01',
        [
          { store: 'vouchers', records: [{ id: 'enc-voucher-1', voucherNumber: 101, date: '1405/01/01', status: 'draft' }] },
          { store: 'products', records: [{ id: 'enc-product-1', sku: 'SECRET-SKU-1', stock: 12 }] },
        ]
      );
      assert.equal(written, 2, 'encrypted multi-store write must commit every prepared record');
      const rawVoucher = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = rawDb.transaction(['vouchers'], 'readonly');
        const req = tx.objectStore('vouchers').get('enc-voucher-1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      assert.deepEqual(Object.keys(rawVoucher).sort(), ['encryptedRecord', 'id']);
      assert.equal(rawVoucher.id, 'enc-voucher-1');
      assert.equal('date' in rawVoucher, false, 'business date must not leak into the encrypted row wrapper');
      const filtered = await queryEncryptedOperationalStore(
        rawDb,
        'vouchers',
        'workspace-session-01',
        { predicate: (record) => record.status === 'draft', limit: 10, maxScan: 20 }
      );
      assert.deepEqual(filtered.items, [{ id: 'enc-voucher-1', voucherNumber: 101, date: '1405/01/01', status: 'draft' }]);
      assert.equal(filtered.scanned, 1);
      const products = await queryEncryptedOperationalStore(
        rawDb,
        'products',
        'workspace-session-01',
        { predicate: (record) => record.sku === 'SECRET-SKU-1' }
      );
      assert.equal(products.items.length, 1);
      assert.equal(products.items[0].stock, 12);
      await assert.rejects(
        () => writeEncryptedOperationalStoresAtomically(rawDb, 'workspace-session-01', [
          { store: 'vouchers', records: [{ id: 'duplicate', amount: 1 }, { id: 'duplicate', amount: 2 }] },
        ]),
        /duplicate primary key/,
        'duplicate primary keys must be rejected before opening a write transaction'
      );
      const absentDuplicate = await new Promise<unknown>((resolve, reject) => {
        const tx = rawDb.transaction(['vouchers'], 'readonly');
        const req = tx.objectStore('vouchers').get('duplicate');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      assert.equal(absentDuplicate, undefined, 'a rejected batch must not write partial records');
    } finally {
      rawDb.close();
    }
    await assert.rejects(
      () => sessionCodec.decryptOperationalRecordForActiveSession(encryptedRecord, {
        ...recordContext,
        recordId: 'voucher-other',
      }),
      /metadata or identity is invalid/
    );

    await assert.rejects(
      () => session.rewrapOperationalWorkspaceKey('workspace-session-01', 'short'),
      /حداقل ۱۰ کاراکتر/,
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

    console.log('Operational encryption session: 39 assertions passed');
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
