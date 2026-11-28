import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { lockBackupSession, unlockBackupSession } from '../src/lib/backupSession';
import {
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
} from '../src/lib/offlineFirstCore';
import {
  countOperationalWorkspaceRecords,
  getPreparedEncryptedOperationalWorkspaceMeta,
  loadOperationalWorkspace,
  loadPreparedEncryptedOperationalWorkspace,
  saveOperationalWorkspaceTx,
  writeEncryptedOperationalWorkspaceSnapshot,
  parseOperationalWorkspaceSnapshot,
  queryOperationalStorePaginated,
  validateEncryptedOperationalWorkspaceRecordMetadata,
} from '../src/lib/operationalDb';

async function run() {
  const workspace = {
    profile: { uid: 'workspace-1', displayName: 'Migration Test', companyName: 'Migration Test', fiscalYear: '1405', currencyUnit: 'IRR' as const, role: 'accountant' as const },
    accounts: [{ id: 'a1', ownerId: 'workspace-1', code: '101', title: 'Cash', level: 'kol' as const, category: 'asset' as const, nature: 'debit' as const, isSystem: false }],
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
    warehouses: [{ id: 'wh-1', name: 'Main' }],
    taxReports: [{ id: 'tax-1', period: '1405-01' }],
    localProfiles: [{ workspaceId: 'workspace-1', profileId: 'local-1' }],
    syncOutbox: [{ operationId: 'op-1', target: 'firebase' as const, workspaceId: 'workspace-1', deviceId: 'dev-1', clientRevision: 7, payloadHash: 'abc', createdAt: '2026-11-27T00:00:00.000Z', retryCount: 0, status: 'pending' as const }],
    syncInbox: [{ operationId: 'in-1', sourceDeviceId: 'dev-2', payloadHash: 'def', receivedAt: '2026-11-27T00:00:00.000Z' }],
    businessLocalState: {
      schemaVersion: 1 as const,
      capturedAt: '2026-11-27T00:00:00.000Z',
      stores: { holoo_apex96_workspace_extensions_v2: JSON.stringify({
      warehouseTransfers: [{ id: 'trf-1', transferNumber: 'TRF-1', productId: 'p-1', fromWarehouse: 'Main', toWarehouse: 'Branch', qty: 2, status: 'in_transit' }],
      bankLoans: [{ id: 'loan-1', amountIrr: 5000 }],
    }) },
    },
    localRevision: 7,
    updatedAt: '2026-11-27T00:00:00.000Z',
  };
  const json = JSON.stringify(workspace);
  const passphrase = 'OperationalMigration#1405';
  const envelope = await encryptBackupEnvelope(json, passphrase);
  const restored = await decryptAndVerifyBackupEnvelope(JSON.stringify(envelope), passphrase);

  assert.equal(restored.ok, true);
  assert.equal(restored.snapshotJson, json);
  assert.equal(restored.sha256, envelope.plaintextSha256);
  assert.deepEqual(parseOperationalWorkspaceSnapshot(restored.snapshotJson!), workspace);
  assert.equal(countOperationalWorkspaceRecords(workspace), 20);
  assert.equal(
    parseOperationalWorkspaceSnapshot(restored.snapshotJson!).businessLocalState?.stores.holoo_apex96_workspace_extensions_v2,
    workspace.businessLocalState.stores.holoo_apex96_workspace_extensions_v2,
    'business-critical workspace extensions must be included in the authenticated encrypted snapshot'
  );
  assert.deepEqual(parseOperationalWorkspaceSnapshot(json).warehouses, workspace.warehouses);
  assert.deepEqual(parseOperationalWorkspaceSnapshot(json).taxReports, workspace.taxReports);
  assert.deepEqual(parseOperationalWorkspaceSnapshot(json).localProfiles, workspace.localProfiles);
  assert.deepEqual(parseOperationalWorkspaceSnapshot(json).syncOutbox, workspace.syncOutbox);
  assert.deepEqual(parseOperationalWorkspaceSnapshot(json).syncInbox, workspace.syncInbox);
  assert.throws(
    () => countOperationalWorkspaceRecords({ ...workspace, accounts: null as unknown as typeof workspace.accounts }),
    /ساختار مجموعه رکوردهای فضای کاری معتبر نیست/
  );

  assert.throws(
    () => parseOperationalWorkspaceSnapshot(JSON.stringify({ profile: {}, accounts: [] })),
    /ناقص یا ناسازگار/
  );
  assert.throws(
    () => parseOperationalWorkspaceSnapshot('{invalid json'),
    /JSON معتبر نیست/
  );
  assert.throws(
    () => parseOperationalWorkspaceSnapshot(JSON.stringify({ ...workspace, syncOutbox: 'not-an-array' })),
    /ناقص یا ناسازگار/
  );
  assert.throws(
    () => parseOperationalWorkspaceSnapshot(JSON.stringify({ ...workspace, taxReports: null })),
    /ساختار فضای کاری رمزگذاری‌شده ناقص یا ناسازگار/
  );

  const validMetadata = {
    workspaceId: 'workspace-1',
    envelopeJson: JSON.stringify(envelope),
    schemaVersion: 2,
    recordCount: 1,
    sourceRevision: 7,
    plaintextSha256: envelope.plaintextSha256,
    preparedAt: '2026-11-27T00:00:00.000Z',
    migrationState: 'prepared' as const,
  };
  assert.equal(validateEncryptedOperationalWorkspaceRecordMetadata(validMetadata, 'workspace-1'), true);
  assert.equal(validateEncryptedOperationalWorkspaceRecordMetadata({ ...validMetadata, schemaVersion: 1 }, 'workspace-1'), false);
  assert.equal(validateEncryptedOperationalWorkspaceRecordMetadata(validMetadata, 'another-workspace'), false);
  assert.equal(
    validateEncryptedOperationalWorkspaceRecordMetadata({ ...validMetadata, recordCount: -1 }, 'workspace-1'),
    false
  );
  assert.equal(
    validateEncryptedOperationalWorkspaceRecordMetadata({ ...validMetadata, sourceRevision: Number.MAX_SAFE_INTEGER + 1 }, 'workspace-1'),
    false
  );
  assert.equal(
    validateEncryptedOperationalWorkspaceRecordMetadata({ ...validMetadata, plaintextSha256: 'not-a-hash' }, 'workspace-1'),
    false
  );
  assert.equal(
    validateEncryptedOperationalWorkspaceRecordMetadata({ ...validMetadata, preparedAt: 'invalid-date' }, 'workspace-1'),
    false
  );

  const genericSecureStoreRead = await queryOperationalStorePaginated('secureWorkspace');
  assert.deepEqual(genericSecureStoreRead.items, []);
  assert.equal(genericSecureStoreRead.total, 0);

  const tampered = {
    ...envelope,
    ciphertextB64: envelope.ciphertextB64.slice(0, -4) + 'AAAA',
  };
  const rejected = await decryptAndVerifyBackupEnvelope(JSON.stringify(tampered), passphrase);
  assert.equal(rejected.ok, false);

  // Exercise the actual OP_DB v5 secureWorkspace write/read path, not only envelope helpers.
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { indexedDB } });
  const operationalSeed = {
    ...workspace,
    localRevision: 7,
    businessLocalState: undefined,
  };
  const saved = await saveOperationalWorkspaceTx(operationalSeed as never);
  assert.ok(saved, 'the operational workspace seed must commit to IndexedDB');
  const loadedSource = await loadOperationalWorkspace();
  assert.ok(loadedSource, 'the operational workspace must hydrate from IndexedDB');
  unlockBackupSession(passphrase);
  try {
    const writtenMeta = await writeEncryptedOperationalWorkspaceSnapshot(
      'workspace-1', loadedSource, saved!.localRevision
    );
    assert.equal(writtenMeta.sourceRevision, saved!.localRevision);
    assert.deepEqual(await getPreparedEncryptedOperationalWorkspaceMeta('workspace-1'), writtenMeta);
    const prepared = await loadPreparedEncryptedOperationalWorkspace('workspace-1');
    assert.ok(prepared, 'the prepared encrypted snapshot must decrypt and load');
    assert.deepEqual(prepared.accounts, loadedSource.accounts);
    assert.equal(prepared.localRevision, loadedSource.localRevision);

    lockBackupSession();
    unlockBackupSession('WrongPassphrase#1405');
    await assert.rejects(
      () => loadPreparedEncryptedOperationalWorkspace('workspace-1'),
      /رمز|decrypt|authentication|operation/i,
      'an incorrect session key must not load the encrypted snapshot'
    );
    unlockBackupSession(passphrase);

    const newerSave = await saveOperationalWorkspaceTx(loadedSource);
    assert.ok(newerSave);
    await assert.rejects(
      () => loadPreparedEncryptedOperationalWorkspace('workspace-1'),
      /قدیمی است|تطابق ندارد/,
      'a prepared snapshot must be rejected after the plaintext operational revision advances'
    );
    assert.equal((await getPreparedEncryptedOperationalWorkspaceMeta('workspace-1'))?.sourceRevision, saved!.localRevision);
  } finally {
    lockBackupSession();
  }

  console.log('Encrypted operational workspace migration: metadata validation covered');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
