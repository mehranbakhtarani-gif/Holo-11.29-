import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

const indexedDb = globalThis.indexedDB;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    indexedDB,
    crypto: webcrypto,
    location: { reload: () => undefined },
    dispatchEvent: () => true,
  },
});

const { unlockBackupSession, lockBackupSession } = await import('../src/lib/backupSession');
const { encryptBackupEnvelope } = await import('../src/lib/offlineFirstCore');
const { saveDocumentAttachment } = await import('../src/lib/documentVault');
const {
  getActiveOperationalRestoreJournal,
  isOperationalRestoreBarrierActive,
  saveOperationalWorkspaceTx,
} = await import('../src/lib/operationalDb');
const { restoreCompleteBackupPackage, resumePendingCompleteBackupRestore } = await import('../src/lib/completeBackupRestore');

const passphrase = 'IndexedDB-Restore-Test#1405';
unlockBackupSession(passphrase);

async function countLiveAttachments(): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open('holoo_apex_document_vault_v1', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(['attachments'], 'readonly');
      const request = tx.objectStore('attachments').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error ?? new Error('Attachment count transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function run() {
  const oldAttachment = await saveDocumentAttachment({
    entityType: 'invoice',
    entityId: 'old-invoice',
    entityLabel: 'Old invoice',
    fileName: 'old.pdf',
    mimeType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,QQ==',
    sizeBytes: 1,
    uploadedBy: 'restore-test',
    uploadedByRole: 'accountant',
  });
  assert.equal(oldAttachment.ok, true, 'pre-existing encrypted attachment should be stored');
  assert.equal(await countLiveAttachments(), 1);

  const workspace = {
    profile: {
      uid: 'restore-workspace',
      displayName: 'Restore test',
      companyName: 'Restore test company',
      fiscalYear: '1405',
      currencyUnit: 'IRR' as const,
      role: 'accountant' as const,
    },
    accounts: [{
      id: 'restored-cash',
      ownerId: 'restore-workspace',
      code: '101',
      title: 'Restored cash',
      level: 'kol' as const,
      category: 'asset' as const,
      nature: 'debit' as const,
      isSystem: false,
    }],
    parties: [],
    products: [],
    vouchers: [],
    invoices: [],
    cheques: [],
    employees: [],
    assets: [],
    costCenters: [],
    currencies: [],
    exchangeRates: [],
    importDossiers: [],
    salesOrders: [],
    subcontractJobs: [],
    rbacOperators: [],
    auditLogs: [],
    warehouses: [],
    taxReports: [],
    localProfiles: [],
    syncOutbox: [],
    syncInbox: [],
    localRevision: 8,
  };
  const workspaceEnvelope = await encryptBackupEnvelope(JSON.stringify(workspace), passphrase);
  const packageJson = JSON.stringify({
    format: 'holoo-apex-complete-backup',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    workspaceEnvelope,
    documentAttachments: {
      format: 'holoo-apex-encrypted-document-vault',
      schemaVersion: 2,
      attachments: [],
    },
  });

  // Inject a deterministic crash at the Document Vault live-replacement boundary.
  const nativeClear = IDBObjectStore.prototype.clear;
  let failNextVaultReplacement = true;
  Object.defineProperty(IDBObjectStore.prototype, 'clear', {
    configurable: true,
    value: function(this: IDBObjectStore) {
      if (this.name === 'attachments' && failNextVaultReplacement) {
        failNextVaultReplacement = false;
        this.transaction.abort();
        return undefined;
      }
      return nativeClear.call(this);
    },
  });

  await assert.rejects(restoreCompleteBackupPackage(packageJson));
  assert.equal(failNextVaultReplacement, false, 'the failure injector must fire exactly once');

  const interrupted = await getActiveOperationalRestoreJournal();
  assert.ok(interrupted, 'commit-intent journal must survive a crash between database commits');
  assert.equal(interrupted.state, 'failed_recovery_required');
  assert.equal(isOperationalRestoreBarrierActive(), true, 'normal workspace writes remain blocked');
  await assert.rejects(
    saveOperationalWorkspaceTx(workspace as Parameters<typeof saveOperationalWorkspaceTx>[0]),
    /ذخیره‌سازی فضای کاری تا پایان بازیابی پشتیبان متوقف است/,
    'background operational persistence must not overwrite a restore in progress'
  );
  assert.equal(await countLiveAttachments(), 1, 'aborted vault transaction must preserve the old attachment set');

  const operationalDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open('holoo_apex_operational_db_v1', 5);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const restoredAccountId = await new Promise<unknown>((resolve, reject) => {
      const tx = operationalDb.transaction(['accounts'], 'readonly');
      const request = tx.objectStore('accounts').get('restored-cash');
      request.onsuccess = () => resolve(request.result?.id);
      request.onerror = () => reject(request.error);
    });
    assert.equal(restoredAccountId, 'restored-cash',
      'the first database may commit before the second; the journal must retain forward-recovery intent');
  } finally {
    operationalDb.close();
  }

  const resumed = await resumePendingCompleteBackupRestore();
  assert.ok(resumed, 'interrupted restore should resume');
  assert.equal(resumed.restoredAttachments, 0);
  assert.equal(resumed.restoredWorkspaceRecords, interrupted.workspaceRecordCount);
  assert.equal(await getActiveOperationalRestoreJournal(), null, 'successful recovery must close the journal');
  assert.equal(await countLiveAttachments(), 0, 'retry must atomically replace the old attachment set');
  assert.equal(isOperationalRestoreBarrierActive(), true,
    'the restored tab remains blocked until reload hydrates the committed workspace');

  lockBackupSession();
  console.log('PASS: IndexedDB restore crash injection, durable journal recovery, and idempotent replacement');
}

run().catch((error) => {
  lockBackupSession();
  console.error(error);
  process.exitCode = 1;
});
