import assert from 'node:assert/strict';
import {
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
} from '../src/lib/offlineFirstCore';
import {
  countOperationalWorkspaceRecords,
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
  assert.equal(countOperationalWorkspaceRecords(workspace), 1);
  assert.throws(
    () => countOperationalWorkspaceRecords({ ...workspace, accounts: null as unknown as typeof workspace.accounts }),
    /مجموعه رکوردهای فضای کاری/
  );

  assert.throws(
    () => parseOperationalWorkspaceSnapshot(JSON.stringify({ profile: {}, accounts: [] })),
    /ناقص یا ناسازگار/
  );
  assert.throws(
    () => parseOperationalWorkspaceSnapshot('{invalid json'),
    /JSON معتبر نیست/
  );

  const validMetadata = {
    workspaceId: 'workspace-1',
    envelopeJson: JSON.stringify(envelope),
    schemaVersion: 1,
    recordCount: 1,
    sourceRevision: 7,
    plaintextSha256: envelope.plaintextSha256,
    preparedAt: '2026-11-27T00:00:00.000Z',
    migrationState: 'prepared' as const,
  };
  assert.equal(validateEncryptedOperationalWorkspaceRecordMetadata(validMetadata, 'workspace-1'), true);
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

  console.log('Encrypted operational workspace migration: metadata validation covered');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
