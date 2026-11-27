import assert from 'node:assert/strict';
import {
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
} from '../src/lib/offlineFirstCore';
import { parseOperationalWorkspaceSnapshot, queryOperationalStorePaginated } from '../src/lib/operationalDb';

async function run() {
  const workspace = {
    profile: { uid: 'workspace-1', companyName: 'Migration Test', fiscalYear: '1405' },
    accounts: [{ id: 'a1', accountCode: '101', title: 'Cash' }],
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

  assert.throws(
    () => parseOperationalWorkspaceSnapshot(JSON.stringify({ profile: {}, accounts: [] })),
    /ناقص یا ناسازگار/
  );
  assert.throws(
    () => parseOperationalWorkspaceSnapshot('{invalid json'),
    /JSON معتبر نیست/
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

  console.log('Encrypted operational workspace migration: 9 assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
