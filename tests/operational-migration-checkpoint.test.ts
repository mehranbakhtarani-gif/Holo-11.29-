import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import {
  getBackupSessionGeneration,
  lockBackupSession,
  unlockBackupSession,
} from '../src/lib/backupSession';
import {
  advanceOperationalMigrationStoreCheckpoint,
  createOperationalMigrationJournalRecord,
  transitionOperationalMigrationPhase,
} from '../src/lib/operationalMigrationJournal';

const previous = {
  crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  broadcastChannel: Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel'),
};

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('holoo_apex_operational_db_v1', 7);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run() {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fakeWindow = new EventTarget() as EventTarget & { indexedDB: IDBFactory };
  fakeWindow.indexedDB = indexedDB;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
  try {
    lockBackupSession();
    unlockBackupSession('MigrationCheckpoint#1405');
    const operationalDb = await import('../src/lib/operationalDb');
    const persistence = await import('../src/lib/operationalMigrationPersistence');
    await operationalDb.initializeOperationalKeyDescriptor('workspace-checkpoint-01');

    const binding = {
      workspaceId: 'workspace-checkpoint-01',
      migrationId: 'migration_checkpoint_0001',
      sourceRevision: 17,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const digest = 'a'.repeat(64);
    let fixture = createOperationalMigrationJournalRecord({
      ...binding,
      sourceSchemaVersion: 6,
      targetFormatVersion: 2,
      storeNames: ['accounts'],
      now: '2026-11-28T12:00:00.000Z',
    });
    fixture = transitionOperationalMigrationPhase(fixture, 'copying');
    fixture = advanceOperationalMigrationStoreCheckpoint(fixture, 'accounts', {
      state: 'copying',
      cursor: 'account-checkpoint-01',
      batchSequence: 1,
      sourceRecordCount: 1,
      copiedRecordCount: 1,
      sourceDigest: digest,
      targetDigest: null,
    }, binding);
    fixture = transitionOperationalMigrationPhase(fixture, 'verifying');

    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['operationalMigrationJournal'], 'readwrite');
        tx.objectStore('operationalMigrationJournal').put(fixture);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }

    const verified = await persistence.persistOperationalMigrationStoreCheckpoint(
      binding,
      'accounts',
      {
        state: 'verified',
        cursor: 'account-checkpoint-01',
        batchSequence: 2,
        sourceRecordCount: 1,
        copiedRecordCount: 1,
        sourceDigest: digest,
        targetDigest: digest,
      }
    );
    assert.equal(verified.phase, 'verifying');
    assert.equal(verified.stores[0].state, 'verified');
    assert.equal(verified.stores[0].targetDigest, digest);
    assert.deepEqual(
      await persistence.readOperationalMigrationJournal(binding.migrationId, binding.workspaceId),
      verified,
      'verification checkpoint must be durable across database connections'
    );

    const ready = await persistence.persistOperationalMigrationPhase(binding, 'ready_to_cutover');
    assert.equal(ready.phase, 'ready_to_cutover');

    const copyingBinding = {
      workspaceId: 'workspace-checkpoint-02',
      migrationId: 'migration_checkpoint_0002',
      sourceRevision: 18,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const copyingRecord = createOperationalMigrationJournalRecord({
      ...copyingBinding,
      sourceSchemaVersion: 6,
      targetFormatVersion: 2,
      storeNames: ['accounts'],
      now: '2026-11-28T12:01:00.000Z',
    });
    await persistence.createOperationalMigrationJournal(copyingRecord);
    await persistence.persistOperationalMigrationPhase(copyingBinding, 'copying');
    await assert.rejects(
      () => persistence.persistOperationalMigrationStoreCheckpoint(copyingBinding, 'accounts', {
        state: 'copying',
        cursor: 'account-1',
        batchSequence: 1,
        sourceRecordCount: 1,
        copiedRecordCount: 1,
        sourceDigest: digest,
        targetDigest: null,
      }),
      /must be committed atomically with encrypted shadow rows/
    );
    console.log('Operational migration checkpoint persistence: verification durability and atomic-copy guard passed');
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
  process.exitCode = 1;
});
