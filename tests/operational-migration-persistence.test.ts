import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { unlockBackupSession, lockBackupSession } from '../src/lib/backupSession';
import { createOperationalMigrationJournalRecord } from '../src/lib/operationalMigrationJournal';

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
    lockBackupSession();
    unlockBackupSession('MigrationPersistence#1405');
    const persistence = await import('../src/lib/operationalMigrationPersistence');
    const { getBackupSessionGeneration } = await import('../src/lib/backupSession');
    const now = '2026-11-28T12:00:00.000Z';
    const binding = {
      workspaceId: 'workspace-migration-persist',
      migrationId: 'migration_persist_0001',
      sourceRevision: 12,
      backupSessionGeneration: getBackupSessionGeneration(),
    };
    const record = createOperationalMigrationJournalRecord({
      ...binding,
      sourceSchemaVersion: 5,
      targetFormatVersion: 2,
      storeNames: ['accounts', 'vouchers'],
      now,
    });

    await persistence.createOperationalMigrationJournal(record);
    assert.deepEqual(
      await persistence.readOperationalMigrationJournal(binding.migrationId, binding.workspaceId),
      record,
      'journal must survive a fresh IndexedDB connection'
    );
    assert.deepEqual(
      await persistence.listOperationalMigrationJournals(binding.workspaceId),
      [record]
    );
    await assert.rejects(
      () => persistence.createOperationalMigrationJournal(record),
      /existing migration id|active migration/,
      'duplicate or concurrent migration creation must fail closed'
    );

    const copying = await persistence.persistOperationalMigrationPhase(binding, 'copying');
    assert.equal(copying.phase, 'copying');
    assert.deepEqual(
      await persistence.readOperationalMigrationJournal(binding.migrationId),
      copying,
      'phase transition must be durable'
    );
    await assert.rejects(
      () => persistence.persistOperationalMigrationPhase({ ...binding, workspaceId: 'other-workspace' }, 'verifying'),
      /stale|another workspace/,
      'a journal cannot be advanced under a different workspace binding'
    );

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('holoo_apex_operational_db_v1', 6);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['operationalMigrationJournal'], 'readwrite');
      tx.objectStore('operationalMigrationJournal').put({ ...copying, plaintextPayload: 'must-not-be-accepted' });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    await assert.rejects(
      () => persistence.readOperationalMigrationJournal(binding.migrationId),
      /corrupt|unsupported fields/,
      'corrupt or plaintext-bearing journal rows must fail closed'
    );
    console.log('Operational migration durable journal persistence: create, restart read, binding, transition and corruption checks passed');
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
