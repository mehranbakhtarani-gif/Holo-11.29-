import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

const indexedDb = globalThis.indexedDB;
const sessionListeners = new Set<(event: Event) => void>();
const localStorageValues = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)); },
  removeItem: (key: string) => { localStorageValues.delete(key); },
  clear: () => localStorageValues.clear(),
};
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    locks: {
      request: async (_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<unknown>) => callback(),
    },
  },
});
Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    indexedDB,
    localStorage: localStorageMock,
    crypto: webcrypto,
    location: { reload: () => undefined },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'holoo:backup-session-changed') sessionListeners.add(listener as (event: Event) => void);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'holoo:backup-session-changed') sessionListeners.delete(listener as (event: Event) => void);
    },
    dispatchEvent: (event: Event) => {
      if (event.type === 'holoo:backup-session-changed') {
        for (const listener of [...sessionListeners]) listener(event);
      }
      return true;
    },
  },
});

const { unlockBackupSession, lockBackupSession } = await import('../src/lib/backupSession');
const { encryptBackupEnvelope } = await import('../src/lib/offlineFirstCore');
const { saveDocumentAttachment, exportEncryptedDocumentAttachmentBundle } = await import('../src/lib/documentVault');
const {
  createOperationalRestoreJournal,
  getActiveOperationalRestoreJournal,
  isOperationalRestoreBarrierActive,
  saveOperationalWorkspaceTx,
  savePreUpdateSafetyBackup,
  listPreUpdateSafetyBackups,
} = await import('../src/lib/operationalDb');
const { restoreCompleteBackupPackage, resumePendingCompleteBackupRestore } = await import('../src/lib/completeBackupRestore');

const passphrase = 'IndexedDB-Restore-Test#1405';
unlockBackupSession(passphrase);

// A lock during asynchronous envelope verification must prevent the safety
// backup from reaching IndexedDB with a stale session lease.
const safetyEnvelope = await encryptBackupEnvelope(JSON.stringify({ profile: { uid: 'lease-test' }, accounts: [] }), passphrase);
const safetyWrite = savePreUpdateSafetyBackup({
  id: 'session-race-safety-backup',
  reason: 'manual_guard',
  schemaVersion: 5,
  sha256: safetyEnvelope.plaintextSha256,
  envelopeJson: JSON.stringify(safetyEnvelope),
  createdAt: new Date().toISOString(),
});
lockBackupSession();
await assert.rejects(safetyWrite, /نشست رمزگذاری/);
assert.equal((await listPreUpdateSafetyBackups()).some((row) => row.id === 'session-race-safety-backup'), false,
  'a safety backup verified under a stale lease must never be persisted');
unlockBackupSession(passphrase);

// A new tab must be able to observe the durable preparation record before any
// attachment staging writes begin.
const preparationId = 'restore_preparation_visibility_test';
const preparationTime = new Date().toISOString();
await createOperationalRestoreJournal({
  restoreId: preparationId,
  workspaceId: 'restore-workspace',
  packageDigest: 'a'.repeat(64),
  workspaceEnvelopeJson: JSON.stringify({ format: 'holoo-apex-encrypted-backup' }),
  workspacePlaintextSha256: 'b'.repeat(64),
  workspaceSchemaVersion: 2,
  workspaceRecordCount: 1,
  attachmentManifestDigest: 'a'.repeat(64),
  attachmentCount: 0,
  packageSchemaVersion: 2,
  state: 'staging',
  createdAt: preparationTime,
  updatedAt: preparationTime,
});
assert.equal((await getActiveOperationalRestoreJournal())?.restoreId, preparationId,
  'startup must discover a preparation journal before attachment staging');
const recoveredPreparation = await resumePendingCompleteBackupRestore();
assert.equal(recoveredPreparation, null,
  'after acquiring the exclusive restore lock, a pre-commit staging journal is safe to discard');
assert.equal(await getActiveOperationalRestoreJournal(), null,
  'a crashed pre-commit preparation must be cleaned before normal startup resumes');
assert.equal(isOperationalRestoreBarrierActive(), false,
  'successful pre-commit cleanup must release the local restore barrier');

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
    businessLocalState: {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      stores: {
        holoo_apex_voucher_templates_v1: JSON.stringify([{
          id: 'custom-template-1', name: 'Template', lines: [{ accountCode: '101', side: 'debit' }],
        }]),
        holoo_apex_invoice_settings_v1: JSON.stringify({ template: 'modern_textile', logoDataUrl: 'data:image/png;base64,QQ==' }),
        holoo_apex_warehouse_transfers_v1: JSON.stringify([{
          id: 'transfer-1', productId: 'product-1', fromWarehouse: 'A', toWarehouse: 'B',
          qty: 2, status: 'in_transit',
        }]),
        holoo_apex_bank_recon_sessions_v1: JSON.stringify({
          '10201': {
            'statement-row-1': {
              statementRowId: 'statement-row-1', reviewStatus: 'confirmed',
              reviewedBy: 'test', reviewedAt: new Date().toISOString(),
            },
          },
        }),
        holoo_apex_sync_conflict_default_v1: 'ask',
        holoo_apex_conflict_policy_v1: 'last_write_wins',
        holoo_apex_supabase_revision_v1: '17',
      },
    },
  };
  const workspaceEnvelope = await encryptBackupEnvelope(JSON.stringify(workspace), passphrase);
  const documentAttachments = JSON.parse(await exportEncryptedDocumentAttachmentBundle()) as {
    attachments: Array<{ id: string }>;
  };
  assert.equal(documentAttachments.attachments.length, 1,
    'the backup should contain the pre-existing attachment and a non-empty manifest');
  const packageJson = JSON.stringify({
    format: 'holoo-apex-complete-backup',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    workspaceEnvelope,
    documentAttachments: JSON.parse(await exportEncryptedDocumentAttachmentBundle()),
  });

  // Add a post-snapshot row so restore must use the persisted non-empty staging
  // manifest rather than the journal's initial placeholder metadata.
  const postSnapshotAttachment = await saveDocumentAttachment({
    entityType: 'invoice',
    entityId: 'new-invoice',
    entityLabel: 'New invoice',
    fileName: 'new.pdf',
    mimeType: 'application/pdf',
    dataUrl: 'data:application/pdf;base64,Qg==',
    sizeBytes: 1,
    uploadedBy: 'restore-test',
    uploadedByRole: 'accountant',
  });
  assert.equal(postSnapshotAttachment.ok, true);
  assert.equal(await countLiveAttachments(), 2);

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
  assert.equal(await countLiveAttachments(), 2, 'aborted vault transaction must preserve the pre-restore attachment set');

  const operationalDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open('holoo_apex_operational_db_v1', 7);
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
  assert.equal(resumed.restoredAttachments, 1, 'recovery must apply the one attachment in the persisted snapshot manifest');
  assert.equal(resumed.restoredWorkspaceRecords, interrupted.workspaceRecordCount);
  assert.equal(await getActiveOperationalRestoreJournal(), null, 'successful recovery must close the journal');
  assert.equal(await countLiveAttachments(), 1, 'retry must atomically replace the live set with the one snapshotted attachment');
  assert.equal(localStorageValues.get('holoo_apex_voucher_templates_v1'), workspace.businessLocalState.stores.holoo_apex_voucher_templates_v1,
    'custom voucher templates must be replayed from the encrypted restore journal');
  assert.equal(localStorageValues.get('holoo_apex_invoice_settings_v1'), workspace.businessLocalState.stores.holoo_apex_invoice_settings_v1,
    'invoice print settings and embedded logo must be restored');
  assert.equal(localStorageValues.get('holoo_apex_warehouse_transfers_v1'), workspace.businessLocalState.stores.holoo_apex_warehouse_transfers_v1,
    'tracked warehouse transfers and in-transit state must be restored');
  assert.equal(localStorageValues.get('holoo_apex_bank_recon_sessions_v1'), workspace.businessLocalState.stores.holoo_apex_bank_recon_sessions_v1,
    'bank reconciliation decisions must be restored');
  assert.equal(localStorageValues.get('holoo_apex_sync_conflict_default_v1'), 'ask',
    'the local conflict-resolution mode must be restored');
  assert.equal(localStorageValues.get('holoo_apex_supabase_revision_v1'), '17',
    'sync revision metadata must be restored as non-authoritative state');
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
